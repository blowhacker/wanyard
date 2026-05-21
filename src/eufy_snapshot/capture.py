from __future__ import annotations
import os
from .config import SourceConfig


def resolve_rtsp_url(source: SourceConfig) -> str | None:
    if source.url_env:
        return os.environ.get(source.url_env)
    return source.url
