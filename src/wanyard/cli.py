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
from .video import VideoSegmentDB


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
    if args.command == "rebuild-events":
        return cmd_rebuild_events(args)
    parser.print_help()
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="wanyard")
    parser.add_argument("-c", "--config", default="config.yaml")
    parser.add_argument("--log-level", default="INFO",
                        choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve",      help="web server + RTSP recording")
    sub.add_parser("yolo-serve", help="YOLO inference + backfill (separate process/container)")
    rebuild = sub.add_parser("rebuild-events", help="rebuild video events from stored detections")
    rebuild.add_argument("--source", default=None, help="source id to rebuild, for example tapo-garden")
    rebuild.add_argument("--since", type=float, default=None, help="Unix timestamp lower bound")
    rebuild.add_argument("--until", type=float, default=None, help="Unix timestamp upper bound")
    rebuild.add_argument("--keep-vehicle-tracks", action="store_true",
                         help="do not clear persisted vehicle tracking state before rebuilding")
    return parser


def cmd_serve(config: AppConfig) -> int:
    from .web import make_app

    source_db      = SourceDB(config.db_path) if config.db_path else None
    video_dir      = Path(os.environ.get("VIDEO_DIR", "video"))
    video_db       = VideoSegmentDB(video_dir / "video.db")
    capture_worker = CaptureWorker(source_db, video_dir, video_db)

    app = make_app(config, source_db=source_db,
                   video_dir=video_dir, video_db=video_db,
                   capture_worker=capture_worker)
    _serve(app, config)
    return 0


def cmd_yolo_serve() -> int:
    from . import yolo_server
    video_dir = Path(os.environ.get("VIDEO_DIR", "video"))
    yolo_server.run(video_dir / "video.db", video_dir)
    return 0


def cmd_rebuild_events(args) -> int:
    from .video import VideoSegmentDB, rebuild_events

    video_dir = Path(os.environ.get("VIDEO_DIR", "video"))
    db = VideoSegmentDB(video_dir / "video.db")
    stats = rebuild_events(
        db,
        source_id=args.source,
        since=args.since,
        until=args.until,
        reset_vehicle_tracks=not args.keep_vehicle_tracks,
    )
    print(
        "rebuilt events:"
        f" segments={stats['segments']}"
        f" with_detections={stats['segments_with_detections']}"
        f" events={stats['events']}"
    )
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
