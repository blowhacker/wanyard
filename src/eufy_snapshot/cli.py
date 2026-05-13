from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import subprocess
import sys
import threading
from pathlib import Path

from .capture import capture_once
from .config import AppConfig, load_config
from .db import SourceDB
from .detect import DetectionStore, DetectionWorker
from .index import ImageIndex
from .runner import CaptureWorker, run_loop
from .web import make_app


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level), format="%(asctime)s %(levelname)s %(message)s")
    config = load_config(args.config)
    if args.command == "run":
        run_loop(config, source_id=args.source)
        return 0
    if args.command == "web":
        return cmd_web(config)
    if args.command == "serve":
        return cmd_serve(config)
    if args.command == "human-watch":
        return cmd_human_watch(config, args.source, args.interval, args.conf)
    parser.print_help()
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="eufy-snapshot")
    parser.add_argument("-c", "--config", default="config.yaml", help="path to config.yaml")
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="logging verbosity",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run", help="run the capture daemon only")
    run_parser.add_argument("--source", help="poll only this source id")
    sub.add_parser("web", help="run the web viewer only")
    sub.add_parser("serve", help="run capture daemon and web viewer together")
    hw = sub.add_parser("human-watch", help="poll RTSP, save only frames with humans")
    hw.add_argument("--source", help="source id (required if multiple sources)")
    hw.add_argument("--interval", type=float, default=5.0, help="poll interval seconds (default 5)")
    hw.add_argument("--conf", type=float, default=0.35, help="YOLO confidence threshold (default 0.35)")
    return parser



def cmd_web(config: AppConfig) -> int:
    source_db = SourceDB(config.db_path) if config.db_path else None
    all_sources = config.sources + (source_db.to_source_configs() if source_db else ())
    image_index = ImageIndex(
        config.output_dir, config.filenames.timezone, config.web.max_index_items, all_sources
    )
    det_store = DetectionStore(config.output_dir / ".detections.db")
    det_worker = DetectionWorker(det_store, image_index)
    app = make_app(
        config, image_index, source_db=source_db,
        detection_store=det_store, detection_worker=det_worker,
    )
    _serve(app, config)
    return 0


def cmd_serve(config: AppConfig) -> int:
    source_db = SourceDB(config.db_path) if config.db_path else None
    all_sources = config.sources + (source_db.to_source_configs() if source_db else ())
    image_index = ImageIndex(
        config.output_dir, config.filenames.timezone, config.web.max_index_items, all_sources
    )
    det_store = DetectionStore(config.output_dir / ".detections.db")
    det_worker = DetectionWorker(det_store, image_index)
    detection_model = _load_yolo_model()
    worker = CaptureWorker(config, image_index, source_db=source_db,
                           detection_model=detection_model, detection_store=det_store)
    app = make_app(
        config, image_index, source_db=source_db, capture_worker=worker,
        detection_store=det_store, detection_worker=det_worker,
    )
    _serve(app, config)
    return 0


def _load_yolo_model():
    try:
        import os
        from ultralytics import YOLO
        model_path = os.environ.get("YOLO_MODEL_PATH", "yolo11m.pt")
        logging.info("loading YOLO model: %s", model_path)
        return YOLO(model_path)
    except Exception:
        logging.warning("YOLO model unavailable — detection-triggered capture disabled")
        return None


def cmd_human_watch(
    config: AppConfig,
    source_id: str | None,
    interval: float,
    conf_threshold: float,
) -> int:
    import shutil
    import subprocess
    import tempfile
    import time

    from .capture import build_output_path, resolve_rtsp_url
    from .db import SourceDB

    source_db = SourceDB(config.db_path) if config.db_path else None
    all_sources = list(config.sources) + (list(source_db.to_source_configs()) if source_db else [])
    rtsp_sources = [s for s in all_sources if s.type == "rtsp" and s.enabled]

    if not rtsp_sources:
        logging.error("no RTSP sources configured")
        return 1

    if source_id:
        source = next((s for s in rtsp_sources if s.id == source_id), None)
        if not source:
            logging.error("source not found: %s", source_id)
            return 1
    elif len(rtsp_sources) == 1:
        source = rtsp_sources[0]
    else:
        logging.error("multiple sources — specify --source: %s", [s.id for s in rtsp_sources])
        return 1

    url = resolve_rtsp_url(source)
    if not url:
        logging.error("no URL for source %s", source.id)
        return 1

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        logging.error("ffmpeg not found")
        return 1

    from ultralytics import YOLO
    model_path = __import__("os").environ.get("YOLO_MODEL_PATH", "yolo11m.pt")
    logging.info("loading YOLO model: %s", model_path)
    model = YOLO(model_path)

    logging.info("human-watch: source=%s interval=%.1fs conf=%.2f", source.name, interval, conf_threshold)

    saved = 0
    cycle = 0
    while True:
        cycle += 1
        t0 = time.monotonic()

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            r = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error",
                 "-rtsp_transport", source.rtsp_transport,
                 "-y", "-i", url, "-frames:v", "1", "-q:v", "2", str(tmp_path)],
                capture_output=True, timeout=source.timeout_seconds, check=False,
            )
            t_grab = time.monotonic() - t0

            if r.returncode != 0 or not tmp_path.exists() or tmp_path.stat().st_size == 0:
                logging.warning("[%d] grab failed (%.2fs)", cycle, t_grab)
                continue

            t1 = time.monotonic()
            results = model.predict(str(tmp_path), classes=[0], conf=conf_threshold, verbose=False)
            t_infer = time.monotonic() - t1

            boxes = results[0].boxes if results else None
            has_human = bool(boxes and len(boxes))
            top_conf = float(max(boxes.conf.tolist())) if has_human else 0.0

            if has_human:
                out = build_output_path(config, source)
                out.parent.mkdir(parents=True, exist_ok=True)
                if config.filenames.capture_format == "avif":
                    from .capture import _convert_to_avif
                    _convert_to_avif(tmp_path, out)
                else:
                    tmp_path.rename(out)
                saved += 1
                logging.info(
                    "[%d] HUMAN conf=%.2f grab=%.2fs infer=%.2fs total=%.2fs → saved #%d %s",
                    cycle, top_conf, t_grab, t_infer, t_grab + t_infer, saved, out.name,
                )
            else:
                logging.info(
                    "[%d] no human  grab=%.2fs infer=%.2fs total=%.2fs",
                    cycle, t_grab, t_infer, t_grab + t_infer,
                )
        finally:
            tmp_path.unlink(missing_ok=True)

        elapsed = time.monotonic() - t0
        wait = max(0.0, interval - elapsed)
        if wait:
            time.sleep(wait)


def _serve(app, config: AppConfig) -> None:
    from hypercorn.asyncio import serve
    from hypercorn.config import Config as HConfig

    hcfg = HConfig()
    hcfg.loglevel = "WARNING"
    hcfg.accesslog = None

    ssl_cert = config.web.ssl_certfile
    ssl_key  = config.web.ssl_keyfile

    if ssl_cert and ssl_key:
        _ensure_cert(Path(ssl_cert), Path(ssl_key))
        hcfg.certfile = ssl_cert
        hcfg.keyfile  = ssl_key
        hcfg.bind     = [f"{config.web.host}:{config.web.port}"]
        scheme = "https"
    else:
        hcfg.bind = [f"{config.web.host}:{config.web.port}"]
        scheme = "http"

    print(f"Serving on {scheme}://{config.web.host}:{config.web.port}")
    if scheme == "https":
        print("  HTTP/2 enabled — accept the self-signed cert warning in your browser")

    try:
        import uvloop
        uvloop.install()
    except ImportError:
        pass

    asyncio.run(serve(app, hcfg))


def _ensure_cert(certfile: Path, keyfile: Path) -> None:
    if certfile.exists() and keyfile.exists():
        return
    certfile.parent.mkdir(parents=True, exist_ok=True)
    logging.info("generating self-signed TLS certificate → %s", certfile)
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(keyfile), "-out", str(certfile),
            "-days", "3650", "-nodes",
            "-subj", "/CN=eufy-snapshot",
        ],
        check=True, capture_output=True,
    )


def _install_shutdown(callback) -> None:
    stop_once = threading.Event()

    def handler(signum, frame) -> None:
        if stop_once.is_set():
            sys.exit(1)
        stop_once.set()
        callback()

    signal.signal(signal.SIGINT, handler)
    signal.signal(signal.SIGTERM, handler)


if __name__ == "__main__":
    raise SystemExit(main())
