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

_MAX_SEGMENT_SECONDS = 600
_LIVE_HLS_SEGMENT_SECONDS = 2
_LIVE_HLS_LIST_SIZE = _MAX_SEGMENT_SECONDS // _LIVE_HLS_SEGMENT_SECONDS
_LIVE_HLS_UNREFERENCED_RETENTION_SECONDS = (
    _LIVE_HLS_SEGMENT_SECONDS * (_LIVE_HLS_LIST_SIZE + 30)
)
_LIVE_HLS_STALE_PLAYLIST_SECONDS = _LIVE_HLS_UNREFERENCED_RETENTION_SECONDS
_SPRITE_FPS          = "1/5"
_SPRITE_W            = 160
_SPRITE_COLS         = 10
_SPRITE_ROWS         = 6
_EVENT_GAP_SECONDS   = 2.0    # detections within this gap = same event
_PROVISIONAL_GRACE_SECONDS = 3600.0
_CLASS_PRIORITY      = ["person", "bird", "cat", "dog",
                         "bus", "truck", "motorcycle", "bicycle", "car",
                         "backpack", "suitcase"]

_DDL = """
CREATE TABLE IF NOT EXISTS segments (
    id              INTEGER PRIMARY KEY,
    source_id       TEXT    NOT NULL,
    path            TEXT    NOT NULL UNIQUE,
    start_ts        REAL    NOT NULL,
    end_ts          REAL,
    actual_start_ts REAL,        -- camera-accurate first-frame time (from HLS)
    spritesheet     TEXT,
    webvtt          TEXT
);
CREATE INDEX IF NOT EXISTS seg_source_ts ON segments(source_id, start_ts);
CREATE INDEX IF NOT EXISTS seg_source_end_ts ON segments(source_id, end_ts, start_ts);

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
CREATE INDEX IF NOT EXISTS vevt_source_class_ts ON video_events(source_id, class, abs_ts);
CREATE INDEX IF NOT EXISTS vevt_ts        ON video_events(abs_ts);
CREATE INDEX IF NOT EXISTS vevt_seg       ON video_events(segment_id, class);

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Real-time detections from HLS .ts segments, pending MP4 backfill.
-- Rows here make events appear in the UI within seconds of detection.
-- Consumed and deleted by _backfill_loop when the MP4 segment closes.
CREATE TABLE IF NOT EXISTS hls_events (
    id          INTEGER PRIMARY KEY,
    source_id   TEXT    NOT NULL,
    abs_ts      REAL    NOT NULL,
    class       TEXT    NOT NULL,
    confidence  REAL    NOT NULL DEFAULT 0,
    boxes_json  TEXT,
    thumb_jpeg  BLOB,
    created_at  REAL    NOT NULL DEFAULT (unixepoch('now'))
);
CREATE INDEX IF NOT EXISTS hevt_source_ts ON hls_events(source_id, abs_ts);
"""



def _dominant_class(classes: list[str]) -> str:
    for c in _CLASS_PRIORITY:
        if c in classes:
            return c
    return classes[0] if classes else "unknown"



class VideoSegmentDB:
    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_DDL)
            # Additive migrations — safe to re-run, fail silently if column exists
            for migration in [
                "ALTER TABLE hls_events ADD COLUMN thumb_jpeg BLOB",
                "ALTER TABLE segments  ADD COLUMN actual_start_ts REAL",
            ]:
                try:
                    conn.execute(migration)
                except Exception:
                    pass

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

    def replace_detections(self, segment_id: int, detections: list[dict]) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM video_detections WHERE segment_id=?", (segment_id,))
            conn.executemany(
                "INSERT INTO video_detections"
                "(segment_id, ts_offset, has_human, confidence, boxes_json, classes_json)"
                " VALUES(?,?,?,?,?,?)",
                [
                    (
                        segment_id,
                        d["ts_offset"],
                        int(d["has_human"]),
                        d["confidence"],
                        json.dumps(d["boxes"]) if d.get("boxes") else None,
                        json.dumps(d["classes"]) if d.get("classes") else None,
                    )
                    for d in detections
                ],
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
                    date: str | None = None, limit: int = 100,
                    since: float | None = None,
                    until: float | None = None) -> list[dict]:
        where, params = ["1"], []
        if source_id and source_id != "all":
            where.append("e.source_id=?"); params.append(source_id)
        if cls and cls != "all":
            where.append("e.class=?"); params.append(cls)
        if since is not None:
            where.append("e.abs_ts>=?"); params.append(since)
        if until is not None:
            where.append("e.abs_ts<=?"); params.append(until)
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

    def nearest_events(self, around: float, source_id: str | None = None,
                       classes: list[str] | None = None,
                       limit: int = 20) -> list[dict]:
        if classes and len(classes) > 1:
            rows: list[dict] = []
            for cls in classes:
                rows.extend(self.nearest_events(around, source_id, [cls], limit))
            by_id = {r["id"]: r for r in rows}
            rows = list(by_id.values())
            rows.sort(key=lambda r: (abs(r["abs_ts"] - around), r["abs_ts"]))
            return rows[:limit]

        where, params = ["1"], []
        if source_id and source_id != "all":
            where.append("e.source_id=?"); params.append(source_id)
        if classes:
            placeholders = ",".join("?" for _ in classes)
            where.append(f"e.class IN ({placeholders})")
            params.extend(classes)
        base = " AND ".join(where)
        select = (
            "SELECT e.*, s.path as seg_path, s.spritesheet,"
            " s.start_ts as seg_start_ts"
            " FROM video_events e JOIN segments s ON s.id=e.segment_id"
            f" WHERE {base}"
        )
        with self._connect() as conn:
            before = conn.execute(
                f"{select} AND e.abs_ts<=? ORDER BY e.abs_ts DESC LIMIT ?",
                (*params, around, limit),
            ).fetchall()
            after = conn.execute(
                f"{select} AND e.abs_ts>? ORDER BY e.abs_ts ASC LIMIT ?",
                (*params, around, limit),
            ).fetchall()
        rows = [dict(r) for r in before] + [dict(r) for r in after]
        rows.sort(key=lambda r: (abs(r["abs_ts"] - around), r["abs_ts"]))
        return rows[:limit]

    def get_event_with_segment(self, event_id: int) -> dict | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT e.*, s.path as seg_path, s.start_ts as seg_start_ts,"
                " s.end_ts as seg_end_ts"
                " FROM video_events e JOIN segments s ON s.id=e.segment_id"
                " WHERE e.id=?",
                (event_id,),
            ).fetchone()
        return dict(row) if row else None

    def get_setting(self, key: str, default=None):
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        if row is None:
            return default
        val = row[0]
        try:
            return float(val) if '.' in val else int(val)
        except (ValueError, TypeError):
            return val

    def set_setting(self, key: str, value) -> None:
        with self._connect() as conn:
            conn.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)",
                         (key, str(value)))

    def get_all_settings(self) -> dict:
        with self._connect() as conn:
            rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
        return {r[0]: r[1] for r in rows}

    def class_counts(self, source_id: str | None = None,
                     include_provisional: bool = True) -> dict[str, int]:
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
        counts = {r["class"]: r["n"] for r in rows}
        if include_provisional:
            for evt in self.provisional_events(source_id):
                counts[evt["class"]] = counts.get(evt["class"], 0) + 1
        return counts

    def activity_summary(self, source_id: str | None = None,
                         since: float | None = None,
                         until: float | None = None) -> dict:
        where, params = ["1"], []
        if source_id and source_id != "all":
            where.append("source_id=?"); params.append(source_id)
        if since is not None:
            where.append("abs_ts>=?"); params.append(since)
        if until is not None:
            where.append("abs_ts<?"); params.append(until)
        sql = (
            "SELECT class, COUNT(*) as n FROM video_events"
            f" WHERE {' AND '.join(where)}"
            " GROUP BY class"
        )
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        classes = {r["class"]: r["n"] for r in rows}
        for evt in self.provisional_events(source_id, since):
            if until is not None and evt["abs_ts"] >= until:
                continue
            classes[evt["class"]] = classes.get(evt["class"], 0) + 1
        return {"total": sum(classes.values()), "classes": classes}

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

    def segments_overlapping(self, source_id: str | None,
                             start_ts: float, end_ts: float) -> list[dict]:
        where, params = [
            "end_ts IS NOT NULL",
            "end_ts>?",
            "start_ts<?",
        ], [start_ts, end_ts]
        if source_id and source_id != "all":
            where.append("source_id=?"); params.append(source_id)
        sql = (
            "SELECT * FROM segments"
            f" WHERE {' AND '.join(where)}"
            " ORDER BY start_ts"
        )
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def provisional_events(self, source_id: str | None = None,
                           since: float | None = None) -> list[dict]:
        cutoff = time.time() - _PROVISIONAL_GRACE_SECONDS
        where, params = [
            "((s.end_ts IS NULL AND s.start_ts>=?)"
            " OR (s.end_ts IS NOT NULL AND s.end_ts>=?"
            " AND NOT EXISTS (SELECT 1 FROM video_events e WHERE e.segment_id=s.id)))"
        ], [cutoff, cutoff]
        if source_id and source_id != "all":
            where.append("s.source_id=?"); params.append(source_id)
        if since is not None:
            where.append("s.start_ts>=?"); params.append(since - _MAX_SEGMENT_SECONDS)
        sql = (
            "SELECT s.* FROM segments s"
            f" WHERE {' AND '.join(where)}"
            " ORDER BY s.start_ts DESC"
        )
        with self._connect() as conn:
            segs = [dict(r) for r in conn.execute(sql, params).fetchall()]

        events: list[dict] = []
        for seg in segs:
            rows = _events_from_detections(seg, self.detections_for_segment(seg["id"]))
            for row in rows:
                if since is not None and row["abs_ts"] < since:
                    continue
                row["id"] = f"p:{row['segment_id']}:{row['class']}:{row['start_off']:.1f}"
                row["provisional"] = True
                row["seg_path"] = seg["path"]
                row["spritesheet"] = seg.get("spritesheet")
                row["seg_start_ts"] = seg["start_ts"]
                events.append(row)
        # Merge real-time HLS events (tagged within seconds of capture)
        hls = self.get_hls_events(source_id=source_id, since=since)
        events.extend(hls)
        events.sort(key=lambda r: r["abs_ts"], reverse=True)
        return events

    # ── HLS real-time event store ──────────────────────────────────────────
    def insert_hls_events(self, events: list[dict]) -> None:
        """Store provisional events detected from live HLS .ts segments."""
        with self._connect() as conn:
            conn.executemany(
                "INSERT INTO hls_events(source_id, abs_ts, class, confidence, boxes_json, thumb_jpeg)"
                " VALUES(:source_id,:abs_ts,:class,:confidence,:boxes_json,:thumb_jpeg)",
                events,
            )

    def get_hls_thumb(self, hls_event_id: int) -> bytes | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT thumb_jpeg FROM hls_events WHERE id=?", (hls_event_id,)
            ).fetchone()
        return bytes(row["thumb_jpeg"]) if row and row["thumb_jpeg"] else None

    def get_hls_events(self, source_id: str | None = None,
                       since: float | None = None,
                       until: float | None = None) -> list[dict]:
        cutoff = time.time() - _PROVISIONAL_GRACE_SECONDS
        where, params = ["abs_ts>=?"], [cutoff]
        if source_id and source_id != "all":
            where.append("source_id=?"); params.append(source_id)
        if since is not None:
            where.append("abs_ts>=?"); params.append(since)
        if until is not None:
            where.append("abs_ts<=?"); params.append(until)
        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM hls_events WHERE {' AND '.join(where)}"
                " ORDER BY abs_ts DESC",
                params,
            ).fetchall()
        return [{
            "id":          f"h:{r['source_id']}:{r['abs_ts']:.2f}",
            "hls_id":      r["id"],
            "source_id":   r["source_id"],
            "abs_ts":      r["abs_ts"],
            "class":       r["class"],
            "confidence":  r["confidence"],
            "boxes_json":  r["boxes_json"],
            "provisional": True,
            "start_off":   0.0,
            "end_off":     _LIVE_HLS_SEGMENT_SECONDS,
            "segment_id":  None,
        } for r in rows]

    def delete_hls_events(self, source_id: str, since: float, until: float) -> int:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM hls_events WHERE source_id=? AND abs_ts>=? AND abs_ts<=?",
                (source_id, since, until),
            )
            return cur.rowcount

    def prune_hls_events(self, max_age_seconds: float = _PROVISIONAL_GRACE_SECONDS) -> None:
        cutoff = time.time() - max_age_seconds
        with self._connect() as conn:
            conn.execute("DELETE FROM hls_events WHERE abs_ts<?", (cutoff,))

    def observe_frame_time(self, source_id: str, abs_ts: float) -> None:
        """Update the open segment's actual_start_ts to MIN(existing, abs_ts).
        Called for each HLS .ts frame seen — earliest abs_ts ≈ MP4 first frame time.
        """
        with self._connect() as conn:
            conn.execute(
                "UPDATE segments"
                " SET actual_start_ts = MIN(COALESCE(actual_start_ts, ?), ?)"
                " WHERE source_id=? AND end_ts IS NULL"
                "   AND start_ts <= ? + 5 AND start_ts >= ? - 30",
                (abs_ts, abs_ts, source_id, abs_ts, abs_ts),
            )

    def live_status(self, source_id: str | None = None) -> dict:
        with self._connect() as conn:
            where, params = [
                "s.end_ts IS NULL",
                "s.start_ts>=?",
            ], [time.time() - _PROVISIONAL_GRACE_SECONDS]
            if source_id and source_id != "all":
                where.append("s.source_id=?"); params.append(source_id)
            segs = [dict(r) for r in conn.execute(
                "SELECT s.* FROM segments s"
                f" WHERE {' AND '.join(where)}"
                " ORDER BY s.start_ts DESC",
                params,
            ).fetchall()]
            latest_rows = conn.execute(
                "SELECT s.source_id, s.start_ts, d.*"
                " FROM segments s JOIN video_detections d ON d.segment_id=s.id"
                f" WHERE {' AND '.join(where)}"
                " ORDER BY (s.start_ts + d.ts_offset) DESC",
                params,
            ).fetchall()

        # Latest detection from video_detections (backfill, usually absent for live)
        latest: dict[str, dict] = {}
        for r in latest_rows:
            if r["source_id"] in latest:
                continue
            latest[r["source_id"]] = {
                "segment_id": r["segment_id"],
                "source_id": r["source_id"],
                "abs_ts": r["start_ts"] + r["ts_offset"],
                "ts_offset": r["ts_offset"],
                "has_human": bool(r["has_human"]),
                "confidence": r["confidence"],
                "boxes": json.loads(r["boxes_json"]) if r["boxes_json"] else [],
                "classes": json.loads(r["classes_json"]) if r["classes_json"] else [],
            }

        # Latest HLS real-time detections (primary source while MP4 is open)
        hls_cutoff = time.time() - 30  # only last 30s of HLS events are "live"
        with self._connect() as conn:
            hls_where = ["abs_ts >= ?"]
            hls_params: list = [hls_cutoff]
            if source_id and source_id != "all":
                hls_where.append("source_id=?"); hls_params.append(source_id)
            hls_rows = conn.execute(
                f"SELECT source_id, abs_ts, class, confidence, boxes_json"
                f" FROM hls_events WHERE {' AND '.join(hls_where)}"
                " ORDER BY abs_ts DESC",
                hls_params,
            ).fetchall()

        # Group by (source_id, abs_ts) — each frame is one detection with all
        # its boxes merged across class rows. Return ALL recent frames so the
        # client can pick the detection matching the displayed video time
        # (HLS player typically buffers 3-6s behind live edge).
        by_frame: dict[tuple, dict] = {}
        for r in hls_rows:
            key = (r["source_id"], round(r["abs_ts"], 2))
            if key not in by_frame:
                by_frame[key] = {
                    "source_id": r["source_id"],
                    "abs_ts": r["abs_ts"],
                    "has_human": False,
                    "confidence": 0.0,
                    "boxes": [],
                    "classes": [],
                }
            det = by_frame[key]
            boxes = json.loads(r["boxes_json"]) if r["boxes_json"] else []
            det["boxes"].extend(boxes)
            det["classes"].append(r["class"])
            det["confidence"] = max(det["confidence"], r["confidence"])
            if r["class"] == "person":
                det["has_human"] = True

        recent = sorted(by_frame.values(), key=lambda d: d["abs_ts"])

        # Latest-per-source for backward compatibility (used by client when no
        # HLS player timing is available)
        for det in recent:
            sid = det["source_id"]
            if sid not in latest or det["abs_ts"] > latest[sid]["abs_ts"]:
                latest[sid] = det

        return {
            "segments": segs,
            "recent_detections": recent,
            "events": self.provisional_events(source_id),
            "detections": list(latest.values()),
        }


_CONF_THRESHOLD = 0.35
_CCTV_CLASSES = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus",
    7: "truck", 14: "bird", 15: "cat", 16: "dog",
    24: "backpack", 28: "suitcase",
}
_CCTV_CLASS_IDS = list(_CCTV_CLASSES.keys())


def _parse_results(results) -> tuple:
    if not results or results[0].boxes is None or not len(results[0].boxes):
        return False, 0.0, []
    r = results[0]
    boxes = []
    for xyxyn, conf, cls_id in zip(
        r.boxes.xyxyn.tolist(), r.boxes.conf.tolist(), r.boxes.cls.tolist()
    ):
        x1, y1, x2, y2 = xyxyn
        cls = _CCTV_CLASSES.get(int(cls_id), str(int(cls_id)))
        boxes.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "conf": conf, "cls": cls})
    has_human = any(b["cls"] == "person" for b in boxes)
    top_conf  = max((b["conf"] for b in boxes if b["cls"] == "person"), default=0.0)
    return has_human, top_conf, boxes


def _yolo_tag_video(model, seg_path: Path, seg_id: int,
                    db: VideoSegmentDB) -> int:
    """Read video file at 1fps, run YOLO, store detections with exact timestamps."""
    import cv2

    cap = cv2.VideoCapture(str(seg_path))
    if not cap.isOpened():
        return 0

    fps        = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step       = max(1, int(round(fps)))  # read every Nth frame = 1fps
    frame_num  = 0
    detections: list[dict] = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_num % step == 0:
            ts_ms  = cap.get(cv2.CAP_PROP_POS_MSEC)
            ts_off = ts_ms / 1000.0
            try:
                results = model.predict(frame, classes=_CCTV_CLASS_IDS,
                                        conf=_CONF_THRESHOLD, verbose=False)
                has_human, conf, boxes = _parse_results(results)
                classes = list({b["cls"] for b in boxes}) if boxes else []
                detections.append({
                    "ts_offset": ts_off,
                    "has_human": has_human,
                    "confidence": conf,
                    "boxes": boxes,
                    "classes": classes,
                })
            except Exception:
                LOG.exception("yolo tag failed at %.1fs in %s", ts_off, seg_path.name)
        frame_num += 1

    cap.release()
    db.replace_detections(seg_id, detections)
    return len(detections)


def backfill_events(db: VideoSegmentDB, video_dir: Path | None = None,
                    model=None) -> None:
    """YOLO-tag and extract events for closed segments missing detections."""
    with db._connect() as conn:
        segs = conn.execute(
            "SELECT s.* FROM segments s WHERE s.end_ts IS NOT NULL"
            " AND NOT EXISTS (SELECT 1 FROM video_detections WHERE segment_id=s.id)"
        ).fetchall()
    for row in segs:
        seg = dict(row)
        seg_path = (video_dir / seg["path"]) if video_dir else None
        if model and seg_path and seg_path.exists():
            n_det = _yolo_tag_video(model, seg_path, seg["id"], db)
            LOG.info("backfill tagged %d frames in %s", n_det, seg["path"][-30:])
        # Extract events from detections (new or old)
        dets = db.detections_for_segment(seg["id"])
        n = extract_events(seg, dets, db)
        if n:
            LOG.info("backfill extracted %d events from %s", n, seg["path"][-30:])


def extract_events(segment: dict, detections: list[dict], db: VideoSegmentDB) -> int:
    """Group detections into events and store them."""
    rows = _events_from_detections(segment, detections)
    if rows:
        db.insert_events(rows)
    return len(rows)


def _events_from_detections(segment: dict, detections: list[dict]) -> list[dict]:
    if not detections:
        return []

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

    return [{
        "segment_id": segment["id"],
        "source_id":  segment["source_id"],
        "abs_ts":     seg_start + e["start"],
        "class":      e["cls"],
        "start_off":  e["start"],
        "end_off":    e["end"],
        "confidence": e["conf"],
        "boxes_json": json.dumps(e["boxes"]) if e["boxes"] else None,
    } for e in events]


class VideoWorker:
    """Continuous RTSP recorder — no detection trigger, pure archive + live HLS."""

    def __init__(self, source, video_dir: Path, db: VideoSegmentDB) -> None:
        self.source    = source
        self.video_dir = video_dir
        self.db        = db
        self._stop     = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._seg_id:    int | None  = None
        self._seg_path:  Path | None = None
        self._seg_start: float       = 0.0
        self._live_dir  = video_dir / "live" / source.id
        self._live_dir.mkdir(parents=True, exist_ok=True)

    def _live_playlist_segments(self) -> set[str]:
        playlist = self._live_dir / "live.m3u8"
        try:
            stat = playlist.stat()
            if time.time() - stat.st_mtime > _LIVE_HLS_STALE_PLAYLIST_SECONDS:
                try:
                    playlist.unlink()
                except OSError:
                    pass
                return set()
            lines = playlist.read_text(encoding="utf-8").splitlines()
        except OSError:
            return set()

        segments: set[str] = set()
        for line in lines:
            item = line.strip()
            if not item or item.startswith("#"):
                continue
            segments.add(Path(item.split("?", 1)[0]).name)
        return segments

    def _prune_live_dir(self) -> None:
        referenced = self._live_playlist_segments()
        cutoff = time.time() - _LIVE_HLS_UNREFERENCED_RETENTION_SECONDS
        for pattern in ("*.ts", "*.tmp"):
            for path in self._live_dir.glob(pattern):
                try:
                    if path.name in referenced:
                        continue
                    if path.stat().st_mtime < cutoff:
                        path.unlink()
                except OSError:
                    pass

    def run(self) -> None:
        """Continuous recording loop — call from a daemon thread."""
        LOG.info("continuous recording started: %s", self.source.id)
        backoff = 5.0
        while not self._stop.is_set():
            try:
                ts = time.time()
                self._start_segment(ts)
                if self._proc:
                    # Poll every 5s so we detect ffmpeg exit within 5 seconds
                    deadline = time.time() + _MAX_SEGMENT_SECONDS
                    while time.time() < deadline and not self._stop.is_set():
                        if self._proc.poll() is not None:
                            LOG.warning("ffmpeg exited early for %s", self.source.id)
                            break
                        self._stop.wait(5)
                    elapsed = time.time() - ts
                    self._stop_segment(time.time())
                    # Reset backoff on successful segment (ran > 30s)
                    backoff = 5.0 if elapsed > 30 else min(backoff * 2, 300)
                    if elapsed <= 30:
                        LOG.warning("short segment (%.0fs) for %s — backoff %.0fs",
                                    elapsed, self.source.id, backoff)
                        self._stop.wait(backoff)
                else:
                    LOG.warning("ffmpeg failed to start for %s — backoff %.0fs",
                                self.source.id, backoff)
                    self._stop.wait(backoff)
                    backoff = min(backoff * 2, 300)
            except Exception:
                LOG.exception("recording error for %s — retry in 30s", self.source.id)
                self._stop.wait(30)
        LOG.info("continuous recording stopped: %s", self.source.id)

    def stop(self) -> None:
        self._stop.set()
        if self._seg_id or self._proc:
            self._stop_segment(time.time())

    def _start_segment(self, ts: float) -> None:
        from .capture import resolve_rtsp_url
        url    = resolve_rtsp_url(self.source)
        ffmpeg = shutil.which("ffmpeg")
        if not url or not ffmpeg:
            return
        dt       = datetime.fromtimestamp(ts, tz=timezone.utc)
        date_dir = self.video_dir / self.source.id / dt.strftime("%Y/%m/%d")
        date_dir.mkdir(parents=True, exist_ok=True)
        self._prune_live_dir()
        seg_path = date_dir / dt.strftime("%Y-%m-%d_%H-%M-%S.mp4")
        rel_path = seg_path.relative_to(self.video_dir).as_posix()
        try:
            self._proc = subprocess.Popen(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "warning",
                 "-use_wallclock_as_timestamps", "1",
                 "-rtsp_transport", self.source.rtsp_transport,
                 "-i", url,
                 # Archive: MP4 with faststart
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "64k",
                 "-movflags", "+faststart", str(seg_path),
                 # Live: rolling HLS. ffmpeg deletes the active window; startup
                 # pruning clears unreferenced files from older ffmpeg writers.
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "64k",
                 "-f", "hls",
                 "-hls_time", str(_LIVE_HLS_SEGMENT_SECONDS),
                 "-hls_list_size", str(_LIVE_HLS_LIST_SIZE),
                 "-hls_start_number_source", "epoch",
                 "-hls_flags", "delete_segments+omit_endlist+temp_file+program_date_time",
                 "-hls_segment_filename", str(self._live_dir / "seg_%010d.ts"),
                 str(self._live_dir / "live.m3u8"),
                ],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
        except Exception:
            LOG.exception("failed to start ffmpeg for %s", self.source.id)
            self._proc = None
            return
        self._seg_path  = seg_path
        self._seg_start = ts
        try:
            self._seg_id = self.db.open_segment(self.source.id, rel_path, ts)
        except Exception:
            self._seg_id = None
        LOG.info("segment started: %s", rel_path)

    def _stop_segment(self, ts: float) -> None:
        proc      = self._proc;     self._proc     = None
        seg_path  = self._seg_path; self._seg_path = None
        seg_id    = self._seg_id;   self._seg_id   = None
        if proc and proc.poll() is None:
            try:
                proc.send_signal(signal.SIGTERM); proc.wait(timeout=10)
            except Exception:
                proc.kill()
        if seg_id:
            self.db.close_segment(seg_id, ts, None, None)


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
