"""YOLO inference worker — runs in a separate process via ProcessPoolExecutor.

All functions here are picklable and called from the main process via
executor.submit(). The _model global is initialised once per worker process
by init(), which is called by ProcessPoolExecutor(initializer=...).
"""
from __future__ import annotations

import logging
import os

LOG = logging.getLogger(__name__)
_model = None


def init(model_path: str) -> None:
    global _model
    from ultralytics import YOLO
    LOG.info("YOLO worker process ready: %s", model_path)
    _model = YOLO(model_path)


def ping() -> bool:
    return _model is not None


def predict_frame(frame, class_ids: list, conf: float, imgsz: int = 640) -> tuple:
    """Run inference on a numpy frame. Returns (has_human, top_conf, boxes)."""
    from .detect import _parse_results
    results = _model.predict(frame, classes=class_ids, conf=conf, imgsz=imgsz, verbose=False)
    return _parse_results(results)


def predict_path(path: str, class_ids: list, conf: float, imgsz: int = 640) -> tuple:
    """Run inference on a file path. Returns (has_human, top_conf, boxes)."""
    from .detect import _parse_results
    results = _model.predict(path, classes=class_ids, conf=conf, imgsz=imgsz, verbose=False)
    return _parse_results(results)
