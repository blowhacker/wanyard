from __future__ import annotations

import os
import re
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
class SourceConfig:
    id: str
    name: str
    type: str = "eufy_native"
    interval_seconds: float | None = None
    enabled: bool = True
    output_subdir: str | None = None
    url: str | None = None
    url_env: str | None = None
    rtsp_transport: str = "tcp"
    timeout_seconds: float = 20
    capture: CaptureConfig = field(default_factory=CaptureConfig)

    def interval(self, default_seconds: float) -> float:
        return float(self.interval_seconds if self.interval_seconds is not None else default_seconds)


@dataclass(frozen=True)
class WebConfig:
    host: str = "0.0.0.0"
    port: int = 8080
    auto_refresh_seconds: int = 10
    max_index_items: int = 10000
    ssl_certfile: str | None = None
    ssl_keyfile: str | None = None


@dataclass(frozen=True)
class FilenameConfig:
    timezone: str = "Europe/London"
    pattern: str = "%Y/%m/%d/%Y-%m-%d_%H-%M-%S.jpg"
    capture_format: str = "jpeg"  # "jpeg" or "avif"


@dataclass(frozen=True)
class AppConfig:
    adb_serial: str = "emulator-5554"
    adb_connect: str | None = None
    interval_seconds: float = 30
    output_dir: Path = Path("snapshots")
    db_path: Path | None = None
    camera_name: str = "Front Door"
    android_screenshot_dir: str = "/sdcard/Pictures/EufyPicDir"
    eufy_package: str = "com.oceanwing.battery.cam"
    capture: CaptureConfig = field(default_factory=CaptureConfig)
    web: WebConfig = field(default_factory=WebConfig)
    filenames: FilenameConfig = field(default_factory=FilenameConfig)
    sources: tuple[SourceConfig, ...] = field(default_factory=tuple)

    def enabled_sources(self) -> tuple[SourceConfig, ...]:
        return tuple(source for source in self.sources if source.enabled)

    def source_by_id(self, source_id: str) -> SourceConfig | None:
        return next((source for source in self.sources if source.id == source_id), None)


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    config_path = Path(path)
    _load_env_file(config_path.parent / ".env")
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
    sources = _load_sources(data, capture)

    db_path_raw = data.get("db_path")
    base = {
        "adb_serial": data.get("adb_serial", AppConfig.adb_serial),
        "adb_connect": data.get("adb_connect", AppConfig.adb_connect),
        "interval_seconds": data.get("interval_seconds", AppConfig.interval_seconds),
        "output_dir": Path(data.get("output_dir", AppConfig.output_dir)),
        "db_path": Path(db_path_raw) if db_path_raw else None,
        "camera_name": data.get("camera_name", AppConfig.camera_name),
        "android_screenshot_dir": data.get(
            "android_screenshot_dir", AppConfig.android_screenshot_dir
        ),
        "eufy_package": data.get("eufy_package", AppConfig.eufy_package),
        "capture": capture,
        "web": web,
        "filenames": filenames,
        "sources": sources,
    }
    return AppConfig(**base)


def _load_sources(data: dict[str, Any], default_capture: CaptureConfig) -> tuple[SourceConfig, ...]:
    sources_data = data.get("sources")
    if sources_data is None:
        camera_name = str(data.get("camera_name", AppConfig.camera_name))
        return (
            SourceConfig(
                id=_slug(camera_name),
                name=camera_name,
                type=default_capture.method,
                interval_seconds=float(data.get("interval_seconds", AppConfig.interval_seconds)),
                output_subdir=None,
                capture=default_capture,
            ),
        )
    if not isinstance(sources_data, dict):
        raise ValueError("sources must be a mapping of source_id to source config")
    if not sources_data:
        return ()

    sources: list[SourceConfig] = []
    for source_id, raw_source in sources_data.items():
        source = _mapping(raw_source)
        capture_data = {
            **default_capture.__dict__,
            **_mapping(source.get("capture", {})),
        }
        source_capture = CaptureConfig(**capture_data)
        source_type = str(source.get("type", source.get("method", source_capture.method)))
        output_subdir = source.get("output_subdir", str(source_id))
        sources.append(
            SourceConfig(
                id=str(source_id),
                name=str(source.get("name", source_id)),
                type=source_type,
                interval_seconds=source.get("interval_seconds", data.get("interval_seconds")),
                enabled=bool(source.get("enabled", True)),
                output_subdir=None if output_subdir in {"", None} else str(output_subdir),
                url=source.get("url") or source.get("rtsp_url"),
                url_env=source.get("url_env") or source.get("rtsp_url_env"),
                rtsp_transport=str(source.get("rtsp_transport", "tcp")),
                timeout_seconds=float(source.get("timeout_seconds", 20)),
                capture=source_capture,
            )
        )
    return tuple(sources)


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
    stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
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
        while stack and indent <= stack[-1][0]:
            stack.pop()
        if not stack:
            raise ValueError(f"unsupported config indentation on line {line_number}: {raw_line}")
        parent = stack[-1][1]
        if not value:
            section: dict[str, Any] = {}
            parent[key] = section
            stack.append((indent, section))
        else:
            parent[key] = _parse_scalar(value)
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


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        os.environ.setdefault(key, _parse_env_value(value.strip()))


def _parse_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "camera"
