from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import unquote

from starlette.applications import Starlette
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .config import AppConfig

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


def _probe_video_size(path: Path) -> tuple[int, int] | None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        r = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x",
             str(path)],
            capture_output=True, timeout=5, check=False, text=True,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if r.returncode != 0:
        return None
    raw = r.stdout.strip().splitlines()[0] if r.stdout.strip() else ""
    try:
        w, h = (int(x) for x in raw.split("x", 1))
    except ValueError:
        return None
    return (w, h) if w > 0 and h > 0 else None


def _select_event_box(boxes: list, cls: str) -> dict | None:
    candidates = [b for b in boxes if isinstance(b, dict)]
    if not candidates:
        return None
    matching = [b for b in candidates if b.get("cls") == cls] or candidates

    def score(box: dict) -> tuple[float, float]:
        try:
            area = max(0.0, float(box["x2"]) - float(box["x1"])) * \
                   max(0.0, float(box["y2"]) - float(box["y1"]))
        except (KeyError, TypeError, ValueError):
            area = 0.0
        try:
            conf = float(box.get("conf", 0.0))
        except (TypeError, ValueError):
            conf = 0.0
        return conf, area

    return max(matching, key=score)


def _crop_from_box(box: dict, frame_w: int, frame_h: int,
                   aspect: float = 4 / 3) -> tuple[int, int, int, int] | None:
    try:
        x1 = max(0.0, min(1.0, float(box["x1"]))) * frame_w
        y1 = max(0.0, min(1.0, float(box["y1"]))) * frame_h
        x2 = max(0.0, min(1.0, float(box["x2"]))) * frame_w
        y2 = max(0.0, min(1.0, float(box["y2"]))) * frame_h
    except (KeyError, TypeError, ValueError):
        return None
    if x2 <= x1 or y2 <= y1:
        return None

    bw, bh = x2 - x1, y2 - y1
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    pad = max(24.0, max(bw, bh) * 0.45)
    cw, ch = bw + pad * 2, bh + pad * 2
    if cw / ch < aspect:
        cw = ch * aspect
    else:
        ch = cw / aspect
    cw = min(float(frame_w), max(96.0, cw))
    ch = min(float(frame_h), max(72.0, ch))
    if cw / ch < aspect:
        cw = min(float(frame_w), ch * aspect)
    else:
        ch = min(float(frame_h), cw / aspect)

    rw = min(frame_w, max(2, round(cw)))
    rh = min(frame_h, max(2, round(ch)))
    x = max(0.0, min(float(frame_w - rw), cx - rw / 2))
    y = max(0.0, min(float(frame_h - rh), cy - rh / 2))
    return round(x), round(y), rw, rh


def _extract_video_thumb(seg_path: Path, cache_file: Path, t: float,
                         crop_box: dict | None = None) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False

    vf = None
    if crop_box:
        size = _probe_video_size(seg_path)
        crop = _crop_from_box(crop_box, *size) if size else None
        if crop:
            x, y, w, h = crop
            vf = (
                f"crop={w}:{h}:{x}:{y},"
                "scale=176:132:force_original_aspect_ratio=increase,"
                "crop=176:132"
            )

    cache_file.parent.mkdir(parents=True, exist_ok=True)
    for attempt_t in [t, max(0, t - 1), max(0, t - 2), max(0, t - 5)]:
        cmd = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-ss", str(attempt_t), "-i", str(seg_path),
        ]
        if vf:
            cmd += ["-vf", vf]
        cmd += ["-frames:v", "1", "-q:v", "5", str(cache_file)]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=10, check=False)
        except (subprocess.TimeoutExpired, OSError):
            r = None
        if r and r.returncode == 0 and cache_file.exists() and cache_file.stat().st_size > 0:
            return True
    try:
        cache_file.unlink(missing_ok=True)
    except OSError:
        pass
    return False


async def _register_go2rtc_streams(config, source_db) -> None:
    import logging as _log
    from .capture import resolve_rtsp_url
    _L = _log.getLogger(__name__)
    config_dir = os.environ.get("GO2RTC_CONFIG_DIR", "")
    if not config_dir:
        return
    all_sources = list(config.sources) + (list(source_db.to_source_configs()) if source_db else [])
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
        "api:\n  origin: '*'\n\nwebrtc:\n  candidates:\n    - stun:8555\n\nstreams:\n"
        + "\n".join(stream_lines) + "\n"
    )
    config_path = Path(config_dir) / "go2rtc.yaml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml_content)
    _L.info("wrote go2rtc config: %d streams", len(stream_lines))


def make_app(
    config: AppConfig,
    source_db=None,
    video_dir=None,
    video_db=None,
    video_workers=None,
    capture_worker=None,
) -> Starlette:
    import eufy_snapshot
    static_dir = Path(eufy_snapshot.__file__).parent / "static"

    @asynccontextmanager
    async def lifespan(app: Starlette):
        asyncio.create_task(_register_go2rtc_streams(config, source_db))
        if capture_worker:
            capture_worker.start()
        try:
            yield
        finally:
            if capture_worker:
                await asyncio.to_thread(capture_worker.stop)

    # ── API handlers ──────────────────────────────────────

    async def api_health(request: Request) -> JSONResponse:
        return JSONResponse({"ok": True})

    async def api_sources(request: Request) -> JSONResponse:
        if request.method == "GET":
            return JSONResponse({"sources": _sources_list(config, source_db)})

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

    async def api_thumb(request: Request) -> Response:
        """Extract a single frame from a video file at timestamp t."""
        if not video_dir:
            return Response(status_code=404)
        event_id = request.query_params.get("event_id")
        if event_id:
            return await _serve_event_thumb(event_id)
        rel = request.query_params.get("path", "")
        t   = float(request.query_params.get("t", 0))
        if ".." in rel or not rel:
            return Response(status_code=400)
        seg_path = (video_dir / rel).resolve()
        if not seg_path.is_file():
            return Response(status_code=404)

        # Disk cache alongside segment
        cache_dir  = seg_path.parent / ".thumbcache"
        cache_file = cache_dir / f"{seg_path.stem}_{t:.1f}.jpg"

        if not cache_file.exists():
            ok = await asyncio.to_thread(_extract_video_thumb, seg_path, cache_file, t)
            if not ok:
                return Response(status_code=404)

        return FileResponse(cache_file, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=604800, immutable"})

    async def _serve_event_thumb(event_id_raw: str) -> Response:
        if not video_dir or not video_db:
            return Response(status_code=404)
        try:
            event_id = int(event_id_raw)
        except ValueError:
            return Response(status_code=400)
        evt = await asyncio.to_thread(video_db.get_event_with_segment, event_id)
        if not evt:
            return Response(status_code=404)

        seg_path = (video_dir / evt["seg_path"]).resolve()
        try:
            seg_path.relative_to(video_dir.resolve())
        except ValueError:
            return Response(status_code=403)
        if not seg_path.is_file():
            return Response(status_code=404)

        t = max(0.0, float(evt["abs_ts"]) - float(evt["seg_start_ts"]))
        try:
            boxes = json.loads(evt["boxes_json"]) if evt.get("boxes_json") else []
        except (TypeError, json.JSONDecodeError):
            boxes = []
        box = _select_event_box(boxes, evt.get("class", ""))

        cache_dir = seg_path.parent / ".thumbcache"
        cache_file = cache_dir / f"event_{event_id}_crop_v1.jpg"
        if not cache_file.exists():
            ok = await asyncio.to_thread(_extract_video_thumb, seg_path, cache_file, t, box)
            if not ok:
                return Response(status_code=404)

        return FileResponse(cache_file, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=604800, immutable"})

    async def api_video_event_thumb(request: Request) -> Response:
        return await _serve_event_thumb(request.path_params["event_id"])

    async def api_video_segment_at(request: Request) -> JSONResponse:
        """Fast single-segment lookup by timestamp — for instant URL-based seek."""
        if not video_db:
            return JSONResponse({"segment": None})
        try:
            ts = float(request.query_params["ts"])
        except (KeyError, ValueError):
            return JSONResponse({"error": "ts required"}, status_code=400)
        source_id = request.query_params.get("source") or None
        with video_db._connect() as conn:
            where = "start_ts <= ? AND end_ts > ? AND end_ts IS NOT NULL"
            params = [ts, ts]
            if source_id:
                where += " AND source_id = ?"
                params.append(source_id)
            row = conn.execute(
                f"SELECT * FROM segments WHERE {where} ORDER BY start_ts DESC LIMIT 1",
                params
            ).fetchone()
            if not row:
                # Nearest closed segment before ts
                where2 = "end_ts IS NOT NULL AND end_ts <= ?"
                params2 = [ts]
                if source_id:
                    where2 += " AND source_id = ?"
                    params2.append(source_id)
                row = conn.execute(
                    f"SELECT * FROM segments WHERE {where2} ORDER BY end_ts DESC LIMIT 1",
                    params2
                ).fetchone()
        return JSONResponse({"segment": dict(row) if row else None})

    def _build_timeline(source_id):
        segs = video_db.list_segments(source_id)
        with video_db._connect() as conn:
            rows = conn.execute(
                "SELECT segment_id, class, COUNT(*) as n"
                " FROM video_events GROUP BY segment_id, class"
            ).fetchall()
        summary: dict[int, dict] = {}
        for r in rows:
            summary.setdefault(r["segment_id"], {})[r["class"]] = r["n"]
        for evt in video_db.provisional_events(source_id):
            summary.setdefault(evt["segment_id"], {})[evt["class"]] = (
                summary.setdefault(evt["segment_id"], {}).get(evt["class"], 0) + 1
            )
        for s in segs:
            s["classes"] = summary.get(s["id"], {})
        return segs

    async def api_video2_timeline(request: Request) -> JSONResponse:
        """Segments list for the video2 filmstrip."""
        if not video_db:
            return JSONResponse({"segments": []})
        source_id = request.query_params.get("source") or None
        segs = await asyncio.to_thread(_build_timeline, source_id)
        return JSONResponse({"segments": segs})

    async def api_video_events(request: Request) -> JSONResponse:
        if not video_db:
            return JSONResponse({"events": []})
        source_id = request.query_params.get("source") or None
        cls       = request.query_params.get("class")  or None
        classes_raw = request.query_params.get("classes") or None
        date      = request.query_params.get("date")   or None
        limit     = int(request.query_params.get("limit", 100))
        around_raw = request.query_params.get("around")
        if around_raw:
            classes = None
            if classes_raw:
                classes = [c for c in classes_raw.split(",") if c and c != "all"]
            elif cls and cls != "all":
                classes = [cls]
            events = await asyncio.to_thread(
                video_db.nearest_events, float(around_raw), source_id, classes, limit
            )
            provisional = await asyncio.to_thread(video_db.provisional_events, source_id)
            if classes:
                wanted = set(classes)
                provisional = [e for e in provisional if e["class"] in wanted]
            events = events + provisional
            around = float(around_raw)
            events.sort(key=lambda e: (abs(e["abs_ts"] - around), e["abs_ts"]))
            events = events[:limit]
            for e in events: e.pop("boxes_json", None)
            return JSONResponse({"events": events})
        since_raw = request.query_params.get("since")
        until_raw = request.query_params.get("until")
        since     = float(since_raw) if since_raw else None
        until     = float(until_raw) if until_raw else None
        events = await asyncio.to_thread(
            video_db.list_events, source_id, cls, date, limit, since, until
        )
        provisional = await asyncio.to_thread(video_db.provisional_events, source_id, since)
        if cls and cls != "all":
            provisional = [e for e in provisional if e["class"] == cls]
        events = provisional + events
        events.sort(key=lambda e: e["abs_ts"], reverse=True)
        events = events[:limit]
        for e in events: e.pop("boxes_json", None)
        return JSONResponse({"events": events})

    async def api_video_class_counts(request: Request) -> JSONResponse:
        if not video_db:
            return JSONResponse({"classes": {}})
        source_id = request.query_params.get("source") or None
        counts = await asyncio.to_thread(video_db.class_counts, source_id)
        return JSONResponse({"classes": counts})

    async def api_video_segments(request: Request) -> JSONResponse:
        if not video_db:
            return JSONResponse({"segments": []})
        source_id = request.query_params.get("source") or None
        segs = await asyncio.to_thread(video_db.list_segments, source_id)
        return JSONResponse({"segments": segs})

    async def api_video_detections(request: Request) -> JSONResponse:
        if not video_db:
            return JSONResponse({"detections": []})
        seg_id = request.query_params.get("segment_id")
        if not seg_id:
            return JSONResponse({"error": "segment_id required"}, status_code=400)
        dets = await asyncio.to_thread(video_db.detections_for_segment, int(seg_id))
        return JSONResponse({"detections": dets})

    async def api_video_live_status(request: Request) -> JSONResponse:
        if not video_db:
            return JSONResponse({"segments": [], "events": [], "detections": []})
        source_id = request.query_params.get("source") or None
        status = await asyncio.to_thread(video_db.live_status, source_id)
        return JSONResponse(status)

    async def serve_video_file(request: Request) -> Response:
        if not video_dir:
            return Response(status_code=404)
        rel = unquote(request.path_params["path"])
        if ".." in rel:
            return Response(status_code=403)
        path = (video_dir / rel).resolve()
        if not path.is_file():
            return Response(status_code=404)
        suffix = path.suffix.lower()
        media = {"mp4": "video/mp4", "jpg": "image/jpeg", "vtt": "text/vtt"}.get(suffix[1:])
        headers = {"Accept-Ranges": "bytes"}
        if suffix == ".mp4":
            headers["Cache-Control"] = "no-cache"
        return FileResponse(path, media_type=media, headers=headers)

    async def api_settings_status(request: Request) -> JSONResponse:
        import shutil as _shutil
        disk = _shutil.disk_usage(video_dir or Path("."))
        pending = 0
        total_segs = 0
        latest_event_ts = None
        if video_db:
            with video_db._connect() as conn:
                pending = conn.execute(
                    "SELECT COUNT(*) FROM segments s WHERE s.end_ts IS NOT NULL"
                    " AND NOT EXISTS (SELECT 1 FROM video_detections WHERE segment_id=s.id)"
                ).fetchone()[0]
                total_segs = conn.execute(
                    "SELECT COUNT(*) FROM segments WHERE end_ts IS NOT NULL"
                ).fetchone()[0]
                row = conn.execute(
                    "SELECT MAX(abs_ts) FROM video_events"
                ).fetchone()
                latest_event_ts = row[0] if row else None
        # Check yolo-serve socket
        yolo_ok = False
        try:
            import socket as _sock, json as _json
            s = _sock.socket(_sock.AF_UNIX, _sock.SOCK_STREAM)
            s.settimeout(1.0)
            s.connect(os.environ.get("YOLO_SOCKET", "/tmp/yolo.sock"))
            s.sendall(b'{"type":"ping"}\n')
            resp = s.recv(256)
            s.close()
            yolo_ok = b'"ok"' in resp
        except Exception:
            pass
        # Disk usage per source
        source_sizes = {}
        if video_dir:
            for src_dir in video_dir.iterdir():
                if src_dir.is_dir() and not src_dir.name.startswith(".") and src_dir.name != "live":
                    try:
                        total = sum(f.stat().st_size for f in src_dir.rglob("*.mp4"))
                        source_sizes[src_dir.name] = total
                    except Exception:
                        pass
        return JSONResponse({
            "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
            "video_dir": str(video_dir) if video_dir else None,
            "source_sizes": source_sizes,
            "segments": total_segs,
            "backfill_pending": pending,
            "yolo_connected": yolo_ok,
            "latest_event_ts": latest_event_ts,
        })

    async def api_settings_camera_test(request: Request) -> Response:
        """Grab a single frame from an RTSP URL and return it as JPEG."""
        try:
            body = await request.json()
            url  = str(body.get("url", "")).strip()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if not url.startswith(("rtsp://", "rtsps://")):
            return JSONResponse({"error": "url must start with rtsp://"}, status_code=400)
        import tempfile as _tmp
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return JSONResponse({"error": "ffmpeg not available"}, status_code=500)
        with _tmp.NamedTemporaryFile(suffix=".jpg", delete=False) as tf:
            out = Path(tf.name)
        try:
            r = subprocess.run(
                [ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
                 "-rtsp_transport", "tcp", "-i", url,
                 "-frames:v", "1", "-q:v", "5", str(out)],
                capture_output=True, timeout=10, check=False,
            )
            if r.returncode != 0 or not out.exists() or out.stat().st_size == 0:
                return JSONResponse({"error": "could not connect or read frame"}, status_code=502)
            return Response(out.read_bytes(), media_type="image/jpeg")
        except subprocess.TimeoutExpired:
            return JSONResponse({"error": "connection timed out"}, status_code=504)
        finally:
            out.unlink(missing_ok=True)

    async def api_settings_cleanup(request: Request) -> JSONResponse:
        """Delete segments (and their data) older than N days."""
        if not video_db or not video_dir:
            return JSONResponse({"error": "video not configured"}, status_code=501)
        try:
            body  = await request.json()
            days  = int(body.get("days", 30))
            src   = body.get("source_id") or None
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        cutoff = __import__("time").time() - days * 86400
        with video_db._connect() as conn:
            where = "end_ts IS NOT NULL AND end_ts < ?"
            params: list = [cutoff]
            if src:
                where += " AND source_id = ?"
                params.append(src)
            segs = [dict(r) for r in conn.execute(
                f"SELECT id, path FROM segments WHERE {where}", params
            ).fetchall()]
        deleted_files = deleted_bytes = 0
        seg_ids = []
        for seg in segs:
            seg_ids.append(seg["id"])
            p = video_dir / seg["path"]
            try:
                if p.exists():
                    deleted_bytes += p.stat().st_size
                    p.unlink()
                    deleted_files += 1
                # Remove spritesheet dir
                sprite_dir = p.with_suffix("")
                if sprite_dir.is_dir():
                    import shutil as _sh
                    _sh.rmtree(sprite_dir, ignore_errors=True)
            except Exception:
                pass
        if seg_ids:
            with video_db._connect() as conn:
                placeholders = ",".join("?" * len(seg_ids))
                conn.execute(f"DELETE FROM video_events WHERE segment_id IN ({placeholders})", seg_ids)
                conn.execute(f"DELETE FROM video_detections WHERE segment_id IN ({placeholders})", seg_ids)
                conn.execute(f"DELETE FROM segments WHERE id IN ({placeholders})", seg_ids)
        return JSONResponse({
            "deleted_segments": len(seg_ids),
            "deleted_files": deleted_files,
            "freed_bytes": deleted_bytes,
        })

    async def serve_live_hls(request: Request) -> Response:
        source_id = request.path_params.get("source_id", "")
        filename  = request.path_params.get("filename", "")
        if not video_dir or not source_id or ".." in source_id or ".." in filename:
            return Response(status_code=404)
        path = video_dir / "live" / source_id / filename
        if not path.exists():
            return Response(status_code=404)
        media = "application/vnd.apple.mpegurl" if filename.endswith(".m3u8") else "video/mp2t"
        return FileResponse(path, media_type=media,
                            headers={"Cache-Control": "no-cache, no-store"})

    routes = [
        Route("/",                           lambda r: FileResponse(static_dir / "video2.html")),
        Route("/settings",                  lambda r: FileResponse(static_dir / "settings.html")),
        Route("/api/health",                api_health),
        Route("/api/thumb",                 api_thumb),
        Route("/api/video/event-thumb/{event_id}", api_video_event_thumb),
        Route("/api/video/segment-at",      api_video_segment_at),
        Route("/api/video2/timeline",       api_video2_timeline),
        Route("/video2",                    lambda r: FileResponse(static_dir / "video2.html")),
        Route("/api/video/events",          api_video_events),
        Route("/api/video/classes",         api_video_class_counts),
        Route("/api/video/segments",        api_video_segments),
        Route("/api/video/detections",      api_video_detections),
        Route("/api/video/live",            api_video_live_status),
        Route("/video/files/{path:path}",   serve_video_file),
        Route("/video/live/{source_id}/{filename}", serve_live_hls),
        Route("/api/sources",                    api_sources,             methods=["GET", "POST"]),
        Route("/api/sources/{source_id}",        api_delete_source,       methods=["DELETE"]),
        Route("/api/settings/status",            api_settings_status),
        Route("/api/settings/camera/test",       api_settings_camera_test, methods=["POST"]),
        Route("/api/settings/cleanup",           api_settings_cleanup,     methods=["POST"]),
        Mount("/", StaticFiles(directory=static_dir, html=True)),
    ]

    app = Starlette(routes=routes, lifespan=lifespan)
    return GZipMiddleware(app, minimum_size=1024)


# ── helpers ───────────────────────────────────────────────


def _sources_list(config: AppConfig, source_db=None) -> list:
    from .db import SourceDB
    cfg = list(config.enabled_sources())
    db_sources = source_db.to_source_configs() if source_db else []
    cfg_ids = {s.id for s in cfg}
    all_sources = cfg + [s for s in db_sources if s.id not in cfg_ids]
    return [
        {
            "id": s.id, "name": s.name or s.id, "type": s.type,
            "enabled": s.enabled,
            "interval_seconds": s.interval_seconds,
            "mutable": s.id not in cfg_ids,
        }
        for s in all_sources if s.type == "rtsp"
    ]
