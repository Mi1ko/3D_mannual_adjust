"""Small rendering helpers shared by projection image generation."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    font_candidates = [
        Path(r"C:\Windows\Fonts\arial.ttf"),
        Path(r"C:\Windows\Fonts\calibri.ttf"),
        Path(r"C:\Windows\Fonts\segoeui.ttf"),
    ]
    for path in font_candidates:
        if path.is_file():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def fit_font_to_box(
    draw: ImageDraw.ImageDraw,
    text: str,
    box_width: float,
    box_height: float,
    padding_x: float,
    padding_y: float,
) -> tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, tuple[int, int, int, int]]:
    available_width = max(1.0, float(box_width) - padding_x * 2.0)
    available_height = max(1.0, float(box_height) - padding_y * 2.0)
    min_size = 8
    max_size = max(min_size, int(available_height * 0.92))
    for size in range(max(int(max_size), min_size), min_size - 1, -2):
        font = load_font(size)
        bbox = draw.textbbox((0, 0), text, font=font)
        if bbox[2] - bbox[0] <= available_width and bbox[3] - bbox[1] <= available_height:
            return font, bbox
    font = load_font(min_size)
    return font, draw.textbbox((0, 0), text, font=font)


def ensure_rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image
    if image.mode == "RGBA":
        background = Image.new("RGB", image.size, (255, 255, 255))
        background.paste(image, mask=image.getchannel("A"))
        return background
    return image.convert("RGB")


def render_clip(camera: dict) -> tuple[float, float]:
    radius = float(camera.get("camera_radius", 7.0))
    return 0.1, max(20.0, radius + 3.0)


def camera_pose(camera: dict) -> np.ndarray:
    pose = np.eye(4, dtype=float)
    pose[:3, 0] = np.asarray(camera["x_view"], dtype=float)
    pose[:3, 1] = np.asarray(camera["y_view"], dtype=float)
    pose[:3, 2] = np.asarray(camera["z_view"], dtype=float)
    pose[:3, 3] = np.asarray(camera["position"], dtype=float)
    return pose


def render_object_pyrender(
    merged_obj_path: Path,
    camera: dict,
    image_width: int,
    image_height: int,
    mesh_cache: dict[str, object] | None = None,
) -> Image.Image:
    import pyrender
    import trimesh

    cache_key = str(Path(merged_obj_path).resolve())
    mesh = None if mesh_cache is None else mesh_cache.get(cache_key)
    if mesh is None:
        loaded = trimesh.load(str(merged_obj_path), force="mesh", process=True)
        if loaded.is_empty:
            raise ValueError(f"trimesh loaded an empty mesh: {merged_obj_path}")
        material = pyrender.MetallicRoughnessMaterial(
            baseColorFactor=(0.76, 0.76, 0.72, 1.0),
            metallicFactor=0.0,
            roughnessFactor=0.72,
            alphaMode="OPAQUE",
        )
        mesh = pyrender.Mesh.from_trimesh(loaded, material=material, smooth=False)
        if mesh_cache is not None:
            mesh_cache[cache_key] = mesh

    scene = pyrender.Scene(bg_color=[255, 255, 255, 255], ambient_light=[0.42, 0.42, 0.42])
    scene.add(mesh)

    width = int(image_width)
    height = int(image_height)
    fx = float(camera["focal_length_mm"]) * (width - 1) / float(camera["sensor_width_mm"])
    fy = float(camera["focal_length_mm"]) * (height - 1) / float(camera["sensor_height_mm"])
    cx = (width - 1) * 0.5
    cy = (height - 1) * 0.5
    znear, zfar = render_clip(camera)
    render_camera = pyrender.IntrinsicsCamera(fx=fx, fy=fy, cx=cx, cy=cy, znear=znear, zfar=zfar)
    pose = camera_pose(camera)
    scene.add(render_camera, pose=pose)
    scene.add(pyrender.DirectionalLight(color=np.ones(3), intensity=1.6), pose=pose)

    renderer = pyrender.OffscreenRenderer(viewport_width=width, viewport_height=height)
    try:
        color, _ = renderer.render(scene, flags=pyrender.RenderFlags.RGBA)
        return ensure_rgb(Image.fromarray(color.astype(np.uint8), mode="RGBA"))
    finally:
        renderer.delete()
