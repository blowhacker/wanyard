from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .capture import CaptureNotReady, capture_once, save_debug_screencap
from .config import AppConfig, SourceConfig
from .index import ImageIndex

LOG = logging.getLogger(__name__)


class CaptureWorker:
    def __init__(
        self,
        config: AppConfig,
        image_index: ImageIndex | None = None,
        source_db=None,
    ) -> None:
        self.config = config
        self.image_index = image_index
        self.source_db = source_db
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
        run_loop(self.config, self.image_index, should_stop=self._stop.is_set, source_db=self.source_db)


def run_loop(
    config: AppConfig,
    image_index: ImageIndex | None = None,
    should_stop: Callable[[], bool] | None = None,
    source_id: str | None = None,
    source_db=None,
) -> None:
    should_stop = should_stop or (lambda: False)
    next_due: dict[str, float] = {}

    while not should_stop():
        all_sources = _merged_sources(config, source_id, source_db)

        for source in all_sources:
            if source.id not in next_due:
                next_due[source.id] = 0.0

        if image_index:
            image_index.update_sources(all_sources)

        source_map = {s.id: s for s in all_sources}
        now = time.monotonic()
        due_ids = [sid for sid, t in next_due.items() if t <= now and sid in source_map]

        if not due_ids:
            active = [t for sid, t in next_due.items() if sid in source_map]
            if active:
                _sleep_until(min(active), should_stop)
            else:
                time.sleep(0.5)
            continue

        for sid in due_ids:
            source = source_map[sid]
            try:
                capture_once(config, source)
                if image_index:
                    image_index.refresh()
            except CaptureNotReady as exc:
                LOG.warning("capture not ready for %s: %s", source.name, exc)
            except TimeoutError:
                LOG.exception("capture timed out for %s", source.name)
                if source.type == "eufy_native" and source.capture.debug_screencap_on_failure:
                    try:
                        save_debug_screencap(config)
                    except Exception:
                        LOG.exception("failed to save debug screencap")
            except Exception:
                LOG.exception("capture failed for %s", source.name)
            finally:
                next_due[sid] = time.monotonic() + source.interval(config.interval_seconds)


def _merged_sources(
    config: AppConfig,
    source_id: str | None,
    source_db,
) -> tuple[SourceConfig, ...]:
    if source_id is not None:
        cfg_source = config.source_by_id(source_id)
        if cfg_source is not None:
            if not cfg_source.enabled:
                raise ValueError(f"source is disabled: {source_id}")
            return (cfg_source,)
        if source_db is not None:
            db_source = next((s for s in source_db.to_source_configs() if s.id == source_id), None)
            if db_source is not None:
                if not db_source.enabled:
                    raise ValueError(f"source is disabled: {source_id}")
                return (db_source,)
        raise ValueError(f"unknown source: {source_id}")

    cfg_sources = config.enabled_sources()
    if source_db is None:
        return cfg_sources
    cfg_ids = {s.id for s in cfg_sources}
    db_sources = tuple(s for s in source_db.to_source_configs() if s.id not in cfg_ids and s.enabled)
    return cfg_sources + db_sources


def _sleep_until(deadline: float, should_stop: Callable[[], bool]) -> None:
    while not should_stop():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.5, remaining))
