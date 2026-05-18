from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path

import queue

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
        video_workers=None,
    ) -> None:
        self.config = config
        self.image_index = image_index
        self.source_db = source_db
        self.detection_model = detection_model
        self.detection_store = detection_store
        self.video_workers = video_workers or {}
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
                          self.detection_store,
                          self.video_workers.get(source.id)),
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


def _rtsp_reader(url: str, frame_q: "queue.Queue", stop_fn: Callable[[], bool]) -> None:
    """Persistent RTSP reader thread. Reconnects on drop with backoff."""
    import cv2
    backoff = 2.0
    while not stop_fn():
        try:
            cap = cv2.VideoCapture(url)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                raise RuntimeError("could not open stream")
            backoff = 2.0
            while not stop_fn():
                ret, frame = cap.read()
                if not ret:
                    break
                # Always keep the freshest frame; drop stale one
                try:
                    frame_q.get_nowait()
                except queue.Empty:
                    pass
                frame_q.put(frame)
        except Exception:
            pass
        finally:
            try:
                cap.release()
            except Exception:
                pass
        if not stop_fn():
            time.sleep(backoff)
            backoff = min(backoff * 2, 60.0)


def _run_rtsp_with_detection(
    config: AppConfig,
    source: SourceConfig,
    model,
    image_index: ImageIndex | None,
    should_stop: Callable[[], bool],
    detection_store=None,
    video_worker=None,
) -> None:
    import cv2
    import tempfile
    from .capture import _convert_to_avif, build_output_path

    url = source.url or ""
    if source.url_env:
        import os as _os
        url = _os.environ.get(source.url_env, "")
    if not url:
        LOG.error("no URL for source %s", source.id)
        return

    baseline = source.interval(config.interval_seconds)
    poll     = config.detection_poll_seconds
    last_saved: float = 0.0
    frame_q: queue.Queue = queue.Queue(maxsize=1)

    reader = threading.Thread(
        target=_rtsp_reader, args=(url, frame_q, should_stop),
        name=f"rtsp-{source.id}", daemon=True,
    )
    reader.start()
    LOG.info("stream capture started for %s (poll=%.1fs baseline=%.0fs)", source.name, poll, baseline)

    last_frame_t = time.monotonic()

    while not should_stop():
        t0 = time.monotonic()
        try:
            frame = frame_q.get(timeout=1.0)
            last_frame_t = time.monotonic()
        except queue.Empty:
            if time.monotonic() - last_frame_t > 30:
                LOG.warning("no frame from %s in 30s — reconnecting", source.name)
                last_frame_t = time.monotonic()
            continue

        try:
            from .detect import CCTV_CLASS_IDS, _CONF_THRESHOLD
            from .video import _two_stage_predict
            has_human, top_conf, boxes = _two_stage_predict(
                model, frame, CCTV_CLASS_IDS, _CONF_THRESHOLD)

            now = time.monotonic()
            if has_human or (now - last_saved) >= baseline:
                out = build_output_path(config, source)
                out.parent.mkdir(parents=True, exist_ok=True)

                if config.filenames.capture_format == "avif":
                    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tf:
                        tmp = Path(tf.name)
                    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
                    if ok:
                        tmp.write_bytes(buf.tobytes())
                        _convert_to_avif(tmp, out)
                else:
                    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
                    if ok:
                        out.write_bytes(buf.tobytes())

                last_saved = now
                if image_index:
                    image_index.refresh()
                if detection_store:
                    rel = out.relative_to(config.output_dir).as_posix()
                    detection_store.set(rel, has_human, top_conf, boxes)

            # Event-triggered video recording
            if video_worker:
                try:
                    video_worker.on_detection(
                        time.time(), has_human, top_conf, boxes,
                        list({b["cls"] for b in boxes}) if boxes else [],
                    )
                except Exception:
                    pass
                reason = "human" if has_human else "baseline"
                LOG.info("captured %s for %s [%s] conf=%.2f", out.name, source.name, reason, top_conf)

        except Exception:
            LOG.exception("detection failed for %s", source.name)

        _sleep_until(t0 + poll, should_stop)


def _sleep_until(deadline: float, should_stop: Callable[[], bool]) -> None:
    while not should_stop():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.5, remaining))
