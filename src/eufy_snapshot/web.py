from __future__ import annotations

import json
import mimetypes
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .config import AppConfig
from .index import ImageIndex, ImageItem


class SnapshotWebServer:
    def __init__(self, config: AppConfig, image_index: ImageIndex) -> None:
        self.config = config
        self.image_index = image_index
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
                        }
                    )
                elif parsed.path == "/api/images":
                    params = parse_qs(parsed.query)
                    date = params.get("date", [None])[0]
                    self._json(
                        {
                            "images": [_item_to_dict(item) for item in image_index.items(date)],
                            "dates": image_index.dates(),
                        }
                    )
                elif parsed.path == "/api/images/latest":
                    latest = image_index.latest()
                    if latest is None:
                        self._json({"image": None}, HTTPStatus.NOT_FOUND)
                    else:
                        self._json({"image": _item_to_dict(latest)})
                elif parsed.path.startswith("/images/"):
                    rel = unquote(parsed.path.removeprefix("/images/"))
                    self._file(image_index.resolve_image_path(rel))
                elif parsed.path in ("/", "/index.html"):
                    self._static("index.html")
                elif parsed.path in ("/app.css", "/app.js"):
                    self._static(parsed.path.removeprefix("/"))
                else:
                    self.send_error(HTTPStatus.NOT_FOUND)

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
                self.send_header("Cache-Control", "no-store")
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
        "size_bytes": item.size_bytes,
    }
