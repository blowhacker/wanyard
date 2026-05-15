from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from pathlib import Path

LOG = logging.getLogger(__name__)

_SEGMENT_SECONDS = 300  # 5-minute segments
_SPRITE_FPS      = "1/5"   # 1 frame every 5s → 60 frames per segment
_SPRITE_W        = 160
_SPRITE_COLS     = 10
_SPRITE_ROWS     = 6       # 10×6 = 60 tiles

_DDL = """
CREATE TABLE IF NOT EXISTS segments (
    id              INTEGER PRIMARY KEY,
    source_id       TEXT    NOT NULL,
    path            TEXT    NOT NULL UNIQUE,
    start_ts        REAL    NOT NULL,
    end_ts          REAL,
    spritesheet     TEXT,
    webvtt          TEXT
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
"""


class VideoSegmentDB:
    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_DDL)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._path))
        conn.row_factory = sqlite3.Row
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

    def current_segment_id(self, source_id: str) -> int | None:
        now = time.time()
        with self._connect() as conn:
            row = conn.execute(
                "SELECT id FROM segments WHERE source_id=? AND start_ts<=? AND end_ts IS NULL"
                " ORDER BY start_ts DESC LIMIT 1",
                (source_id, now),
            ).fetchone()
        return row["id"] if row else None

    def list_segments(self, source_id: str | None = None,
                      date: str | None = None) -> list[dict]:
        from datetime import datetime, timezone
        where, params = [], []
        if source_id:
            where.append("source_id=?"); params.append(source_id)
        if date:
            # date is YYYY-MM-DD; filter by UTC day approximation
            # We'll return and let caller filter by local date
            pass
        sql = "SELECT * FROM segments"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY start_ts DESC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def detections_for_segment(self, segment_id: int) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT ts_offset, has_human, confidence, boxes_json, classes_json"
                " FROM video_detections WHERE segment_id=? ORDER BY ts_offset",
                (segment_id,),
            ).fetchall()
        result = []
        for r in rows:
            result.append({
                "ts_offset":  r["ts_offset"],
                "has_human":  bool(r["has_human"]),
                "confidence": r["confidence"],
                "boxes":   json.loads(r["boxes_json"])   if r["boxes_json"]   else [],
                "classes": json.loads(r["classes_json"]) if r["classes_json"] else [],
            })
        return result


class VideoWorker:
    def __init__(self, source, video_dir: Path, db: VideoSegmentDB) -> None:
        self.source    = source
        self.video_dir = video_dir
        self.db        = db
        self._stop     = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name=f"video-{self.source.id}", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=15)

    def _run(self) -> None:
        from .capture import resolve_rtsp_url
        url = resolve_rtsp_url(self.source)
        if not url:
            LOG.error("no URL for video source %s", self.source.id)
            return

        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            LOG.error("ffmpeg not found for video recording")
            return

        while not self._stop.is_set():
            try:
                self._record_segment(ffmpeg, url)
            except Exception:
                LOG.exception("video segment failed for %s", self.source.id)
                self._stop.wait(5.0)

    def _record_segment(self, ffmpeg: str, url: str) -> None:
        from datetime import datetime, timezone
        now   = time.time()
        dt    = datetime.fromtimestamp(now, tz=timezone.utc)
        date_dir = self.video_dir / self.source.id / dt.strftime("%Y/%m/%d")
        date_dir.mkdir(parents=True, exist_ok=True)

        seg_name = dt.strftime("%Y-%m-%d_%H-%M-%S.mp4")
        seg_path = date_dir / seg_name
        rel_path = seg_path.relative_to(self.video_dir).as_posix()

        seg_id = self.db.open_segment(self.source.id, rel_path, now)
        LOG.info("video segment started: %s", rel_path)

        r = subprocess.run(
            [
                ffmpeg, "-y", "-hide_banner", "-loglevel", "warning",
                "-use_wallclock_as_timestamps", "1",
                "-rtsp_transport", self.source.rtsp_transport,
                "-i", url,
                "-t", str(_SEGMENT_SECONDS),
                "-c", "copy",
                "-movflags", "+faststart",
                str(seg_path),
            ],
            capture_output=True, timeout=_SEGMENT_SECONDS + 30, check=False,
        )

        end_ts = time.time()
        if r.returncode != 0 or not seg_path.exists() or seg_path.stat().st_size == 0:
            err = r.stderr.decode("utf-8", errors="replace")
            LOG.warning("segment failed for %s (rc=%d): %s",
                        self.source.id, r.returncode, err[-400:])
            self.db.close_segment(seg_id, end_ts, None, None)
            return

        # Generate spritesheet + WebVTT asynchronously
        t = threading.Thread(
            target=self._post_process,
            args=(ffmpeg, seg_path, seg_id, now, end_ts),
            daemon=True,
        )
        t.start()

    def _post_process(self, ffmpeg: str, seg_path: Path,
                      seg_id: int, start_ts: float, end_ts: float) -> None:
        try:
            sprite_path = seg_path.with_suffix("") / "sprite.jpg"
            vtt_path    = seg_path.with_suffix("") / "thumbs.vtt"
            sprite_path.parent.mkdir(parents=True, exist_ok=True)

            # Sprite sheet
            r = subprocess.run(
                [
                    ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                    "-i", str(seg_path),
                    "-vf", f"fps={_SPRITE_FPS},scale={_SPRITE_W}:-1,"
                           f"tile={_SPRITE_COLS}x{_SPRITE_ROWS}",
                    "-q:v", "5", "-frames:v", "1",
                    str(sprite_path),
                ],
                capture_output=True, timeout=60, check=False,
            )
            if r.returncode != 0 or not sprite_path.exists():
                sprite_path = None
                vtt_path    = None
            else:
                _write_webvtt(vtt_path, sprite_path.name,
                              _SPRITE_W, int(_SPRITE_W * 9 / 16),
                              _SPRITE_COLS, _SPRITE_FPS)

            sprite_rel = str(sprite_path.relative_to(self.video_dir)) if sprite_path else None
            vtt_rel    = str(vtt_path.relative_to(self.video_dir))    if vtt_path    else None
            self.db.close_segment(seg_id, end_ts, sprite_rel, vtt_rel)
            LOG.info("segment post-processed: %s", seg_path.name)
        except Exception:
            LOG.exception("post-process failed for segment %d", seg_id)
            self.db.close_segment(seg_id, end_ts, None, None)

    def add_detection(self, ts: float, has_human: bool, confidence: float,
                      boxes: list | None, classes: list | None) -> None:
        seg_id = self.db.current_segment_id(self.source.id)
        if seg_id is None:
            return
        seg = self.db.list_segments(self.source.id)
        if not seg:
            return
        current = next((s for s in seg if s["id"] == seg_id), None)
        if not current:
            return
        ts_offset = max(0.0, ts - current["start_ts"])
        self.db.add_detection(seg_id, ts_offset, has_human, confidence, boxes, classes)


def _write_webvtt(path: Path, sprite_name: str, w: int, h: int,
                  cols: int, fps_str: str) -> None:
    interval = eval(fps_str.replace("/", "/"))  # e.g. 1/5 → 0.2
    lines = ["WEBVTT", ""]
    tile = 0
    t = 0.0
    while True:
        col = tile % cols
        row = tile // cols
        x, y = col * w, row * h
        t_end = t + interval
        lines.append(f"{_vtt_time(t)} --> {_vtt_time(t_end)}")
        lines.append(f"{sprite_name}#xywh={x},{y},{w},{h}")
        lines.append("")
        tile += 1
        t = t_end
        if tile >= cols * 6:  # _SPRITE_ROWS
            break
    path.write_text("\n".join(lines))


def _vtt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"
