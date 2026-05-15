from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

LOG = logging.getLogger(__name__)

_POST_EVENT_SECONDS  = 30
_MAX_SEGMENT_SECONDS = 600
_SPRITE_FPS          = "1/5"
_SPRITE_W            = 160
_SPRITE_COLS         = 10
_SPRITE_ROWS         = 6
_EVENT_GAP_SECONDS   = 2.0    # detections within this gap = same event
_CLASS_PRIORITY      = ["person", "bird", "cat", "dog",
                         "bus", "truck", "motorcycle", "bicycle", "car",
                         "backpack", "suitcase"]

_DDL = """
CREATE TABLE IF NOT EXISTS segments (
    id          INTEGER PRIMARY KEY,
    source_id   TEXT    NOT NULL,
    path        TEXT    NOT NULL UNIQUE,
    start_ts    REAL    NOT NULL,
    end_ts      REAL,
    spritesheet TEXT,
    webvtt      TEXT
);
CREATE INDEX IF NOT EXISTS seg_source_ts ON segments(source_id, start_ts);

CREATE TABLE IF NOT EXISTS video_detections (
    id          INTEGER PRIMARY KEY,
    segment_id  INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    ts_offset   REAL    NOT NULL,
    has_human   INTEGER NOT NULL DEFAULT 0,
    confidence  REAL    NOT NULL DEFAULT 0,
    boxes_json  TEXT,
    classes_json TEXT
);
CREATE INDEX IF NOT EXISTS vdet_seg ON video_detections(segment_id, ts_offset);

CREATE TABLE IF NOT EXISTS video_events (
    id          INTEGER PRIMARY KEY,
    segment_id  INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    source_id   TEXT    NOT NULL,
    abs_ts      REAL    NOT NULL,
    class       TEXT    NOT NULL,
    start_off   REAL    NOT NULL,
    end_off     REAL    NOT NULL,
    confidence  REAL    NOT NULL DEFAULT 0,
    boxes_json  TEXT
);
CREATE INDEX IF NOT EXISTS vevt_source_ts ON video_events(source_id, abs_ts);
CREATE INDEX IF NOT EXISTS vevt_class     ON video_events(class, abs_ts);
"""

_MOBILE_CLASSES     = {"person", "bicycle", "motorcycle", "truck", "bus",
                        "bird", "cat", "dog"}
_STATIONARY_CLASSES = {"car", "backpack", "suitcase"}


def _dominant_class(classes: list[str]) -> str:
    for c in _CLASS_PRIORITY:
        if c in classes:
            return c
    return classes[0] if classes else "unknown"


def _is_new_activity(boxes: list | None, prev_counts: dict) -> tuple[bool, dict]:
    counts: dict[str, int] = {}
    for b in (boxes or []):
        counts[b["cls"]] = counts.get(b["cls"], 0) + 1
    if any(cls in _MOBILE_CLASSES for cls in counts):
        return True, counts
    for cls in _STATIONARY_CLASSES:
        if counts.get(cls, 0) != prev_counts.get(cls, 0):
            return True, counts
    return False, counts


class VideoSegmentDB:
    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_DDL)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def open_segment(self, source_id: str, path: str, start_ts: float) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO segments(source_id, path, start_ts) VALUES(?,?,?)",
                (source_id, path, start_ts),
            )
            if cur.lastrowid:
                return cur.lastrowid
            return conn.execute(
                "SELECT id FROM segments WHERE path=?", (path,)
            ).fetchone()["id"]

    def close_segment(self, segment_id: int, end_ts: float,
                      spritesheet: str | None, webvtt: str | None) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE segments SET end_ts=?, spritesheet=?, webvtt=? WHERE id=?",
                (end_ts, spritesheet, webvtt, segment_id),
            )

    def add_detection(self, segment_id: int, ts_offset: float,
                      has_human: bool, confidence: float,
                      boxes: list | None, classes: list | None) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO video_detections"
                "(segment_id, ts_offset, has_human, confidence, boxes_json, classes_json)"
                " VALUES(?,?,?,?,?,?)",
                (segment_id, ts_offset, int(has_human), confidence,
                 json.dumps(boxes) if boxes else None,
                 json.dumps(classes) if classes else None),
            )

    def get_segment(self, segment_id: int) -> dict | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM segments WHERE id=?", (segment_id,)
            ).fetchone()
        return dict(row) if row else None

    def detections_for_segment(self, segment_id: int) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT ts_offset, has_human, confidence, boxes_json, classes_json"
                " FROM video_detections WHERE segment_id=? ORDER BY ts_offset",
                (segment_id,),
            ).fetchall()
        return [{
            "ts_offset":  r["ts_offset"],
            "has_human":  bool(r["has_human"]),
            "confidence": r["confidence"],
            "boxes":   json.loads(r["boxes_json"])   if r["boxes_json"]   else [],
            "classes": json.loads(r["classes_json"]) if r["classes_json"] else [],
        } for r in rows]

    def insert_events(self, events: list[dict]) -> None:
        with self._connect() as conn:
            conn.executemany(
                "INSERT INTO video_events"
                "(segment_id, source_id, abs_ts, class, start_off, end_off, confidence, boxes_json)"
                " VALUES(:segment_id,:source_id,:abs_ts,:class,:start_off,:end_off,:confidence,:boxes_json)",
                events,
            )

    def list_events(self, source_id: str | None = None, cls: str | None = None,
                    date: str | None = None, limit: int = 100) -> list[dict]:
        where, params = ["1"], []
        if source_id and source_id != "all":
            where.append("e.source_id=?"); params.append(source_id)
        if cls and cls != "all":
            where.append("e.class=?"); params.append(cls)
        if date:
            # date is YYYY-MM-DD local; filter by Unix day boundary approximately
            import calendar
            from datetime import date as ddate
            d = ddate.fromisoformat(date)
            # rough UTC bounds (±1 day for timezone safety, client filters)
            lo = calendar.timegm(d.timetuple()) - 86400
            hi = lo + 3 * 86400
            where.append("e.abs_ts BETWEEN ? AND ?")
            params += [lo, hi]
        sql = (
            "SELECT e.*, s.path as seg_path, s.spritesheet, s.start_ts as seg_start_ts"
            " FROM video_events e JOIN segments s ON s.id=e.segment_id"
            f" WHERE {' AND '.join(where)}"
            " ORDER BY e.abs_ts DESC LIMIT ?"
        )
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def class_counts(self, source_id: str | None = None) -> dict[str, int]:
        with self._connect() as conn:
            if source_id and source_id != "all":
                rows = conn.execute(
                    "SELECT class, COUNT(*) as n FROM video_events WHERE source_id=? GROUP BY class",
                    (source_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT class, COUNT(*) as n FROM video_events GROUP BY class"
                ).fetchall()
        return {r["class"]: r["n"] for r in rows}

    def list_segments(self, source_id: str | None = None) -> list[dict]:
        where, params = [], []
        if source_id and source_id != "all":
            where.append("source_id=?"); params.append(source_id)
        sql = "SELECT * FROM segments"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY start_ts DESC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def backfill_events(db: VideoSegmentDB) -> None:
    """Extract events for any closed segment that has none yet."""
    with db._connect() as conn:
        segs = conn.execute(
            "SELECT s.* FROM segments s"
            " WHERE s.end_ts IS NOT NULL"
            " AND NOT EXISTS (SELECT 1 FROM video_events WHERE segment_id=s.id)"
        ).fetchall()
    for row in segs:
        seg = dict(row)
        dets = db.detections_for_segment(seg["id"])
        n = extract_events(seg, dets, db)
        if n:
            LOG.info("backfilled %d events for segment %s", n, seg["path"][-30:])


def extract_events(segment: dict, detections: list[dict], db: VideoSegmentDB) -> int:
    """Group detections into events and store them."""
    if not detections:
        return 0

    seg_start = segment["start_ts"]
    events: list[dict] = []
    current: dict | None = None

    for det in detections:
        classes = det.get("classes") or []
        if not classes:
            continue
        dom = _dominant_class(classes)
        off = det["ts_offset"]

        if current is None:
            current = {"cls": dom, "start": off, "end": off,
                       "conf": det["confidence"], "boxes": det.get("boxes")}
        elif dom == current["cls"] and (off - current["end"]) <= _EVENT_GAP_SECONDS:
            current["end"] = off
            if det["confidence"] > current["conf"]:
                current["conf"] = det["confidence"]
                current["boxes"] = det.get("boxes")
        else:
            events.append(current)
            current = {"cls": dom, "start": off, "end": off,
                       "conf": det["confidence"], "boxes": det.get("boxes")}

    if current:
        events.append(current)

    rows = [{
        "segment_id": segment["id"],
        "source_id":  segment["source_id"],
        "abs_ts":     seg_start + e["start"],
        "class":      e["cls"],
        "start_off":  e["start"],
        "end_off":    e["end"],
        "confidence": e["conf"],
        "boxes_json": json.dumps(e["boxes"]) if e["boxes"] else None,
    } for e in events]

    if rows:
        db.insert_events(rows)
    return len(rows)


class VideoWorker:
    def __init__(self, source, video_dir: Path, db: VideoSegmentDB) -> None:
        self.source     = source
        self.video_dir  = video_dir
        self.db         = db
        self._lock      = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._seg_id:    int | None  = None
        self._seg_path:  Path | None = None
        self._seg_start: float       = 0.0
        self._last_det:  float       = 0.0
        self._recording: bool        = False
        self._prev_counts: dict      = {}

    def on_detection(self, ts: float, has_human: bool, confidence: float,
                     boxes: list | None, classes: list | None) -> None:
        triggered, new_counts = _is_new_activity(boxes, self._prev_counts)
        self._prev_counts = new_counts
        with self._lock:
            if self._recording and (ts - self._seg_start) >= _MAX_SEGMENT_SECONDS:
                self._stop_segment(ts)
                if triggered:
                    self._last_det = ts
                    self._start_segment(ts)
            elif triggered:
                self._last_det = ts
                if not self._recording:
                    self._start_segment(ts)
            elif self._recording:
                if ts - self._last_det >= _POST_EVENT_SECONDS:
                    self._stop_segment(ts)

            if self._recording and self._seg_id is not None:
                offset = max(0.0, ts - self._seg_start)
                try:
                    self.db.add_detection(
                        self._seg_id, offset, has_human, confidence, boxes, classes
                    )
                except Exception:
                    pass

    def stop(self) -> None:
        with self._lock:
            if self._recording:
                self._stop_segment(time.time())

    def _start_segment(self, ts: float) -> None:
        from .capture import resolve_rtsp_url
        url = resolve_rtsp_url(self.source)
        if not url:
            return
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        date_dir = self.video_dir / self.source.id / dt.strftime("%Y/%m/%d")
        date_dir.mkdir(parents=True, exist_ok=True)
        seg_path = date_dir / dt.strftime("%Y-%m-%d_%H-%M-%S.mp4")
        rel_path = seg_path.relative_to(self.video_dir).as_posix()
        try:
            proc = subprocess.Popen(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "warning",
                 "-use_wallclock_as_timestamps", "1",
                 "-rtsp_transport", self.source.rtsp_transport,
                 "-i", url,
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "64k",
                 "-movflags", "+faststart", str(seg_path)],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
        except Exception:
            LOG.exception("failed to start video segment for %s", self.source.id)
            return
        self._proc      = proc
        self._seg_path  = seg_path
        self._seg_start = ts
        try:
            self._seg_id = self.db.open_segment(self.source.id, rel_path, ts)
        except Exception:
            LOG.exception("failed to register segment in DB for %s", self.source.id)
            self._seg_id = None
        self._recording = True
        LOG.info("video event recording started: %s", rel_path)

    def _stop_segment(self, ts: float) -> None:
        proc = self._proc; seg_path = self._seg_path; seg_id = self._seg_id
        self._recording = False; self._proc = None
        self._seg_id = None; self._seg_path = None
        if proc and proc.poll() is None:
            try: proc.send_signal(signal.SIGTERM); proc.wait(timeout=10)
            except Exception: proc.kill()
        LOG.info("video event recording stopped (%.0fs)", ts - self._seg_start)
        if seg_id and seg_path and seg_path.exists() and seg_path.stat().st_size > 0:
            self.db.close_segment(seg_id, ts, None, None)
            threading.Thread(target=self._post_process,
                             args=(seg_path, seg_id), daemon=True).start()
        elif seg_id:
            self.db.close_segment(seg_id, ts, None, None)

    def _post_process(self, seg_path: Path, seg_id: int) -> None:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return
        try:
            sprite_dir  = seg_path.with_suffix("")
            sprite_dir.mkdir(parents=True, exist_ok=True)
            sprite_path = sprite_dir / "sprite.jpg"
            vtt_path    = sprite_dir / "thumbs.vtt"
            r = subprocess.run(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                 "-i", str(seg_path),
                 "-vf", f"fps={_SPRITE_FPS},scale={_SPRITE_W}:-1,"
                        f"tile={_SPRITE_COLS}x{_SPRITE_ROWS}",
                 "-q:v", "5", "-frames:v", "1", str(sprite_path)],
                capture_output=True, timeout=60, check=False,
            )
            sprite_rel = vtt_rel = None
            if r.returncode == 0 and sprite_path.exists():
                h = int(_SPRITE_W * 9 / 16)
                _write_webvtt(vtt_path, sprite_path.name, _SPRITE_W, h,
                              _SPRITE_COLS, _SPRITE_FPS)
                sprite_rel = str(sprite_path.relative_to(self.video_dir))
                vtt_rel    = str(vtt_path.relative_to(self.video_dir))

            seg = self.db.get_segment(seg_id)
            self.db.close_segment(seg_id, time.time(), sprite_rel, vtt_rel)

            # Extract events from detections
            if seg:
                dets = self.db.detections_for_segment(seg_id)
                n = extract_events(seg, dets, self.db)
                LOG.info("video post-processed: %s (%d events)", seg_path.name, n)
        except Exception:
            LOG.exception("video post-process failed for %s", seg_path.name)
            self.db.close_segment(seg_id, time.time(), None, None)


def _write_webvtt(path: Path, sprite_name: str, w: int, h: int,
                  cols: int, fps_str: str) -> None:
    num, den = (int(x) for x in fps_str.split("/"))
    interval = den / num
    lines = ["WEBVTT", ""]
    for tile in range(cols * 6):
        col, row = tile % cols, tile // cols
        t = tile * interval
        lines += [f"{_vtt_time(t)} --> {_vtt_time(t+interval)}",
                  f"{sprite_name}#xywh={col*w},{row*h},{w},{h}", ""]
    path.write_text("\n".join(lines))


def _vtt_time(s: float) -> str:
    h = int(s // 3600); m = int((s % 3600) // 60); s = s % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"
