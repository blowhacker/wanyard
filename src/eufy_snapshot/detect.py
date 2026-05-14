from __future__ import annotations

import json
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
    processed_at REAL NOT NULL,
    boxes_json TEXT,
    classes_json TEXT
)
"""

_CONF_THRESHOLD = 0.35

# COCO classes useful for outdoor CCTV
CCTV_CLASSES = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
    14: "bird",
    15: "cat",
    16: "dog",
    24: "backpack",
    28: "suitcase",
}
CCTV_CLASS_IDS = list(CCTV_CLASSES.keys())


class DetectionStore:
    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(_DDL)
            for col in ("boxes_json TEXT", "classes_json TEXT"):
                try:
                    conn.execute(f"ALTER TABLE detections ADD COLUMN {col}")
                except sqlite3.OperationalError:
                    pass

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._path))
        conn.row_factory = sqlite3.Row
        return conn

    def set(self, path: str, has_human: bool, confidence: float,
            boxes: list[dict] | None = None) -> None:
        classes = sorted({b["cls"] for b in boxes} if boxes else [])
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO detections"
                " (path, has_human, confidence, processed_at, boxes_json, classes_json)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (path, int(has_human), confidence, time.time(),
                 json.dumps(boxes) if boxes else None,
                 json.dumps(classes)),
            )

    def get_many(self, paths: list[str]) -> dict[str, dict]:
        if not paths:
            return {}
        with self._connect() as conn:
            placeholders = ",".join("?" * len(paths))
            rows = conn.execute(
                f"SELECT path, has_human, confidence, boxes_json, classes_json"
                f" FROM detections WHERE path IN ({placeholders})",
                paths,
            ).fetchall()
        result = {}
        for row in rows:
            boxes   = json.loads(row["boxes_json"])   if row["boxes_json"]   else []
            classes = json.loads(row["classes_json"]) if row["classes_json"] else []
            result[row["path"]] = {
                "has_human":  bool(row["has_human"]),
                "confidence": row["confidence"],
                "boxes":      boxes,
                "classes":    classes,
            }
        return result

    def processed_paths(self) -> set[str]:
        """Paths fully processed (boxes_json and classes_json both set)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT path FROM detections"
                " WHERE boxes_json IS NOT NULL AND classes_json IS NOT NULL"
            ).fetchall()
        return {row["path"] for row in rows}

    def stats(self) -> dict:
        with self._connect() as conn:
            total  = conn.execute("SELECT COUNT(*) FROM detections").fetchone()[0]
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
                    abs_path, classes=CCTV_CLASS_IDS,
                    conf=_CONF_THRESHOLD, verbose=False,
                )
                has_human, conf, boxes = _parse_results(results)
                self._store.set(item.path, has_human, conf, boxes)
                LOG.debug("detected %s classes=%s", item.path,
                          [b["cls"] for b in boxes])
            except Exception:
                LOG.exception("detection failed for %s", item.path)


def _parse_results(results) -> tuple[bool, float, list[dict]]:
    """Extract has_human, top confidence, and normalised boxes with class names."""
    if not results or results[0].boxes is None or not len(results[0].boxes):
        return False, 0.0, []
    r = results[0]
    boxes = []
    for xyxyn, conf, cls_id in zip(
        r.boxes.xyxyn.tolist(),
        r.boxes.conf.tolist(),
        r.boxes.cls.tolist(),
    ):
        x1, y1, x2, y2 = xyxyn
        cls_name = CCTV_CLASSES.get(int(cls_id), str(int(cls_id)))
        boxes.append({
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "conf": conf, "cls": cls_name,
        })
    has_human = any(b["cls"] == "person" for b in boxes)
    top_conf  = max((b["conf"] for b in boxes if b["cls"] == "person"), default=0.0)
    return has_human, top_conf, boxes
