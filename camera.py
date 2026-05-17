"""Camera construction for multi-view 3D layout checks."""

from __future__ import annotations

import math

import numpy as np

from settings import NewLayoutSettings


def normalize(vector: np.ndarray) -> np.ndarray:
    length = float(np.linalg.norm(vector))
    if length <= 1e-12:
        raise ValueError("Cannot normalize a zero-length vector.")
    return vector / length


MAIN_Z_VIEW = normalize(np.array([1.0, 1.0, 1.0], dtype=float))
MAIN_Y_HINT = np.array([0.0, 1.0, 0.0], dtype=float)


def rotate_toward(z_view: np.ndarray, screen_axis: np.ndarray, degrees: float) -> np.ndarray:
    radians = math.radians(float(degrees))
    return normalize(z_view * math.cos(radians) + normalize(screen_axis) * math.sin(radians))


def build_camera_from_direction(
    z_view: np.ndarray,
    y_hint: np.ndarray,
    settings: NewLayoutSettings,
) -> dict:
    z_view = normalize(np.asarray(z_view, dtype=float))
    y_hint = normalize(np.asarray(y_hint, dtype=float))
    if abs(float(np.dot(z_view, y_hint))) > 0.999:
        raise ValueError("Camera z_view and y_hint are nearly collinear.")

    x_view = normalize(np.cross(-z_view, y_hint))
    y_view = normalize(np.cross(z_view, x_view))
    radius = float(settings.camera_radius)
    return {
        "type": "perspective",
        "camera_radius": radius,
        "focal_length_mm": float(settings.camera_focal_length_mm),
        "sensor_width_mm": float(settings.camera_sensor_width_mm),
        "sensor_height_mm": float(settings.camera_sensor_height_mm),
        "near_clip": float(settings.camera_near_clip),
        "far_clip": float(settings.camera_far_clip),
        "position": z_view * radius,
        "x_view": x_view,
        "y_view": y_view,
        "z_view": z_view,
    }


def build_multiview_camera(settings: NewLayoutSettings) -> dict:
    main_camera = build_camera_from_direction(MAIN_Z_VIEW, MAIN_Y_HINT, settings)
    x_view = main_camera["x_view"]
    y_view = main_camera["y_view"]
    z_view = main_camera["z_view"]
    degrees = float(settings.perturb_degrees)
    directions = {
        "up": rotate_toward(z_view, y_view, degrees),
        "down": rotate_toward(z_view, -y_view, degrees),
        "left": rotate_toward(z_view, -x_view, degrees),
        "right": rotate_toward(z_view, x_view, degrees),
    }
    main_camera["other_camera"] = {
        name: build_camera_from_direction(direction, y_view, settings)
        for name, direction in directions.items()
    }
    return main_camera


def iter_cameras(camera: dict) -> dict[str, dict]:
    cameras = {"main": camera}
    cameras.update(camera.get("other_camera", {}))
    return cameras
