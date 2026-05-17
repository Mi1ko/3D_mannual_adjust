"""Projection helpers for adaptive billboard labels."""

from __future__ import annotations

import numpy as np

from camera import normalize


def to_list(values) -> list[float]:
    return [float(value) for value in np.asarray(values, dtype=float).reshape(-1)]


def world_to_camera(points: np.ndarray, camera: dict) -> np.ndarray:
    point_array = np.asarray(points, dtype=float)
    if point_array.ndim == 1:
        point_array = point_array.reshape(1, 3)
    delta = point_array - np.asarray(camera["position"], dtype=float)
    x_view = np.asarray(camera["x_view"], dtype=float)
    y_view = np.asarray(camera["y_view"], dtype=float)
    z_view = np.asarray(camera["z_view"], dtype=float)
    return np.stack([delta @ x_view, delta @ y_view, delta @ z_view], axis=1)


def camera_to_world(camera_xyz: np.ndarray, camera: dict) -> np.ndarray:
    coords = np.asarray(camera_xyz, dtype=float)
    x_view = np.asarray(camera["x_view"], dtype=float)
    y_view = np.asarray(camera["y_view"], dtype=float)
    z_view = np.asarray(camera["z_view"], dtype=float)
    origin = np.asarray(camera["position"], dtype=float)
    if coords.ndim == 1:
        return origin + x_view * coords[0] + y_view * coords[1] + z_view * coords[2]
    return origin + coords[:, 0:1] * x_view + coords[:, 1:2] * y_view + coords[:, 2:3] * z_view


def camera_depth(camera_xyz: np.ndarray) -> np.ndarray:
    coords = np.asarray(camera_xyz, dtype=float)
    return -coords[..., 2]


def project_camera_to_ndc(camera_xyz: np.ndarray, camera: dict) -> np.ndarray:
    coords = np.asarray(camera_xyz, dtype=float)
    if coords.ndim == 1:
        coords = coords.reshape(1, 3)
    depth = camera_depth(coords)
    if np.any(depth <= 0.0):
        raise ValueError("Cannot project points behind the perspective camera.")
    focal_length = float(camera["focal_length_mm"])
    half_sensor_width = float(camera["sensor_width_mm"]) * 0.5
    half_sensor_height = float(camera["sensor_height_mm"]) * 0.5
    x = coords[:, 0] * focal_length / (depth * half_sensor_width)
    y = coords[:, 1] * focal_length / (depth * half_sensor_height)
    return np.stack([x, y], axis=1)


def project_world_to_pixels(
    world_points: np.ndarray,
    camera: dict,
    image_width: int,
    image_height: int,
) -> np.ndarray:
    camera_points = world_to_camera(world_points, camera)
    ndc = project_camera_to_ndc(camera_points, camera)
    x = (ndc[:, 0] + 1.0) * 0.5 * (image_width - 1)
    y = (1.0 - (ndc[:, 1] + 1.0) * 0.5) * (image_height - 1)
    return np.stack([x, y], axis=1)


def adaptive_label_corners(label_center: np.ndarray, box_size: np.ndarray, camera: dict) -> np.ndarray:
    center = np.asarray(label_center, dtype=float)
    half = np.asarray(box_size, dtype=float) * 0.5
    axis_x = normalize(np.asarray(camera["x_view"], dtype=float))
    axis_y = normalize(np.asarray(camera["y_view"], dtype=float))
    axis_z = normalize(np.asarray(camera["z_view"], dtype=float))
    corners = []
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            for sz in (-1.0, 1.0):
                corners.append(center + sx * half[0] * axis_x + sy * half[1] * axis_y + sz * half[2] * axis_z)
    return np.asarray(corners, dtype=float)


def projected_label_bounds(
    label_center: np.ndarray,
    box_size: np.ndarray,
    camera: dict,
    image_width: int,
    image_height: int,
) -> tuple[float, float, float, float]:
    corners = adaptive_label_corners(label_center, box_size, camera)
    projected = project_world_to_pixels(corners, camera, image_width, image_height)
    return (
        float(np.min(projected[:, 0])),
        float(np.min(projected[:, 1])),
        float(np.max(projected[:, 0])),
        float(np.max(projected[:, 1])),
    )


def projected_center(label_center: np.ndarray, camera: dict, width: int, height: int) -> np.ndarray:
    return project_world_to_pixels(np.asarray(label_center, dtype=float), camera, width, height)[0]

