from __future__ import annotations

import asyncio
import os
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
    detection_store=None,
    detection_worker=None,
) -> Starlette:
    import eufy_snapshot
    static_dir = Path(eufy_snapshot.__file__).parent / "static"

    @asynccontextmanager
    async def lifespan(app: Starlette):
        await asyncio.to_thread(image_index.refresh)
        if capture_worker:
            capture_worker.start()
        if detection_worker:
            detection_worker.start()
        asyncio.create_task(_register_go2rtc_streams(config, source_db))

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
            if detection_worker:
                await asyncio.to_thread(detection_worker.stop)

    # ── API handlers ──────────────────────────────────────

    async def api_health(request: Request) -> JSONResponse:
        return JSONResponse({
            "ok": True,
            "auto_refresh_seconds": config.web.auto_refresh_seconds,
            "count": len(image_index.items()),
            "latest": _item_to_dict(image_index.latest()),
            "sources": _sources_to_dict(config, image_index, source_db),
            "db_enabled": source_db is not None,
            "detection_enabled": detection_store is not None,
            "detection_stats": detection_store.stats() if detection_store else None,
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
        date       = request.query_params.get("date") or None
        humans_only = request.query_params.get("humans_only") == "1"
        offset_raw = request.query_params.get("offset")

        all_items = image_index.items(date, source)

        det_map: dict = {}
        if detection_store:
            det_map = detection_store.get_many([i.path for i in all_items])
            if humans_only:
                all_items = [i for i in all_items if det_map.get(i.path, {}).get("has_human")]

        if offset_raw is not None:
            try:
                offset = max(0, int(offset_raw))
            except ValueError:
                offset = 0
            items = all_items[offset:]
        else:
            items = all_items

        return JSONResponse({
            "images": [_item_to_dict(i, det_map) for i in items],
            "dates":  image_index.dates(source),
            "total":  len(all_items),
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
        if ".thumbs" in rel.split("/"):
            return Response(status_code=404)
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
        media_type = "image/avif" if path.suffix == ".avif" else None
        return FileResponse(path, headers={"Cache-Control": _IMG_CACHE}, media_type=media_type)

    async def api_export(request: Request) -> Response:
        import os
        import re
        import tempfile
        from starlette.background import BackgroundTask

        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)

        paths       = body.get("paths", [])
        fps         = max(1, min(60, int(body.get("fps", 12))))
        source_name = str(body.get("source_name", "export"))
        start_ts    = str(body.get("start_ts", ""))
        end_ts      = str(body.get("end_ts", ""))
        humans_only = bool(body.get("humans_only", False))

        if not paths:
            return JSONResponse({"error": "no paths provided"}, status_code=400)

        odir = image_index.output_dir
        abs_paths = []
        for p in paths:
            resolved = image_index.resolve_image_path(p)
            if resolved is None:
                return JSONResponse({"error": f"path not found: {p}"}, status_code=400)
            abs_paths.append(str(resolved))

        ffmpeg = shutil.which("ffmpeg")
        out_f  = tempfile.mktemp(suffix=".mp4")
        work_dir = tempfile.mkdtemp()

        def _decode_frame(args):
            idx, src = args
            dst = os.path.join(work_dir, f"{idx:06d}.jpg")
            subprocess.run(
                [ffmpeg, "-y", "-i", src, "-frames:v", "1", "-q:v", "2", dst],
                capture_output=True, timeout=15, check=False,
            )

        from concurrent.futures import ThreadPoolExecutor
        await asyncio.to_thread(
            lambda: list(ThreadPoolExecutor(max_workers=4).map(
                _decode_frame, enumerate(abs_paths)
            ))
        )

        r = await asyncio.to_thread(subprocess.run, [
            ffmpeg, "-y",
            "-framerate", str(fps),
            "-i", os.path.join(work_dir, "%06d.jpg"),
            "-r", str(fps),
            "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
            "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            out_f,
        ], capture_output=True, timeout=300, check=False)

        import shutil as _shutil
        _shutil.rmtree(work_dir, ignore_errors=True)

        if r.returncode != 0 or not os.path.exists(out_f):
            err = r.stderr.decode("utf-8", errors="replace")[-300:]
            return JSONResponse({"error": f"ffmpeg: {err}"}, status_code=500)

        def _cleanup():
            try:
                os.unlink(out_f)
            except OSError:
                pass

        src_slug  = re.sub(r"[^a-z0-9]+", "-", source_name.lower()).strip("-")
        human_tag = "-human" if humans_only else ""
        fname     = f"{src_slug}_{start_ts}_{end_ts}{human_tag}.mp4"
        return FileResponse(out_f, media_type="video/mp4", filename=fname,
                            background=BackgroundTask(_cleanup))

    go2rtc_url = os.environ.get("GO2RTC_URL", "")

    async def api_live(request: Request) -> JSONResponse:
        return JSONResponse({
            "enabled": bool(go2rtc_url),
            "port": 1984,
        })

    routes = [
        Route("/api/health",                api_health),
        Route("/api/live",                  api_live),
        Route("/api/sources",               api_sources,        methods=["GET", "POST"]),
        Route("/api/sources/{source_id}",   api_delete_source,  methods=["DELETE"]),
        Route("/api/images/latest",         api_images_latest),
        Route("/api/export",                api_export,         methods=["POST"]),
        Route("/api/images",                api_images),
        Route("/thumbs/{path:path}",        serve_thumb),
        Route("/images/{path:path}",        serve_image),
        Mount("/", StaticFiles(directory=static_dir, html=True)),
    ]

    return Starlette(routes=routes, lifespan=lifespan)


# ── helpers ───────────────────────────────────────────────

def _item_to_dict(item: ImageItem | None, det_map: dict | None = None) -> dict | None:
    if item is None:
        return None
    det = det_map.get(item.path) if det_map else None
    return {
        "path":        item.path,
        "url":         item.url,
        "timestamp":   item.timestamp,
        "date":        item.date,
        "source_id":   item.source_id,
        "source_name": item.source_name,
        "size_bytes":  item.size_bytes,
        "has_human":   det["has_human"] if det else None,
        "boxes":       det["boxes"]     if det else None,
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


async def _register_go2rtc_streams(config, source_db) -> None:
    import logging
    from .capture import resolve_rtsp_url
    LOG = logging.getLogger(__name__)

    config_dir = os.environ.get("GO2RTC_CONFIG_DIR", "")
    if not config_dir:
        return

    all_sources = list(config.sources)
    if source_db:
        all_sources += list(source_db.to_source_configs())

    stream_lines = []
    for source in all_sources:
        if source.type != "rtsp" or not source.enabled:
            continue
        url = resolve_rtsp_url(source)
        if url:
            stream_lines.append(f"  {source.id}: {url}")

    if not stream_lines:
        return

    yaml_content = (
        "api:\n  origin: '*'\n\n"
        "webrtc:\n  candidates:\n    - stun:8555\n\n"
        "streams:\n" + "\n".join(stream_lines) + "\n"
    )
    config_path = Path(config_dir) / "go2rtc.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml_content)
    LOG.info("wrote go2rtc config: %d streams", len(stream_lines))
