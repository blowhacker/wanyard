from __future__ import annotations

import logging
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from .adb import AdbClient
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


def capture_once(
    config: AppConfig,
    source: SourceConfig | None = None,
    adb: AdbClient | None = None,
) -> CaptureResult:
    source = source or _default_source(config)
    if source.type == "eufy_native":
        return capture_eufy_native(config, source, adb)
    if source.type == "rtsp":
        return capture_rtsp_frame(config, source)
    raise ValueError(f"unsupported capture method for {source.id}: {source.type}")


def capture_eufy_native(
    config: AppConfig,
    source: SourceConfig,
    adb: AdbClient | None = None,
) -> CaptureResult:
    adb = adb or adb_client_from_config(config)
    ensure_eufy_installed(config, adb)
    started = time.monotonic()
    before = newest_android_jpeg(adb, config.android_screenshot_dir)

    adb.shell(f"input tap {source.capture.tap_x} {source.capture.tap_y}")
    android_path = wait_for_new_android_jpeg(
        adb,
        config.android_screenshot_dir,
        before,
        source.capture.wait_timeout_seconds,
    )

    output_path = build_output_path(config, source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(f".{output_path.stem}.tmp.jpg")
    adb.pull(android_path, str(tmp_path))

    if tmp_path.stat().st_size <= 0 or not looks_like_jpeg(tmp_path):
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(f"pulled file is not a non-empty JPEG: {tmp_path}")

    if config.filenames.capture_format == "avif":
        _convert_to_avif(tmp_path, output_path)
    else:
        tmp_path.replace(output_path)

    elapsed = time.monotonic() - started
    result = CaptureResult(
        output_path=output_path,
        source_id=source.id,
        source_name=source.name,
        source_path=android_path,
        size_bytes=output_path.stat().st_size,
        elapsed_seconds=elapsed,
    )
    LOG.info(
        "captured %s for %s from %s (%s bytes, %.2fs)",
        result.output_path,
        result.source_name,
        result.source_path,
        result.size_bytes,
        result.elapsed_seconds,
    )
    return result


def capture_rtsp_frame(config: AppConfig, source: SourceConfig) -> CaptureResult:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise CaptureNotReady("ffmpeg is not installed; RTSP capture requires ffmpeg")
    url = resolve_rtsp_url(source)
    if not url:
        raise CaptureNotReady(f"RTSP source {source.id} has no url or url_env value")

    started = time.monotonic()
    output_path = build_output_path(config, source)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_name(f".{output_path.stem}.tmp.jpg")
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        source.rtsp_transport,
        "-y",
        "-i",
        url,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(tmp_path),
    ]
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=source.timeout_seconds,
            check=False,
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
    LOG.info(
        "captured %s for %s from RTSP (%s bytes, %.2fs)",
        result.output_path,
        result.source_name,
        result.size_bytes,
        result.elapsed_seconds,
    )
    return result


def grab_rtsp_temp(config: AppConfig, source: SourceConfig) -> Path:
    """Grab one RTSP frame to a temp JPEG. Caller must delete when done."""
    import tempfile
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


def newest_android_jpeg(adb: AdbClient, android_dir: str) -> str | None:
    command = (
        f"ls -t {shell_quote(android_dir)}/*.jpg {shell_quote(android_dir)}/*.jpeg "
        "2>/dev/null | head -1"
    )
    output = adb.shell(command, check=False).strip()
    return output or None


def wait_for_new_android_jpeg(
    adb: AdbClient,
    android_dir: str,
    previous: str | None,
    timeout_seconds: float,
) -> str:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        current = newest_android_jpeg(adb, android_dir)
        if current and current != previous:
            return current
        time.sleep(0.5)
    raise TimeoutError(f"no new Eufy JPEG appeared in {android_dir} within {timeout_seconds}s")


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
        raise RuntimeError(
            f"avifenc failed: {r.stderr.decode('utf-8', errors='replace').strip()}"
        )


def ensure_eufy_installed(config: AppConfig, adb: AdbClient) -> None:
    package = adb.shell(f"pm path {config.eufy_package}", check=False).strip()
    if not package:
        raise CaptureNotReady(f"Eufy package is not installed: {config.eufy_package}")


def save_debug_screencap(config: AppConfig, adb: AdbClient | None = None) -> Path:
    adb = adb or adb_client_from_config(config)
    tz = ZoneInfo(config.filenames.timezone)
    relative = datetime.now(tz).strftime("%Y/%m/%d/debug-%Y-%m-%d_%H-%M-%S.png")
    output_path = config.output_dir / relative
    output_path.parent.mkdir(parents=True, exist_ok=True)
    remote = "/sdcard/eufy-snapshot-debug.png"
    adb.shell(f"screencap -p {remote}", check=False)
    adb.pull(remote, str(output_path))
    adb.shell(f"rm -f {remote}", check=False)
    LOG.warning("saved debug screencap to %s", output_path)
    return output_path


def shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def adb_client_from_config(config: AppConfig) -> AdbClient:
    if config.adb_connect:
        AdbClient.connect(config.adb_connect)
    return AdbClient(config.adb_serial)


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


def _default_source(config: AppConfig) -> SourceConfig:
    sources = config.enabled_sources() or config.sources
    if not sources:
        raise CaptureNotReady("no capture sources configured")
    return sources[0]


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
