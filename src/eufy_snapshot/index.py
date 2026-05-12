from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from threading import RLock
from typing import Iterable
from urllib.parse import quote
from zoneinfo import ZoneInfo


JPEG_MAGIC = b"\xff\xd8\xff"
TIMESTAMP_RE = re.compile(r"(?P<date>\d{4}-\d{2}-\d{2})_(?P<time>\d{2}-\d{2}-\d{2})")


@dataclass(frozen=True)
class ImageItem:
    path: str
    url: str
    timestamp: str
    date: str
    size_bytes: int


class ImageIndex:
    def __init__(self, output_dir: Path, timezone: str, max_items: int = 10000) -> None:
        self.output_dir = output_dir
        self.tz = ZoneInfo(timezone)
        self.max_items = max_items
        self._lock = RLock()
        self._items: list[ImageItem] = []

    def refresh(self) -> list[ImageItem]:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        items = sorted(
            self._scan_images(),
            key=lambda item: item.timestamp,
            reverse=True,
        )[: self.max_items]
        items.reverse()
        with self._lock:
            self._items = items
            return list(self._items)

    def items(self, date: str | None = None) -> list[ImageItem]:
        with self._lock:
            items = list(self._items)
        if date:
            return [item for item in items if item.date == date]
        return items

    def latest(self) -> ImageItem | None:
        with self._lock:
            return self._items[-1] if self._items else None

    def dates(self) -> list[str]:
        return sorted({item.date for item in self.items()})

    def resolve_image_path(self, relative_path: str) -> Path | None:
        try:
            clean = PurePosixPath(relative_path)
            if clean.is_absolute() or ".." in clean.parts:
                return None
            candidate = (self.output_dir / Path(*clean.parts)).resolve()
            root = self.output_dir.resolve()
            if root not in candidate.parents and candidate != root:
                return None
            if not candidate.is_file():
                return None
            return candidate
        except OSError:
            return None

    def _scan_images(self) -> Iterable[ImageItem]:
        for path in self.output_dir.rglob("*.jpg"):
            if not path.is_file():
                continue
            timestamp = timestamp_from_path(path, self.tz)
            if timestamp is None:
                continue
            rel = path.relative_to(self.output_dir).as_posix()
            yield ImageItem(
                path=rel,
                url=f"/images/{quote(rel)}",
                timestamp=timestamp.isoformat(),
                date=timestamp.date().isoformat(),
                size_bytes=path.stat().st_size,
            )


def timestamp_from_path(path: Path, tz: ZoneInfo) -> datetime | None:
    match = TIMESTAMP_RE.search(path.name)
    if not match:
        return None
    value = f"{match.group('date')} {match.group('time').replace('-', ':')}"
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz)
    except ValueError:
        return None


def looks_like_jpeg(path: Path) -> bool:
    try:
        with path.open("rb") as fh:
            return fh.read(3) == JPEG_MAGIC
    except OSError:
        return False
