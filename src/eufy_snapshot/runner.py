"""RTSP recording coordinator with thread watchdog."""
from __future__ import annotations

import logging
import threading
import time
from .config import AppConfig

LOG = logging.getLogger(__name__)
_WATCHDOG_INTERVAL = 30  # seconds between liveness checks


class CaptureWorker:
    def __init__(self, config: AppConfig, video_workers=None) -> None:
        self.config = config
        self.video_workers = video_workers or {}
        self._threads: dict[str, threading.Thread] = {}
        self._stop = threading.Event()
        self._watchdog: threading.Thread | None = None

    def start(self) -> None:
        for source_id, vw in self.video_workers.items():
            self._spawn(source_id, vw)
        if self.video_workers:
            self._watchdog = threading.Thread(
                target=self._watch, name="rec-watchdog", daemon=True
            )
            self._watchdog.start()

    def _spawn(self, source_id: str, vw) -> None:
        t = threading.Thread(target=vw.run, name=f"rec-{source_id}", daemon=True)
        t.start()
        self._threads[source_id] = t
        LOG.info("recording thread started for %s", source_id)

    def _watch(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(_WATCHDOG_INTERVAL)
            if self._stop.is_set():
                break
            for source_id, vw in self.video_workers.items():
                t = self._threads.get(source_id)
                if t and not t.is_alive():
                    LOG.warning("recording thread dead for %s — restarting", source_id)
                    vw._stop.clear()  # reset stop event so run() loop can proceed
                    self._spawn(source_id, vw)

    def thread_health(self) -> dict[str, bool]:
        return {sid: (t.is_alive() if t else False)
                for sid, t in self._threads.items()}

    def stop(self) -> None:
        self._stop.set()
        for vw in self.video_workers.values():
            vw.stop()
        for t in self._threads.values():
            t.join(timeout=15)
