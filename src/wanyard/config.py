from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import yaml
except ModuleNotFoundError:
    yaml = None


@dataclass(frozen=True)
class SourceConfig:
    id: str
    name: str
    type: str = "rtsp"
    enabled: bool = True
    interval_seconds: float | None = None
    url: str | None = None
    rtsp_transport: str = "tcp"
    timeout_seconds: float = 20
    output_subdir: str | None = None

    def interval(self, default_seconds: float) -> float:
        return float(self.interval_seconds if self.interval_seconds is not None else default_seconds)


@dataclass(frozen=True)
class WebConfig:
    host: str = "0.0.0.0"
    port: int = 8080
    ssl_certfile: str | None = None
    ssl_keyfile: str | None = None


@dataclass(frozen=True)
class AppConfig:
    interval_seconds: float = 30
    db_path: Path | None = None
    web: WebConfig = field(default_factory=WebConfig)


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    config_path = Path(path)
    data: dict[str, Any] = {}
    if config_path.exists():
        with config_path.open("r", encoding="utf-8") as fh:
            loaded = _load_yaml(fh.read())
            if not isinstance(loaded, dict):
                raise ValueError(f"{config_path} must contain a YAML mapping")
            data = loaded

    _web_known = {"host", "port", "ssl_certfile", "ssl_keyfile"}
    web = WebConfig(**{k: v for k, v in _mapping(data.get("web", {})).items() if k in _web_known})
    db_path_raw = data.get("db_path")

    return AppConfig(
        interval_seconds=data.get("interval_seconds", AppConfig.interval_seconds),
        db_path=Path(db_path_raw) if db_path_raw else None,
        web=web,
    )


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


