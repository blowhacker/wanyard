from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from .capture import CaptureNotReady, capture_once, grab_rtsp_temp
from .config import AppConfig, SourceConfig
from .index import ImageIndex

LOG = logging.getLogger(__name__)


class CaptureWorker:
    def __init__(
        self,
        config: AppConfig,
        image_index: ImageIndex | None = None,
        source_db=None,
        detection_model=None,
        detection_store=None,
    ) -> None:
        self.config = config
        self.image_index = image_index
        self.source_db = source_db
        self.detection_model = detection_model
        self.detection_store = detection_store
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        if any(t.is_alive() for t in self._threads):
            return
        self._threads = []

        all_sources = _merged_sources(self.config, None, self.source_db)

        if self.detection_model:
            rtsp_sources = [s for s in all_sources if s.type == "rtsp" and s.enabled]
            non_rtsp = tuple(s for s in all_sources if s.type != "rtsp" or not s.enabled)
            for source in rtsp_sources:
                t = threading.Thread(
                    target=_run_rtsp_with_detection,
                    args=(self.config, source, self.detection_model,
                          self.image_index, self._stop.is_set,
                          self.detection_store),
                    name=f"detect-{source.id}",
                    daemon=True,
                )
                t.start()
                self._threads.append(t)
            if non_rtsp:
                t = threading.Thread(
                    target=run_loop,
                    kwargs=dict(config=self.config, image_index=self.image_index,
                                should_stop=self._stop.is_set, source_db=None),
                    name="capture-worker",
                    daemon=True,
                )
                t.start()
                self._threads.append(t)
        else:
            t = threading.Thread(
                target=run_loop,
                kwargs=dict(config=self.config, image_index=self.image_index,
                            should_stop=self._stop.is_set, source_db=self.source_db),
                name="capture-worker",
                daemon=True,
            )
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=10)


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


def _run_rtsp_with_detection(
    config: AppConfig,
    source: SourceConfig,
    model,
    image_index: ImageIndex | None,
    should_stop: Callable[[], bool],
    detection_store=None,
) -> None:
    from .capture import _convert_to_avif, build_output_path

    poll = config.detection_poll_seconds
    baseline = source.interval(config.interval_seconds)
    last_saved: float = 0.0

    LOG.info("detection capture started for %s (poll=%.1fs baseline=%.0fs)", source.name, poll, baseline)

    while not should_stop():
        t0 = time.monotonic()
        tmp = None
        try:
            tmp = grab_rtsp_temp(config, source)

            results = model.predict(str(tmp), classes=[0], conf=0.35, verbose=False)
            has_human = bool(results and results[0].boxes and len(results[0].boxes))
            top_conf = float(max(results[0].boxes.conf.tolist())) if has_human else 0.0

            now = time.monotonic()
            baseline_due = (now - last_saved) >= baseline

            if has_human or baseline_due:
                out = build_output_path(config, source)
                out.parent.mkdir(parents=True, exist_ok=True)
                if config.filenames.capture_format == "avif":
                    _convert_to_avif(tmp, out)
                    tmp = None
                else:
                    tmp.rename(out)
                    tmp = None
                last_saved = now
                if image_index:
                    image_index.refresh()
                if detection_store:
                    rel = out.relative_to(config.output_dir).as_posix()
                    detection_store.set(rel, has_human, top_conf)
                reason = "human" if has_human else "baseline"
                LOG.info("captured %s for %s [%s] conf=%.2f", out.name, source.name, reason, top_conf)

        except CaptureNotReady as exc:
            LOG.warning("not ready %s: %s", source.name, exc)
        except TimeoutError:
            LOG.warning("grab timed out for %s", source.name)
        except Exception:
            LOG.exception("detection capture failed for %s", source.name)
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)

        elapsed = time.monotonic() - t0
        _sleep_until(t0 + poll, should_stop)


def _sleep_until(deadline: float, should_stop: Callable[[], bool]) -> None:
    while not should_stop():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.5, remaining))
