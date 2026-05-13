from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import subprocess
import sys
import threading
from pathlib import Path

from .capture import capture_once, save_debug_screencap
from .config import AppConfig, load_config
from .db import SourceDB
from .detect import DetectionStore, DetectionWorker
from .doctor import run_doctor
from .index import ImageIndex
from .runner import CaptureWorker, run_loop
from .web import make_app


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level), format="%(asctime)s %(levelname)s %(message)s")
    config = load_config(args.config)
    if args.command == "doctor":
        return cmd_doctor(config)
    if args.command == "capture-once":
        return cmd_capture_once(config, args.source)
    if args.command == "run":
        run_loop(config, source_id=args.source)
        return 0
    if args.command == "web":
        return cmd_web(config)
    if args.command == "serve":
        return cmd_serve(config)
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
    sub.add_parser("doctor", help="check emulator, Android version, and Eufy install")
    capture_parser = sub.add_parser("capture-once", help="capture one snapshot from configured source(s)")
    capture_parser.add_argument("--source", help="capture only this source id")
    run_parser = sub.add_parser("run", help="run the capture daemon only")
    run_parser.add_argument("--source", help="poll only this source id")
    sub.add_parser("web", help="run the web viewer only")
    sub.add_parser("serve", help="run capture daemon and web viewer together")
    return parser


def cmd_doctor(config: AppConfig) -> int:
    checks = run_doctor(config)
    exit_code = 0
    for check in checks:
        print(f"{check.level.upper()}: {check.message}")
        if check.level == "error":
            exit_code = 1
    return exit_code


def cmd_capture_once(config: AppConfig, source_id: str | None = None) -> int:
    sources = config.enabled_sources()
    if source_id:
        source = config.source_by_id(source_id)
        if source is None:
            logging.error("unknown source: %s", source_id)
            return 1
        sources = (source,)
    exit_code = 0
    for source in sources:
        try:
            result = capture_once(config, source)
        except TimeoutError:
            logging.exception("capture timed out for %s", source.name)
            if source.type == "eufy_native" and source.capture.debug_screencap_on_failure:
                try:
                    save_debug_screencap(config)
                except Exception:
                    logging.exception("failed to save debug screencap")
            exit_code = 1
            continue
        except Exception:
            logging.exception("capture failed for %s", source.name)
            exit_code = 1
            continue
        print(result.output_path)
    return exit_code


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
    worker = CaptureWorker(config, image_index, source_db=source_db)
    app = make_app(
        config, image_index, source_db=source_db, capture_worker=worker,
        detection_store=det_store, detection_worker=det_worker,
    )
    _serve(app, config)
    return 0


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
