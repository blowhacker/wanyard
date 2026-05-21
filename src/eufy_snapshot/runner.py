"""RTSP capture and detection. Detection via yolo-serve (TODO: wire socket client)."""
from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from pathlib import Path

from .config import AppConfig, SourceConfig

LOG = logging.getLogger(__name__)


class CaptureWorker:
    """Placeholder — RTSP recording trigger will connect to yolo-serve socket."""
    def __init__(self, config: AppConfig, video_workers=None) -> None:
        self.config = config
        self.video_workers = video_workers or {}
        self._stop = threading.Event()

    def start(self) -> None:
        pass  # TODO: start RTSP threads when yolo-serve socket client is ready

    def stop(self) -> None:
        self._stop.set()
