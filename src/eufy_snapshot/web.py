from __future__ import annotations

import json
import mimetypes
import shutil
import subprocess
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .config import AppConfig
from .index import ImageIndex, ImageItem

_THUMB_W = 160  # thumbnail width in pixels


def _generate_thumb(src: Path, dest: Path) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run(
            [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(src), "-vf", f"scale={_THUMB_W}:-2",
             "-frames:v", "1", "-q:v", "6", str(dest)],
            capture_output=True, timeout=15, check=False,
        )
        return r.returncode == 0 and dest.exists()
    except (subprocess.TimeoutExpired, OSError):
        return False


class SnapshotWebServer:
    def __init__(self, config: AppConfig, image_index: ImageIndex, source_db=None) -> None:
        self.config = config
        self.image_index = image_index
        self.source_db = source_db
        self.httpd = ThreadingHTTPServer(
            (config.web.host, config.web.port),
            self._handler_class(),
        )

    def serve_forever(self) -> None:
        self.image_index.refresh()
        refresher = threading.Thread(target=self._refresh_loop, daemon=True, name="index-refresh")
        refresher.start()
        self.httpd.serve_forever()

    def shutdown(self) -> None:
        self.httpd.shutdown()

    def _refresh_loop(self) -> None:
        while True:
            time.sleep(max(1, self.config.web.auto_refresh_seconds))
            self.image_index.refresh()

    def _handler_class(self) -> type[BaseHTTPRequestHandler]:
        image_index = self.image_index
        config = self.config
        source_db = self.source_db

        class Handler(BaseHTTPRequestHandler):
            server_version = "EufySnapshot/0.1"

            def do_GET(self) -> None:
                parsed = urlparse(self.path)
                if parsed.path == "/api/health":
                    self._json(
                        {
                            "ok": True,
                            "camera_name": config.camera_name,
                            "auto_refresh_seconds": config.web.auto_refresh_seconds,
                            "count": len(image_index.items()),
                            "latest": _item_to_dict(image_index.latest()),
                            "sources": _sources_to_dict(config, image_index, source_db),
                            "db_enabled": source_db is not None,
                        }
                    )
                elif parsed.path == "/api/sources":
                    self._json({"sources": _sources_to_dict(config, image_index, source_db)})
                elif parsed.path == "/api/images":
                    params = parse_qs(parsed.query)
                    date = params.get("date", [None])[0]
                    source = _source_param(params)
                    self._json(
                        {
                            "images": [_item_to_dict(item) for item in image_index.items(date, source)],
                            "dates": image_index.dates(source),
                        }
                    )
                elif parsed.path == "/api/images/latest":
                    params = parse_qs(parsed.query)
                    latest = image_index.latest(_source_param(params))
                    if latest is None:
                        self._json({"image": None}, HTTPStatus.NOT_FOUND)
                    else:
                        self._json({"image": _item_to_dict(latest)})
                elif parsed.path.startswith("/thumbs/"):
                    rel = unquote(parsed.path.removeprefix("/thumbs/"))
                    src = image_index.resolve_image_path(rel)
                    if src is None:
                        self.send_error(HTTPStatus.NOT_FOUND)
                    else:
                        dest = image_index.output_dir / ".thumbs" / src.relative_to(image_index.output_dir.resolve())
                        if not dest.exists():
                            _generate_thumb(src, dest)
                        self._file(dest if dest.exists() else src)
                elif parsed.path.startswith("/images/"):
                    rel = unquote(parsed.path.removeprefix("/images/"))
                    self._file(image_index.resolve_image_path(rel))
                elif parsed.path in ("/", "/index.html"):
                    self._static("index.html")
                elif parsed.path in ("/app.css", "/app.js"):
                    self._static(parsed.path.removeprefix("/"))
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)

            def do_POST(self) -> None:
                parsed = urlparse(self.path)
                if parsed.path == "/api/sources":
                    self._handle_create_source()
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)

            def do_DELETE(self) -> None:
                parsed = urlparse(self.path)
                if parsed.path.startswith("/api/sources/"):
                    source_id = unquote(parsed.path.removeprefix("/api/sources/"))
                    self._handle_delete_source(source_id)
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)

            def _handle_create_source(self) -> None:
                if source_db is None:
                    self._json({"error": "db_path not configured"}, HTTPStatus.NOT_IMPLEMENTED)
                    return
                try:
                    body = self._read_json()
                except ValueError as exc:
                    self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
                    return

                name = str(body.get("name", "")).strip()
                url = str(body.get("url", "")).strip()
                if not name:
                    self._json({"error": "name is required"}, HTTPStatus.BAD_REQUEST)
                    return
                if not url or not (url.startswith("rtsp://") or url.startswith("rtsps://")):
                    self._json({"error": "url must start with rtsp:// or rtsps://"}, HTTPStatus.BAD_REQUEST)
                    return

                from .db import RtspSourceRow, make_id

                existing_ids = {s.id for s in config.sources} | source_db.ids()
                source_id = make_id(name, existing_ids)
                interval_raw = body.get("interval_seconds")
                interval = float(interval_raw) if interval_raw is not None else None
                transport = str(body.get("rtsp_transport", "tcp"))
                if transport not in {"tcp", "udp"}:
                    transport = "tcp"
                timeout = float(body.get("timeout_seconds", 20))

                row = RtspSourceRow(
                    id=source_id,
                    name=name,
                    url=url,
                    interval_seconds=interval,
                    enabled=True,
                    rtsp_transport=transport,
                    timeout_seconds=timeout,
                    output_subdir=source_id,
                )
                source_db.insert(row)
                source_configs = source_db.to_source_configs()
                image_index.update_sources(source_configs)
                new_source = next(s for s in source_configs if s.id == source_id)
                self._json(
                    {
                        "source": {
                            "id": new_source.id,
                            "name": new_source.name,
                            "type": "rtsp",
                            "enabled": True,
                            "interval_seconds": new_source.interval(config.interval_seconds),
                            "mutable": True,
                        }
                    },
                    HTTPStatus.CREATED,
                )

            def _handle_delete_source(self, source_id: str) -> None:
                if source_db is None:
                    self._json({"error": "db_path not configured"}, HTTPStatus.NOT_IMPLEMENTED)
                    return
                deleted = source_db.delete(source_id)
                if not deleted:
                    self._json({"error": "source not found"}, HTTPStatus.NOT_FOUND)
                    return
                self._json({"ok": True})

            def _read_json(self) -> dict:
                length = int(self.headers.get("Content-Length", 0))
                if length == 0:
                    return {}
                raw = self.rfile.read(length)
                try:
                    data = json.loads(raw.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    raise ValueError(f"invalid JSON: {exc}") from exc
                if not isinstance(data, dict):
                    raise ValueError("request body must be a JSON object")
                return data

            def log_message(self, fmt: str, *args: object) -> None:
                return

            def _json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _file(self, path: Path | None) -> None:
                if path is None:
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
                data = path.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=604800, immutable")
                self.end_headers()
                self.wfile.write(data)

            def _static(self, name: str) -> None:
                ref = resources.files("eufy_snapshot.static").joinpath(name)
                if not ref.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                data = ref.read_bytes()
                mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        return Handler


def _item_to_dict(item: ImageItem | None) -> dict[str, object] | None:
    if item is None:
        return None
    return {
        "path": item.path,
        "url": item.url,
        "timestamp": item.timestamp,
        "date": item.date,
        "source_id": item.source_id,
        "source_name": item.source_name,
        "size_bytes": item.size_bytes,
    }


def _source_param(params: dict[str, list[str]]) -> str | None:
    source = params.get("source", [None])[0]
    if not source or source == "all":
        return None
    return source


def _sources_to_dict(
    config: AppConfig,
    image_index: ImageIndex,
    source_db=None,
) -> list[dict[str, object]]:
    result = [
        {
            "id": source.id,
            "name": source.name,
            "type": source.type,
            "enabled": source.enabled,
            "interval_seconds": source.interval(config.interval_seconds),
            "count": len(image_index.items(source_id=source.id)),
            "latest": _item_to_dict(image_index.latest(source.id)),
            "mutable": False,
        }
        for source in config.sources
    ]
    if source_db is None:
        return result
    cfg_ids = {s.id for s in config.sources}
    for s in source_db.to_source_configs():
        if s.id in cfg_ids:
            continue
        result.append(
            {
                "id": s.id,
                "name": s.name,
                "type": "rtsp",
                "enabled": s.enabled,
                "interval_seconds": s.interval(config.interval_seconds),
                "count": len(image_index.items(source_id=s.id)),
                "latest": _item_to_dict(image_index.latest(s.id)),
                "mutable": True,
            }
        )
    return result
