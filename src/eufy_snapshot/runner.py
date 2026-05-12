from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .capture import CaptureNotReady, capture_once, save_debug_screencap
from .config import AppConfig
from .index import ImageIndex

LOG = logging.getLogger(__name__)


class CaptureWorker:
    def __init__(self, config: AppConfig, image_index: ImageIndex | None = None) -> None:
        self.config = config
        self.image_index = image_index
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self.run_forever, name="capture-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=10)

    def run_forever(self) -> None:
        run_loop(self.config, self.image_index, should_stop=self._stop.is_set)


def run_loop(
    config: AppConfig,
    image_index: ImageIndex | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> None:
    should_stop = should_stop or (lambda: False)
    while not should_stop():
        try:
            capture_once(config)
            if image_index:
                image_index.refresh()
        except CaptureNotReady as exc:
            LOG.warning("capture not ready: %s", exc)
        except TimeoutError:
            LOG.exception("capture timed out")
            if config.capture.debug_screencap_on_failure:
                try:
                    save_debug_screencap(config)
                except Exception:
                    LOG.exception("failed to save debug screencap")
        except Exception:
            LOG.exception("capture failed")

        deadline = time.monotonic() + config.interval_seconds
        while not should_stop() and time.monotonic() < deadline:
            time.sleep(min(0.5, max(0, deadline - time.monotonic())))
