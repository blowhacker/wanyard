from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - exercised in minimal installs
    yaml = None


@dataclass(frozen=True)
class CaptureConfig:
    method: str = "eufy_native"
    tap_x: int = 340
    tap_y: int = 2210
    wait_timeout_seconds: float = 10
    debug_screencap_on_failure: bool = True


@dataclass(frozen=True)
class WebConfig:
    host: str = "0.0.0.0"
    port: int = 8080
    auto_refresh_seconds: int = 10
    max_index_items: int = 10000


@dataclass(frozen=True)
class FilenameConfig:
    timezone: str = "Europe/London"
    pattern: str = "%Y/%m/%d/%Y-%m-%d_%H-%M-%S.jpg"


@dataclass(frozen=True)
class AppConfig:
    adb_serial: str = "emulator-5554"
    adb_connect: str | None = None
    interval_seconds: float = 30
    output_dir: Path = Path("snapshots")
    camera_name: str = "Front Door"
    android_screenshot_dir: str = "/sdcard/Pictures/EufyPicDir"
    eufy_package: str = "com.oceanwing.battery.cam"
    capture: CaptureConfig = field(default_factory=CaptureConfig)
    web: WebConfig = field(default_factory=WebConfig)
    filenames: FilenameConfig = field(default_factory=FilenameConfig)


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    config_path = Path(path)
    data: dict[str, Any] = {}
    if config_path.exists():
        with config_path.open("r", encoding="utf-8") as fh:
            loaded = _load_yaml(fh.read())
            if not isinstance(loaded, dict):
                raise ValueError(f"{config_path} must contain a YAML mapping")
            data = loaded

    capture = CaptureConfig(**_mapping(data.get("capture", {})))
    web = WebConfig(**_mapping(data.get("web", {})))
    filenames = FilenameConfig(**_mapping(data.get("filenames", {})))

    base = {
        "adb_serial": data.get("adb_serial", AppConfig.adb_serial),
        "adb_connect": data.get("adb_connect", AppConfig.adb_connect),
        "interval_seconds": data.get("interval_seconds", AppConfig.interval_seconds),
        "output_dir": Path(data.get("output_dir", AppConfig.output_dir)),
        "camera_name": data.get("camera_name", AppConfig.camera_name),
        "android_screenshot_dir": data.get(
            "android_screenshot_dir", AppConfig.android_screenshot_dir
        ),
        "eufy_package": data.get("eufy_package", AppConfig.eufy_package),
        "capture": capture,
        "web": web,
        "filenames": filenames,
    }
    return AppConfig(**base)


def _mapping(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("nested config sections must be mappings")
    return value


def _load_yaml(text: str) -> dict[str, Any]:
    if yaml is not None:
        return yaml.safe_load(text) or {}
    return _load_simple_yaml(text)


def _load_simple_yaml(text: str) -> dict[str, Any]:
    root: dict[str, Any] = {}
    current_section: dict[str, Any] | None = None
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.split("#", 1)[0].rstrip()
        if not line:
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if ":" not in stripped:
            raise ValueError(f"invalid config line {line_number}: {raw_line}")
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if indent == 0 and not value:
            section: dict[str, Any] = {}
            root[key] = section
            current_section = section
        elif indent == 0:
            root[key] = _parse_scalar(value)
            current_section = None
        elif indent == 2 and current_section is not None:
            current_section[key] = _parse_scalar(value)
        else:
            raise ValueError(f"unsupported config indentation on line {line_number}: {raw_line}")
    return root


def _parse_scalar(value: str) -> Any:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    lowered = value.lower()
    if lowered in {"null", "none", "~"}:
        return None
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value
