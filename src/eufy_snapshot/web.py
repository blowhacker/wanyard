from __future__ import annotations

import asyncio
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .config import AppConfig
from .index import ImageIndex, ImageItem

_THUMB_W  = 160
_IMG_CACHE = "public, max-age=604800, immutable"


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


def make_app(
    config: AppConfig,
    image_index: ImageIndex,
    source_db=None,
    capture_worker=None,
) -> Starlette:
    import eufy_snapshot
    static_dir = Path(eufy_snapshot.__file__).parent / "static"

    @asynccontextmanager
    async def lifespan(app: Starlette):
        await asyncio.to_thread(image_index.refresh)
        if capture_worker:
            capture_worker.start()

        async def _refresh_loop() -> None:
            while True:
                await asyncio.sleep(max(1, config.web.auto_refresh_seconds))
                await asyncio.to_thread(image_index.refresh)

        task = asyncio.create_task(_refresh_loop())
        try:
            yield
        finally:
            task.cancel()
            if capture_worker:
                await asyncio.to_thread(capture_worker.stop)

    # ── API handlers ──────────────────────────────────────

    async def api_health(request: Request) -> JSONResponse:
        return JSONResponse({
            "ok": True,
            "camera_name": config.camera_name,
            "auto_refresh_seconds": config.web.auto_refresh_seconds,
            "count": len(image_index.items()),
            "latest": _item_to_dict(image_index.latest()),
            "sources": _sources_to_dict(config, image_index, source_db),
            "db_enabled": source_db is not None,
        })

    async def api_sources(request: Request) -> JSONResponse:
        if request.method == "GET":
            return JSONResponse({"sources": _sources_to_dict(config, image_index, source_db)})

        if source_db is None:
            return JSONResponse({"error": "db_path not configured"}, status_code=501)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if not isinstance(body, dict):
            return JSONResponse({"error": "request body must be a JSON object"}, status_code=400)

        name = str(body.get("name", "")).strip()
        url  = str(body.get("url",  "")).strip()
        if not name:
            return JSONResponse({"error": "name is required"}, status_code=400)
        if not url or not (url.startswith("rtsp://") or url.startswith("rtsps://")):
            return JSONResponse({"error": "url must start with rtsp:// or rtsps://"}, status_code=400)

        from .db import RtspSourceRow, make_id
        existing_ids = {s.id for s in config.sources} | source_db.ids()
        source_id = make_id(name, existing_ids)
        interval_raw = body.get("interval_seconds")
        transport = str(body.get("rtsp_transport", "tcp"))
        if transport not in {"tcp", "udp"}:
            transport = "tcp"

        row = RtspSourceRow(
            id=source_id, name=name, url=url,
            interval_seconds=float(interval_raw) if interval_raw is not None else None,
            enabled=True, rtsp_transport=transport,
            timeout_seconds=float(body.get("timeout_seconds", 20)),
            output_subdir=source_id,
        )
        source_db.insert(row)
        updated = source_db.to_source_configs()
        image_index.update_sources(updated)
        new = next(s for s in updated if s.id == source_id)
        return JSONResponse({
            "source": {
                "id": new.id, "name": new.name, "type": "rtsp",
                "enabled": True,
                "interval_seconds": new.interval(config.interval_seconds),
                "mutable": True,
            }
        }, status_code=201)

    async def api_delete_source(request: Request) -> JSONResponse:
        source_id = request.path_params["source_id"]
        if source_db is None:
            return JSONResponse({"error": "db_path not configured"}, status_code=501)
        if not source_db.delete(source_id):
            return JSONResponse({"error": "source not found"}, status_code=404)
        return JSONResponse({"ok": True})

    async def api_images(request: Request) -> JSONResponse:
        source = request.query_params.get("source") or None
        if source == "all":
            source = None
        date = request.query_params.get("date") or None
        return JSONResponse({
            "images": [_item_to_dict(i) for i in image_index.items(date, source)],
            "dates":  image_index.dates(source),
        })

    async def api_images_latest(request: Request) -> JSONResponse:
        source = request.query_params.get("source") or None
        if source == "all":
            source = None
        latest = image_index.latest(source)
        if latest is None:
            return JSONResponse({"image": None}, status_code=404)
        return JSONResponse({"image": _item_to_dict(latest)})

    async def serve_thumb(request: Request) -> Response:
        rel  = unquote(request.path_params["path"])
        src  = image_index.resolve_image_path(rel)
        if src is None:
            return Response(status_code=404)
        dest = image_index.output_dir / ".thumbs" / src.relative_to(image_index.output_dir.resolve())
        if not dest.exists():
            await asyncio.to_thread(_generate_thumb, src, dest)
        serve = dest if dest.exists() else src
        return FileResponse(serve, headers={"Cache-Control": _IMG_CACHE})

    async def serve_image(request: Request) -> Response:
        rel  = unquote(request.path_params["path"])
        path = image_index.resolve_image_path(rel)
        if path is None:
            return Response(status_code=404)
        return FileResponse(path, headers={"Cache-Control": _IMG_CACHE})

    routes = [
        Route("/api/health",                api_health),
        Route("/api/sources",               api_sources,        methods=["GET", "POST"]),
        Route("/api/sources/{source_id}",   api_delete_source,  methods=["DELETE"]),
        Route("/api/images/latest",         api_images_latest),
        Route("/api/images",                api_images),
        Route("/thumbs/{path:path}",        serve_thumb),
        Route("/images/{path:path}",        serve_image),
        Mount("/", StaticFiles(directory=static_dir, html=True)),
    ]

    return Starlette(routes=routes, lifespan=lifespan)


# ── helpers ───────────────────────────────────────────────

def _item_to_dict(item: ImageItem | None) -> dict | None:
    if item is None:
        return None
    return {
        "path":        item.path,
        "url":         item.url,
        "timestamp":   item.timestamp,
        "date":        item.date,
        "source_id":   item.source_id,
        "source_name": item.source_name,
        "size_bytes":  item.size_bytes,
    }


def _sources_to_dict(config: AppConfig, image_index: ImageIndex, source_db=None) -> list:
    result = [
        {
            "id":               s.id,
            "name":             s.name,
            "type":             s.type,
            "enabled":          s.enabled,
            "interval_seconds": s.interval(config.interval_seconds),
            "count":            len(image_index.items(source_id=s.id)),
            "latest":           _item_to_dict(image_index.latest(s.id)),
            "mutable":          False,
        }
        for s in config.sources
    ]
    if source_db is None:
        return result
    cfg_ids = {s.id for s in config.sources}
    for s in source_db.to_source_configs():
        if s.id in cfg_ids:
            continue
        result.append({
            "id":               s.id,
            "name":             s.name,
            "type":             "rtsp",
            "enabled":          s.enabled,
            "interval_seconds": s.interval(config.interval_seconds),
            "count":            len(image_index.items(source_id=s.id)),
            "latest":           _item_to_dict(image_index.latest(s.id)),
            "mutable":          True,
        })
    return result
