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
                if seg_path.exists():
                    n = _yolo_tag_video(model, seg_path, seg["id"], video_db)
                    LOG.info("tagged %d frames: %s", n, seg["path"][-35:])
                    if n == 0:
                        video_db.replace_detections(seg["id"], _sentinel)
                else:
                    # File missing (crash-loop orphan) — clear from queue
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
