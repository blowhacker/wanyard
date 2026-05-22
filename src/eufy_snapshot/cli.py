from __future__ import annotations

import argparse
import asyncio
import logging
import os
import signal
import sys
from pathlib import Path

from .config import AppConfig, load_config
from .db import SourceDB
from .runner import CaptureWorker
from .video import VideoSegmentDB, VideoWorker
from .web import make_app


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logging.basicConfig(level=getattr(logging, args.log_level),
                        format="%(asctime)s %(levelname)s %(message)s")
    config = load_config(args.config)
    if args.command == "serve":
        return cmd_serve(config)
    if args.command == "yolo-serve":
        return cmd_yolo_serve()
    parser.print_help()
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="eufy-snapshot")
    parser.add_argument("-c", "--config", default="config.yaml")
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve",      help="web server + RTSP recording")
    sub.add_parser("yolo-serve", help="YOLO inference + backfill (separate process/container)")
    return parser


def cmd_serve(config: AppConfig) -> int:
    source_db   = SourceDB(config.db_path) if config.db_path else None
    all_sources = config.sources + (source_db.to_source_configs() if source_db else ())

    video_dir    = Path(os.environ.get("VIDEO_DIR", "video"))
    video_db     = VideoSegmentDB(video_dir / "video.db")
    video_workers = {
        s.id: VideoWorker(s, video_dir, video_db)
        for s in all_sources if s.type == "rtsp" and s.enabled
    }
    capture_worker = CaptureWorker(config, video_workers=video_workers)

    app = make_app(config, source_db=source_db,
                   video_dir=video_dir, video_db=video_db,
                   video_workers=video_workers,
                   capture_worker=capture_worker)
    _serve(app, config)
    return 0


def cmd_yolo_serve() -> int:
    from . import yolo_server
    video_dir = Path(os.environ.get("VIDEO_DIR", "video"))
    yolo_server.run(video_dir / "video.db", video_dir)
    return 0


def _serve(app, config: AppConfig) -> None:
    from hypercorn.asyncio import serve
    from hypercorn.config import Config as HConfig

    hcfg = HConfig()
    hcfg.loglevel = "WARNING"
    hcfg.accesslog = None
    hcfg.bind = [f"{config.web.host}:{config.web.port}"]

    print(f"Serving on http://{config.web.host}:{config.web.port}")
    try:
        import uvloop
        uvloop.install()
    except ImportError:
        pass
    asyncio.run(serve(app, hcfg))
