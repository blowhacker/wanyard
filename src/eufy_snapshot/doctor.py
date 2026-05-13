from __future__ import annotations

import os
import shutil
from dataclasses import dataclass

from .adb import AdbClient
from .config import AppConfig


@dataclass(frozen=True)
class DoctorCheck:
    level: str
    message: str


def run_doctor(config: AppConfig) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    enabled_sources = config.enabled_sources()
    if not enabled_sources:
        return [DoctorCheck("error", "no enabled capture sources configured")]

    for source in enabled_sources:
        checks.append(
            DoctorCheck(
                "ok",
                f"source {source.id}: {source.name} ({source.type}, every {source.interval(config.interval_seconds):g}s)",
            )
        )

    rtsp_sources = [source for source in enabled_sources if source.type == "rtsp"]
    if rtsp_sources:
        if shutil.which("ffmpeg"):
            checks.append(DoctorCheck("ok", "ffmpeg is installed for RTSP capture"))
        else:
            checks.append(DoctorCheck("error", "ffmpeg is required for RTSP capture but was not found"))
        for source in rtsp_sources:
            if source.url or (source.url_env and os.environ.get(source.url_env)):
                checks.append(DoctorCheck("ok", f"RTSP URL configured for source {source.id}"))
            elif source.url_env:
                checks.append(DoctorCheck("error", f"RTSP URL env var is missing for source {source.id}: {source.url_env}"))
            else:
                checks.append(DoctorCheck("error", f"RTSP source {source.id} has no url or url_env"))

    if not any(source.type == "eufy_native" for source in enabled_sources):
        return checks

    if config.adb_connect:
        try:
            result = AdbClient.connect(config.adb_connect, timeout=20)
            checks.append(DoctorCheck("ok", f"ADB connected to {config.adb_connect}: {result.stdout.strip()}"))
        except Exception as exc:
            return [DoctorCheck("error", f"ADB cannot connect to {config.adb_connect}: {exc}")]

    adb = AdbClient(config.adb_serial)

    try:
        state = adb.run("get-state", timeout=10).stdout.strip()
    except Exception as exc:
        return [DoctorCheck("error", f"ADB cannot reach {config.adb_serial}: {exc}")]

    if state != "device":
        checks.append(DoctorCheck("error", f"ADB state is {state!r}, expected 'device'"))
        return checks
    checks.append(DoctorCheck("ok", f"ADB device {config.adb_serial} is connected"))

    api_level = adb.shell("getprop ro.build.version.sdk", check=False).strip()
    if api_level:
        try:
            api_int = int(api_level)
        except ValueError:
            checks.append(DoctorCheck("warning", f"could not parse Android API level: {api_level}"))
        else:
            if api_int >= 35:
                checks.append(
                    DoctorCheck(
                        "warning",
                        f"Android API {api_int} may trigger the Eufy 16 KB page-size crash; API 34 is recommended",
                    )
                )
            elif api_int == 34:
                checks.append(DoctorCheck("ok", "Android API 34 detected"))
            else:
                checks.append(DoctorCheck("warning", f"Android API {api_int} is untested; API 34 is recommended"))
    else:
        checks.append(DoctorCheck("warning", "could not read Android API level"))

    package = adb.shell(f"pm path {config.eufy_package}", check=False).strip()
    if package:
        checks.append(DoctorCheck("ok", f"Eufy package is installed: {config.eufy_package}"))
    else:
        checks.append(DoctorCheck("warning", f"Eufy package not found: {config.eufy_package}"))

    screenshot_dir = adb.shell(f"test -d '{config.android_screenshot_dir}' && echo yes", check=False).strip()
    if screenshot_dir == "yes":
        checks.append(DoctorCheck("ok", f"Android screenshot directory exists: {config.android_screenshot_dir}"))
    else:
        checks.append(DoctorCheck("warning", f"Android screenshot directory not found yet: {config.android_screenshot_dir}"))

    return checks
