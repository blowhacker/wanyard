"""RTSP recording coordinator. Starts continuous VideoWorker threads."""
from __future__ import annotations

import logging
import threading
from .config import AppConfig

LOG = logging.getLogger(__name__)


class CaptureWorker:
    def __init__(self, config: AppConfig, video_workers=None) -> None:
        self.config = config
        self.video_workers = video_workers or {}
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        for source_id, vw in self.video_workers.items():
            t = threading.Thread(target=vw.run, name=f"rec-{source_id}", daemon=True)
            t.start()
            self._threads.append(t)
            LOG.info("recording thread started for %s", source_id)

    def stop(self) -> None:
        for vw in self.video_workers.values():
            vw.stop()
        for t in self._threads:
            t.join(timeout=15)
