from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from .config import AppConfig, SourceConfig
from .index import looks_like_jpeg

LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class CaptureResult:
    output_path: Path
    source_id: str
    source_name: str
    source_path: str
    size_bytes: int
    elapsed_seconds: float


class CaptureNotReady(RuntimeError):
    pass


def capture_once(config: AppConfig, source: SourceConfig) -> CaptureResult:
    if source.type == "rtsp":
        return capture_rtsp_frame(config, source)
    raise ValueError(f"unsupported capture type for {source.id}: {source.type}")


def capture_rtsp_frame(config: AppConfig, source: SourceConfig) -> CaptureResult:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise CaptureNotReady("ffmpeg not installed; RTSP capture requires ffmpeg")
    url = resolve_rtsp_url(source)
    if not url:
        raise CaptureNotReady(f"RTSP source {source.id} has no url or url_env value")

    started = time.monotonic()
    output_path = build_output_path(config, source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(f".{output_path.stem}.tmp.jpg")
    command = [
        ffmpeg, "-hide_banner", "-loglevel", "error",
        "-rtsp_transport", source.rtsp_transport,
        "-y", "-i", url, "-frames:v", "1", "-q:v", "2", str(tmp_path),
    ]
    try:
        completed = subprocess.run(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=source.timeout_seconds, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        tmp_path.unlink(missing_ok=True)
        raise TimeoutError(f"RTSP capture timed out after {source.timeout_seconds}s for {source.name}") from exc

    if completed.returncode != 0:
        tmp_path.unlink(missing_ok=True)
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg failed for {source.name}: {_redact_secret(stderr, url)}")
    if tmp_path.stat().st_size <= 0 or not looks_like_jpeg(tmp_path):
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg output is not a non-empty JPEG for {source.name}")

    if config.filenames.capture_format == "avif":
        _convert_to_avif(tmp_path, output_path)
    else:
        tmp_path.replace(output_path)

    elapsed = time.monotonic() - started
    result = CaptureResult(
        output_path=output_path,
        source_id=source.id,
        source_name=source.name,
        source_path=_redact_url(url),
        size_bytes=output_path.stat().st_size,
        elapsed_seconds=elapsed,
    )
    LOG.info("captured %s for %s from RTSP (%s bytes, %.2fs)",
             result.output_path, result.source_name, result.size_bytes, result.elapsed_seconds)
    return result


def grab_rtsp_temp(config: AppConfig, source: SourceConfig) -> Path:
    """Grab one RTSP frame to a temp JPEG. Caller must delete when done."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise CaptureNotReady("ffmpeg not installed")
    url = resolve_rtsp_url(source)
    if not url:
        raise CaptureNotReady(f"no URL for {source.id}")
    tmp = Path(tempfile.mktemp(suffix=".jpg"))
    r = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error",
         "-rtsp_transport", source.rtsp_transport,
         "-y", "-i", url, "-frames:v", "1", "-q:v", "2", str(tmp)],
        capture_output=True, timeout=source.timeout_seconds, check=False,
    )
    if r.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg failed for {source.name}")
    if not looks_like_jpeg(tmp):
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"not a JPEG: {source.name}")
    return tmp


def build_output_path(config: AppConfig, source: SourceConfig | None = None) -> Path:
    tz = ZoneInfo(config.filenames.timezone)
    now = datetime.now(tz)
    relative = now.strftime(config.filenames.pattern)
    if config.filenames.capture_format == "avif":
        relative = str(Path(relative).with_suffix(".avif"))
    base = config.output_dir
    if source and source.output_subdir:
        base = base / source.output_subdir
    return unique_path(base / relative)


def _convert_to_avif(src: Path, dest: Path, quality: int = 50) -> None:
    avifenc = shutil.which("avifenc")
    if not avifenc:
        raise CaptureNotReady("avifenc not found; install libavif-bin for AVIF capture")
    r = subprocess.run(
        [avifenc, "-q", str(quality), "-s", "6", str(src), str(dest)],
        capture_output=True, timeout=30, check=False,
    )
    src.unlink(missing_ok=True)
    if r.returncode != 0 or not dest.exists():
        raise RuntimeError(f"avifenc failed: {r.stderr.decode('utf-8', errors='replace').strip()}")


def resolve_rtsp_url(source: SourceConfig) -> str | None:
    if source.url_env:
        return os.environ.get(source.url_env)
    return source.url


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    for index in range(1, 1000):
        candidate = parent / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"could not allocate unique output path for {path}")


def _redact_secret(text: str, url: str) -> str:
    return text.replace(url, _redact_url(url))


def _redact_url(url: str) -> str:
    try:
        parts = urlsplit(url)
        if "@" not in parts.netloc:
            return url
        host = parts.netloc.rsplit("@", 1)[1]
        return urlunsplit((parts.scheme, f"<credentials>@{host}", parts.path, parts.query, parts.fragment))
    except ValueError:
        return "<rtsp-url>"
