from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .adb import AdbClient
from .config import AppConfig
from .index import looks_like_jpeg

LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class CaptureResult:
    output_path: Path
    android_path: str
    size_bytes: int
    elapsed_seconds: float


class CaptureNotReady(RuntimeError):
    pass


def capture_once(config: AppConfig, adb: AdbClient | None = None) -> CaptureResult:
    if config.capture.method != "eufy_native":
        raise ValueError(f"unsupported capture method: {config.capture.method}")

    adb = adb or adb_client_from_config(config)
    ensure_eufy_installed(config, adb)
    started = time.monotonic()
    before = newest_android_jpeg(adb, config.android_screenshot_dir)

    adb.shell(f"input tap {config.capture.tap_x} {config.capture.tap_y}")
    android_path = wait_for_new_android_jpeg(
        adb,
        config.android_screenshot_dir,
        before,
        config.capture.wait_timeout_seconds,
    )

    output_path = build_output_path(config)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    adb.pull(android_path, str(output_path))

    if output_path.stat().st_size <= 0 or not looks_like_jpeg(output_path):
        raise RuntimeError(f"pulled file is not a non-empty JPEG: {output_path}")

    elapsed = time.monotonic() - started
    result = CaptureResult(
        output_path=output_path,
        android_path=android_path,
        size_bytes=output_path.stat().st_size,
        elapsed_seconds=elapsed,
    )
    LOG.info(
        "captured %s from %s (%s bytes, %.2fs)",
        result.output_path,
        result.android_path,
        result.size_bytes,
        result.elapsed_seconds,
    )
    return result


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


def build_output_path(config: AppConfig) -> Path:
    tz = ZoneInfo(config.filenames.timezone)
    now = datetime.now(tz)
    relative = now.strftime(config.filenames.pattern)
    return config.output_dir / relative


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
