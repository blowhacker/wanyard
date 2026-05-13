from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from pathlib import Path

LOG = logging.getLogger(__name__)

_DDL = """
CREATE TABLE IF NOT EXISTS detections (
    path TEXT PRIMARY KEY,
    has_human INTEGER NOT NULL,
    confidence REAL NOT NULL,
    processed_at REAL NOT NULL
)
"""

_CONF_THRESHOLD = 0.35


class DetectionStore:
    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(_DDL)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._path))
        conn.row_factory = sqlite3.Row
        return conn

    def set(self, path: str, has_human: bool, confidence: float) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO detections (path, has_human, confidence, processed_at)"
                " VALUES (?, ?, ?, ?)",
                (path, int(has_human), confidence, time.time()),
            )

    def get_many(self, paths: list[str]) -> dict[str, tuple[bool, float]]:
        if not paths:
            return {}
        with self._connect() as conn:
            placeholders = ",".join("?" * len(paths))
            rows = conn.execute(
                f"SELECT path, has_human, confidence FROM detections WHERE path IN ({placeholders})",
                paths,
            ).fetchall()
        return {row["path"]: (bool(row["has_human"]), row["confidence"]) for row in rows}

    def processed_paths(self) -> set[str]:
        with self._connect() as conn:
            rows = conn.execute("SELECT path FROM detections").fetchall()
        return {row["path"] for row in rows}

    def stats(self) -> dict:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM detections").fetchone()[0]
            humans = conn.execute(
                "SELECT COUNT(*) FROM detections WHERE has_human = 1"
            ).fetchone()[0]
        return {"processed": total, "humans": humans}


class DetectionWorker:
    def __init__(self, store: DetectionStore, image_index) -> None:
        self._store = store
        self._image_index = image_index
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._model = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="detection-worker", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=15)

    def _load_model(self):
        if self._model is None:
            from ultralytics import YOLO

            model_path = os.environ.get("YOLO_MODEL_PATH", "yolo11m.pt")
            LOG.info("loading YOLO model: %s", model_path)
            self._model = YOLO(model_path)
        return self._model

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._process_batch()
            except Exception:
                LOG.exception("detection worker error")
            self._stop.wait(5.0)

    def _process_batch(self) -> None:
        all_items = self._image_index.items()
        if not all_items:
            return
        processed = self._store.processed_paths()
        pending = [item for item in all_items if item.path not in processed]
        if not pending:
            return

        model = self._load_model()
        output_dir = self._image_index.output_dir

        for item in pending:
            if self._stop.is_set():
                break
            try:
                abs_path = str(output_dir / item.path)
                results = model.predict(
                    abs_path, classes=[0], conf=_CONF_THRESHOLD, verbose=False
                )
                has_human = bool(
                    results
                    and results[0].boxes is not None
                    and len(results[0].boxes)
                )
                conf = 0.0
                if has_human:
                    conf = float(max(results[0].boxes.conf.tolist()))
                self._store.set(item.path, has_human, conf)
                LOG.debug(
                    "detected %s has_human=%s conf=%.2f", item.path, has_human, conf
                )
            except Exception:
                LOG.exception("detection failed for %s", item.path)
