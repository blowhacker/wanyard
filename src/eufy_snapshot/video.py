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
from collections import deque
from dataclasses import dataclass, field
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
_PROVISIONAL_GRACE_SECONDS = 3600.0
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
"""

_MOBILE_CLASSES     = {"person", "bicycle", "motorcycle", "bird", "cat", "dog"}
_STATIONARY_CLASSES = {"car", "truck", "bus", "backpack", "suitcase"}


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

    def replace_events(self, segment_id: int, events: list[dict]) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM video_events WHERE segment_id=?", (segment_id,))
            if events:
                conn.executemany(
                    "INSERT INTO video_events"
                    "(segment_id, source_id, abs_ts, class, start_off, end_off, confidence, boxes_json)"
                    " VALUES(:segment_id,:source_id,:abs_ts,:class,:start_off,:end_off,:confidence,:boxes_json)",
                    events,
                )

    def list_events(self, source_id: str | None = None, cls: str | None = None,
                    date: str | None = None, limit: int = 100,
                    since: float | None = None) -> list[dict]:
        where, params = ["1"], []
        if source_id and source_id != "all":
            where.append("e.source_id=?"); params.append(source_id)
        if cls and cls != "all":
            where.append("e.class=?"); params.append(cls)
        if since is not None:
            where.append("e.abs_ts>=?"); params.append(since)
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
        events.sort(key=lambda r: r["abs_ts"], reverse=True)
        return events

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
        return {
            "segments": segs,
            "events": self.provisional_events(source_id),
            "detections": list(latest.values()),
        }


# ── Per-frame box tracker / class smoother ────────────────────────────────────
_TRACK_IOU_MIN       = 0.25   # min IoU to associate a box with an existing track
_TRACK_MAX_AGE       = 3.0    # seconds; track dies if unseen this long (3 frames @ 1fps)
_TRACK_HISTORY_LEN   = 10     # rolling window of (cls, conf) observations per track
_TRACK_SWITCH_N      = 2      # new class must appear ≥N times in window to be eligible
_TRACK_SWITCH_MARGIN = 0.15   # new class weighted-conf must exceed current by this fraction


@dataclass
class _Track:
    bbox:        dict
    ts:          float
    stable_cls:  str
    stable_conf: float
    history:     deque = field(default_factory=lambda: deque(maxlen=_TRACK_HISTORY_LEN))


_TRACK_CENTROID_MAX = 0.20   # max centroid distance (fraction of frame) to still associate

def _box_iou(a: dict, b: dict) -> float:
    xi1 = max(a["x1"], b["x1"]); yi1 = max(a["y1"], b["y1"])
    xi2 = min(a["x2"], b["x2"]); yi2 = min(a["y2"], b["y2"])
    inter = max(0.0, xi2 - xi1) * max(0.0, yi2 - yi1)
    if inter == 0.0:
        return 0.0
    area_a = (a["x2"] - a["x1"]) * (a["y2"] - a["y1"])
    area_b = (b["x2"] - b["x1"]) * (b["y2"] - b["y1"])
    union  = area_a + area_b - inter
    return inter / union if union > 0 else 0.0

def _box_proximity(a: dict, b: dict) -> float:
    """Centroid distance as fraction of frame diagonal — lower is closer."""
    cx_a = (a["x1"] + a["x2"]) / 2; cy_a = (a["y1"] + a["y2"]) / 2
    cx_b = (b["x1"] + b["x2"]) / 2; cy_b = (b["y1"] + b["y2"]) / 2
    return ((cx_a - cx_b) ** 2 + (cy_a - cy_b) ** 2) ** 0.5

def _box_match(a: dict, b: dict) -> float:
    """Match score: IoU if overlapping, else proximity-based fallback for fast movers."""
    iou = _box_iou(a, b)
    if iou >= _TRACK_IOU_MIN:
        return iou
    # Fallback: centroid within threshold → same object moving fast between frames
    if _box_proximity(a, b) <= _TRACK_CENTROID_MAX:
        return _TRACK_IOU_MIN  # floor score, still beats unmatched
    return 0.0


def _resolve_stable(track: _Track) -> tuple[str, float]:
    """Confidence-weighted majority class with hysteresis."""
    scores: dict[str, float] = {}
    counts: dict[str, int]   = {}
    for cls, conf in track.history:
        scores[cls] = scores.get(cls, 0.0) + conf
        counts[cls] = counts.get(cls, 0)   + 1

    if not scores:
        return track.stable_cls, track.stable_conf

    best = max(scores, key=lambda c: scores[c])
    if best == track.stable_cls:
        avg = scores[best] / counts[best]
        return best, avg

    # Hysteresis: new class must appear enough and beat current by margin
    if counts.get(best, 0) < _TRACK_SWITCH_N:
        return track.stable_cls, track.stable_conf
    current_score = scores.get(track.stable_cls, 0.0)
    if scores[best] < current_score * (1.0 + _TRACK_SWITCH_MARGIN):
        return track.stable_cls, track.stable_conf

    return best, scores[best] / counts[best]


def _apply_tracks(detections: list[dict]) -> list[dict]:
    """
    Associate per-frame YOLO boxes into tracks, emit stable class labels.

    Each output box gains:
      stable_cls / stable_conf  — smoothed label after tracking
      raw_cls    / raw_conf     — original per-frame YOLO output (for debug)

    Frame-level `classes` and `has_human` are recomputed from stable labels.
    """
    tracks: list[_Track] = []
    result: list[dict]   = []

    for det in detections:
        ts       = det["ts_offset"]
        raw_boxes = det.get("boxes") or []

        # Expire stale tracks
        tracks = [t for t in tracks if ts - t.ts <= _TRACK_MAX_AGE]

        used_tracks: set[int] = set()
        smoothed: list[dict]  = []

        for box in raw_boxes:
            # Greedy best-IoU match
            best_iou   = _TRACK_IOU_MIN
            best_track: _Track | None = None
            for t in tracks:
                if id(t) in used_tracks:
                    continue
                score = _box_match(box, t.bbox)
                if score > best_iou:
                    best_iou, best_track = score, t

            if best_track is None:
                best_track = _Track(bbox=box, ts=ts,
                                    stable_cls=box["cls"], stable_conf=box["conf"])
                tracks.append(best_track)

            used_tracks.add(id(best_track))
            best_track.bbox = box
            best_track.ts   = ts
            best_track.history.append((box["cls"], box["conf"]))

            s_cls, s_conf = _resolve_stable(best_track)
            best_track.stable_cls  = s_cls
            best_track.stable_conf = s_conf

            smoothed.append({
                **box,
                "cls":        s_cls,
                "conf":       s_conf,
                "raw_cls":    box["cls"],
                "raw_conf":   box["conf"],
            })

        stable_classes = list({b["cls"] for b in smoothed}) if smoothed else []
        has_human = any(b["cls"] == "person" for b in smoothed)
        top_conf  = max((b["conf"] for b in smoothed if b["cls"] == "person"),
                        default=det.get("confidence", 0.0))

        result.append({
            **det,
            "boxes":      smoothed,
            "classes":    stable_classes,
            "has_human":  has_human,
            "confidence": top_conf if has_human else det.get("confidence", 0.0),
        })

    return result


def _yolo_tag_video(model, seg_path: Path, seg_id: int,
                    db: VideoSegmentDB) -> int:
    """Read video file at 1fps, run YOLO, store detections with exact timestamps."""
    import cv2
    from .detect import _parse_results, CCTV_CLASS_IDS, _CONF_THRESHOLD

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
                results = model.predict(frame, classes=CCTV_CLASS_IDS,
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
    detections = _apply_tracks(detections)
    db.replace_detections(seg_id, detections)
    return len(detections)


def backfill_events(db: VideoSegmentDB, video_dir: Path | None = None,
                    model=None) -> None:
    """YOLO-tag and extract events for closed segments missing detections or events."""
    with db._connect() as conn:
        segs = conn.execute(
            "SELECT s.* FROM segments s WHERE s.end_ts IS NOT NULL"
            " AND (NOT EXISTS (SELECT 1 FROM video_detections WHERE segment_id=s.id)"
            "   OR NOT EXISTS (SELECT 1 FROM video_events WHERE segment_id=s.id))"
        ).fetchall()
    for row in segs:
        seg = dict(row)
        seg_path = (video_dir / seg["path"]) if video_dir else None
        # YOLO tag if model + file available
        if model and seg_path and seg_path.exists():
            n_det = _yolo_tag_video(model, seg_path, seg["id"], db)
            LOG.info("backfill tagged %d frames in %s", n_det, seg["path"][-30:])
        # Extract events from detections (new or old)
        dets = db.detections_for_segment(seg["id"])
        n = extract_events(seg, dets, db)
        if n:
            LOG.info("backfill extracted %d events from %s", n, seg["path"][-30:])


def extract_events(segment: dict, detections: list[dict], db: VideoSegmentDB) -> int:
    """Group detections into events and store them, replacing any existing."""
    rows = _events_from_detections(segment, detections)
    db.replace_events(segment["id"], rows)
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
    def __init__(self, source, video_dir: Path, db: VideoSegmentDB,
                 model=None) -> None:
        self.source     = source
        self.video_dir  = video_dir
        self.db         = db
        self.model      = model
        self._lock      = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._seg_id:    int | None  = None
        self._seg_path:  Path | None = None
        self._seg_start: float       = 0.0
        self._last_det:  float       = 0.0
        self._recording: bool        = False
        self._prev_counts: dict      = {}
        self._warmup_left: int       = 3  # silent frames to establish baseline

    def on_detection(self, ts: float, has_human: bool, confidence: float,
                     boxes: list | None, classes: list | None) -> None:
        triggered, new_counts = _is_new_activity(boxes, self._prev_counts)
        self._prev_counts = new_counts
        if self._warmup_left > 0:
            self._warmup_left -= 1
            return  # establish baseline before enabling triggers
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

            if self._recording and self._seg_id:
                self.db.add_detection(
                    self._seg_id,
                    max(0.0, ts - self._seg_start),
                    has_human,
                    confidence,
                    boxes,
                    classes,
                )

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

            # YOLO tag from video file (exact timestamps, no sync drift)
            n_det = 0
            if seg and self.model:
                n_det = _yolo_tag_video(self.model, seg_path, seg_id, self.db)
            # Extract events from accurate detections
            if seg:
                dets = self.db.detections_for_segment(seg_id)
                n_evt = extract_events(seg, dets, self.db)
                LOG.info("video post-processed: %s (%d dets, %d events)",
                         seg_path.name, n_det, n_evt)
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
