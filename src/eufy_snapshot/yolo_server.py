"""Standalone YOLO inference server.

Runs as a separate process/container. Owns:
  - YOLO model loading
  - Backfill loop: tags untagged segments and extracts events
  - Unix socket server for future live frame requests

Start with: eufy-snapshot yolo-serve
"""
from __future__ import annotations

import json
import logging
import os
import signal
import socket
import socketserver
import threading
import time
from pathlib import Path

LOG = logging.getLogger(__name__)

SOCKET_PATH = os.environ.get("YOLO_SOCKET", "/tmp/yolo.sock")


# ── Socket server ──────────────────────────────────────────────────────────────

class _YoloHandler(socketserver.StreamRequestHandler):
    def handle(self):
        for line in self.rfile:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                resp = self.server.dispatch(req)
            except Exception as e:
                resp = {"status": "error", "error": str(e)}
            self.wfile.write((json.dumps(resp) + "\n").encode())
            self.wfile.flush()


class YoloSocketServer(socketserver.ThreadingUnixStreamServer):
    def __init__(self, socket_path: str, model, video_db, video_dir):
        self.model            = model
        self.video_db         = video_db
        self.video_dir        = video_dir
        self._backfill_thread: threading.Thread | None = None
        if Path(socket_path).exists():
            Path(socket_path).unlink()
        super().__init__(socket_path, _YoloHandler)

    def dispatch(self, req: dict) -> dict:
        t = req.get("type")
        if t == "ping":
            bt = self._backfill_thread
            return {"status": "ok", "backfill_alive": bool(bt and bt.is_alive())}
        if t == "status":
            bt = self._backfill_thread
            return {"status": "ok",
                    "model": str(getattr(self.model, "model_name", None)),
                    "backfill_alive": bool(bt and bt.is_alive())}
        # Future: detect_frame for live RTSP
        return {"status": "error", "error": f"unknown type: {t}"}


# ── M3U8 parser ────────────────────────────────────────────────────────────────

def _parse_hls_segments(m3u8_path: Path) -> list[tuple[str, float]]:
    """Return [(filename, abs_ts_unix)] from a live m3u8 with EXT-X-PROGRAM-DATE-TIME."""
    from datetime import datetime, timezone
    results = []
    pending_dt: float | None = None
    try:
        lines = m3u8_path.read_text().splitlines()
    except OSError:
        return results
    for line in lines:
        line = line.strip()
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            dt_str = line[len("#EXT-X-PROGRAM-DATE-TIME:"):]
            try:
                pending_dt = datetime.fromisoformat(
                    dt_str.replace("+0000", "+00:00")
                ).timestamp()
            except ValueError:
                pending_dt = None
        elif not line.startswith("#") and line.endswith(".ts") and pending_dt is not None:
            results.append((line, pending_dt))
            pending_dt = None
    return results


# ── Per-class thumb crop (matches MP4 _select_event_box + _crop_from_box) ─────

def _crop_thumb(frame, cls_boxes: list, cls: str,
                thumb_w: int = 176, thumb_h: int = 132,
                aspect: float = 4 / 3) -> bytes | None:
    """Crop the frame around the best box for this class, resize to thumb_w×thumb_h."""
    import cv2
    if not cls_boxes:
        return None

    # Pick best box by (confidence, area)
    def score(b):
        try:
            area = max(0.0, float(b["x2"]) - float(b["x1"])) * \
                   max(0.0, float(b["y2"]) - float(b["y1"]))
            conf = float(b.get("conf", 0.0))
        except (KeyError, TypeError, ValueError):
            return (0.0, 0.0)
        return (conf, area)
    box = max(cls_boxes, key=score)

    fh, fw = frame.shape[:2]
    try:
        x1 = max(0.0, min(1.0, float(box["x1"]))) * fw
        y1 = max(0.0, min(1.0, float(box["y1"]))) * fh
        x2 = max(0.0, min(1.0, float(box["x2"]))) * fw
        y2 = max(0.0, min(1.0, float(box["y2"]))) * fh
    except (KeyError, TypeError, ValueError):
        return None
    if x2 <= x1 or y2 <= y1:
        return None

    bw, bh = x2 - x1, y2 - y1
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    pad = max(24.0, max(bw, bh) * 0.45)
    cw, ch = bw + pad * 2, bh + pad * 2
    if cw / ch < aspect: cw = ch * aspect
    else:                ch = cw / aspect
    cw = min(float(fw), max(96.0, cw))
    ch = min(float(fh), max(72.0, ch))
    if cw / ch < aspect: cw = min(float(fw), ch * aspect)
    else:                ch = min(float(fh), cw / aspect)
    rw = min(fw, max(2, round(cw)))
    rh = min(fh, max(2, round(ch)))
    x = int(max(0.0, min(float(fw - rw), cx - rw / 2)))
    y = int(max(0.0, min(float(fh - rh), cy - rh / 2)))

    cropped = frame[y:y+rh, x:x+rw]
    if cropped.size == 0:
        return None
    small = cv2.resize(cropped, (thumb_w, thumb_h))
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])
    return buf.tobytes() if ok else None


# ── HLS real-time tag loop ──────────────────────────────────────────────────────

def _hls_tag_loop(model, video_db, video_dir: Path, stop_event: threading.Event):
    """Tag incoming HLS .ts segments in near-real-time (<5s latency)."""
    import cv2
    from .video import _parse_results, _CCTV_CLASS_IDS, _CONF_THRESHOLD

    LOG.info("HLS tag loop started")
    seen: dict[str, set[str]] = {}   # source_id -> set of seen filenames

    while not stop_event.is_set():
        try:
            live_root = video_dir / "live"
            if not live_root.exists():
                stop_event.wait(5)
                continue

            for source_dir in live_root.iterdir():
                if not source_dir.is_dir():
                    continue
                source_id = source_dir.name
                m3u8 = source_dir / "live.m3u8"
                if not m3u8.exists():
                    continue

                segments = _parse_hls_segments(m3u8)
                if not segments:
                    continue

                # Evict filenames no longer in the playlist from seen set
                current = {fn for fn, _ in segments}
                seen.setdefault(source_id, set())
                seen[source_id] &= current

                new_segs = [(fn, ts) for fn, ts in segments
                            if fn not in seen[source_id]]

                for filename, abs_ts in new_segs:
                    if stop_event.is_set():
                        break
                    ts_path = source_dir / filename
                    if not ts_path.exists():
                        continue
                    seen[source_id].add(filename)

                    # Record first-frame time of the open MP4 segment if not yet known.
                    # The earliest .ts abs_ts == camera-accurate first frame of MP4.
                    try:
                        video_db.observe_frame_time(source_id, abs_ts)
                    except Exception:
                        LOG.exception("observe_frame_time failed")

                    # Sample 2 frames from the segment (0s and ~1s) → 1fps coverage
                    cap = cv2.VideoCapture(str(ts_path))
                    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
                    mid_frame_idx = max(1, int(round(fps)))   # ~1s into the segment
                    frame_samples: list[tuple[float, "any"]] = []
                    ret, frame0 = cap.read()
                    if ret:
                        frame_samples.append((abs_ts, frame0))
                        cap.set(cv2.CAP_PROP_POS_FRAMES, mid_frame_idx)
                        ret2, frame1 = cap.read()
                        if ret2:
                            ts_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
                            offset = (ts_ms / 1000.0) if ts_ms > 0 else 1.0
                            frame_samples.append((abs_ts + offset, frame1))
                    cap.release()
                    if not frame_samples:
                        continue

                    for sample_abs_ts, frame in frame_samples:
                        try:
                            results = model.predict(
                                frame, classes=_CCTV_CLASS_IDS,
                                conf=_CONF_THRESHOLD, verbose=False,
                            )
                            _, _, boxes = _parse_results(results)
                            if not boxes:
                                continue
                            classes = list({b["cls"] for b in boxes})

                            events = []
                            for cls in classes:
                                cls_boxes = [b for b in boxes if b["cls"] == cls]
                                thumb_bytes = _crop_thumb(frame, cls_boxes, cls)
                                events.append({
                                    "source_id":  source_id,
                                    "abs_ts":     sample_abs_ts,
                                    "class":      cls,
                                    "confidence": max((b["conf"] for b in cls_boxes), default=0.0),
                                    "boxes_json": json.dumps(cls_boxes),
                                    "thumb_jpeg": thumb_bytes,
                                })
                            video_db.insert_hls_events(events)
                        except Exception:
                            LOG.exception("HLS tag error: %s", filename)

            # Prune stale hls_events older than 2h
            video_db.prune_hls_events(max_age_seconds=7200)

        except Exception:
            LOG.exception("HLS tag loop error — continuing")

        stop_event.wait(1)   # check for new segments every 1s

    LOG.info("HLS tag loop stopped")


# ── Backfill loop ──────────────────────────────────────────────────────────────

def _backfill_loop(model, video_db, video_dir: Path, stop_event: threading.Event):
    from .video import _yolo_tag_video, extract_events

    LOG.info("backfill loop started")
    while not stop_event.is_set():
        try:
            with video_db._connect() as conn:
                segs = conn.execute(
                    "SELECT s.* FROM segments s WHERE s.end_ts IS NOT NULL"
                    " AND NOT EXISTS (SELECT 1 FROM video_detections WHERE segment_id=s.id)"
                    " LIMIT 5"
                ).fetchall()

            if not segs:
                stop_event.wait(15)
                continue

            for row in segs:
                if stop_event.is_set():
                    break
                seg = dict(row)
                seg_path = video_dir / seg["path"]
                _sentinel = [{"ts_offset": -1, "has_human": False, "confidence": 0.0,
                              "boxes": [], "classes": []}]

                # Check if HLS real-time tagging already covered this segment
                hls_evts = video_db.get_hls_events(
                    source_id=seg["source_id"],
                    since=seg["start_ts"],
                    until=seg["end_ts"],
                )
                if hls_evts:
                    # HLS events go straight to video_events for fast provisional
                    # display. But always run MP4 YOLO for accurate detection
                    # ts_offsets — cv2.CAP_PROP_POS_MSEC on MP4 gives exact PTS,
                    # whereas TS PROGRAM-DATE-TIME is approximate (rounding,
                    # keyframe alignment) and causes box trail.
                    promoted = [
                        {
                            "segment_id": seg["id"],
                            "source_id":  e["source_id"],
                            "abs_ts":     e["abs_ts"],
                            "class":      e["class"],
                            "start_off":  max(0.0, e["abs_ts"] - seg["start_ts"]),
                            "end_off":    min(
                                seg["end_ts"] - seg["start_ts"],
                                e["abs_ts"] - seg["start_ts"] + 2.0,
                            ),
                            "confidence": e["confidence"],
                            "boxes_json": e["boxes_json"],
                        }
                        for e in hls_evts
                    ]
                    video_db.insert_events(promoted)
                    video_db.delete_hls_events(
                        seg["source_id"], seg["start_ts"], seg["end_ts"]
                    )
                    if seg_path.exists():
                        n = _yolo_tag_video(model, seg_path, seg["id"], video_db)
                        LOG.info("HLS events + MP4 YOLO (%d frames): %s",
                                 n, seg["path"][-35:])
                        if n == 0:
                            video_db.replace_detections(seg["id"], _sentinel)
                    else:
                        video_db.replace_detections(seg["id"], _sentinel)
                    continue

                if seg_path.exists():
                    n = _yolo_tag_video(model, seg_path, seg["id"], video_db)
                    LOG.info("tagged %d frames: %s", n, seg["path"][-35:])
                    if n == 0:
                        video_db.replace_detections(seg["id"], _sentinel)
                else:
                    video_db.replace_detections(seg["id"], _sentinel)
                dets = video_db.detections_for_segment(seg["id"])
                n_evt = extract_events(seg, dets, video_db)
                if n_evt:
                    LOG.info("extracted %d events: %s", n_evt, seg["path"][-35:])
        except Exception:
            LOG.exception("backfill error — retrying in 30s")
            stop_event.wait(30)

    LOG.info("backfill loop stopped")


# ── Auto-cleanup loop ──────────────────────────────────────────────────────────

def _cleanup_loop(video_db, video_dir: Path, stop_event: threading.Event):
    """Periodically delete old footage based on CLEANUP_DAYS / CLEANUP_MAX_GB."""
    import shutil as _shutil

    def _get_thresholds():
        # DB overrides env vars
        days = video_db.get_setting("cleanup_days")
        gb   = video_db.get_setting("cleanup_max_gb")
        if days is None:
            d = os.environ.get("CLEANUP_DAYS", "")
            days = float(d) if d else None
        if gb is None:
            g = os.environ.get("CLEANUP_MAX_GB", "")
            gb = float(g) if g else None
        return days, gb

    cleanup_days, cleanup_gb = _get_thresholds()
    if not cleanup_days and not cleanup_gb:
        LOG.info("no cleanup thresholds set — auto-cleanup disabled")
        return
    LOG.info("auto-cleanup: days=%s max_gb=%s", cleanup_days, cleanup_gb)

    while not stop_event.is_set():
        try:
            cutoff_ts = time.time() - (cleanup_days * 86400) if cleanup_days else None
            total_used = sum(
                f.stat().st_size for f in video_dir.rglob("*.mp4") if f.is_file()
            ) if cleanup_gb else 0

            if cutoff_ts or (cleanup_gb and total_used > cleanup_gb * 1e9):
                with video_db._connect() as conn:
                    where = "end_ts IS NOT NULL"
                    params = []
                    if cutoff_ts:
                        where += " AND end_ts < ?"
                        params.append(cutoff_ts)
                    elif cleanup_gb and total_used > cleanup_gb * 1e9:
                        # Delete oldest segments until under limit
                        where += " AND end_ts < (SELECT AVG(end_ts) FROM segments WHERE end_ts IS NOT NULL)"
                    segs = [dict(r) for r in conn.execute(
                        f"SELECT id, path FROM segments WHERE {where}", params
                    ).fetchall()]

                freed = 0
                for seg in segs:
                    p = video_dir / seg["path"]
                    try:
                        if p.exists():
                            freed += p.stat().st_size
                            p.unlink()
                        sprite = p.with_suffix("")
                        if sprite.is_dir():
                            import shutil as _sh; _sh.rmtree(sprite, ignore_errors=True)
                    except Exception:
                        pass

                if segs:
                    with video_db._connect() as conn:
                        ids = [s["id"] for s in segs]
                        pl  = ",".join("?" * len(ids))
                        conn.execute(f"DELETE FROM video_events WHERE segment_id IN ({pl})", ids)
                        conn.execute(f"DELETE FROM video_detections WHERE segment_id IN ({pl})", ids)
                        conn.execute(f"DELETE FROM segments WHERE id IN ({pl})", ids)
                    LOG.info("auto-cleanup: deleted %d segments, freed %.1f GB",
                             len(segs), freed / 1e9)
        except Exception:
            LOG.exception("auto-cleanup error")

        stop_event.wait(3600)
        cleanup_days, cleanup_gb = _get_thresholds()  # re-read in case UI changed them

    LOG.info("auto-cleanup loop stopped")


# ── Entry point ────────────────────────────────────────────────────────────────

def run(video_db_path: Path, video_dir: Path):
    from ultralytics import YOLO
    from .video import VideoSegmentDB

    model_path = os.environ.get("YOLO_MODEL_PATH", "yolo11m.pt")
    LOG.info("loading YOLO model: %s", model_path)
    model = YOLO(model_path)

    video_db = VideoSegmentDB(video_db_path)
    with video_db._connect() as conn:
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            LOG.error("DB integrity check FAILED: %s — aborting", result)
            return
        LOG.info("DB integrity check passed")
    stop_event = threading.Event()

    def _shutdown(sig, frame):
        LOG.info("shutting down")
        stop_event.set()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT,  _shutdown)

    backfill_thread = threading.Thread(
        target=_backfill_loop,
        args=(model, video_db, video_dir, stop_event),
        daemon=True, name="backfill"
    )
    backfill_thread.start()

    hls_tag_thread = threading.Thread(
        target=_hls_tag_loop,
        args=(model, video_db, video_dir, stop_event),
        daemon=True, name="hls-tag"
    )
    hls_tag_thread.start()

    cleanup_thread = threading.Thread(
        target=_cleanup_loop,
        args=(video_db, video_dir, stop_event),
        daemon=True, name="cleanup"
    )
    cleanup_thread.start()

    srv = YoloSocketServer(SOCKET_PATH, model, video_db, video_dir)
    srv._backfill_thread = backfill_thread
    srv.socket.settimeout(1.0)
    LOG.info("YOLO server listening on %s", SOCKET_PATH)

    while not stop_event.is_set():
        srv.handle_request()

    stop_event.set()
    srv.server_close()
    if Path(SOCKET_PATH).exists():
        Path(SOCKET_PATH).unlink()
    LOG.info("YOLO server stopped")
