from __future__ import annotations
from .config import SourceConfig


def resolve_rtsp_url(source: SourceConfig) -> str | None:
    return source.url
