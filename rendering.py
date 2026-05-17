"""Projection rendering for adaptive 2D labels."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from projection import projected_center, projected_label_bounds
from render_helpers import camera_pose, ensure_rgb, fit_font_to_box, load_font, render_clip, render_object_pyrender
from settings import NewLayoutSettings


LabelResolver = Callable[[dict, int], str]
VIEW_ORDER = ("main", "up", "down", "left", "right")


def inherit_camera_payload(camera: dict, parent: dict | None = None) -> dict:
    inherited = parent or {}
    result = dict(camera)
    for key in (
        "type",
        "camera_radius",
        "focal_length_mm",
        "sensor_width_mm",
        "sensor_height_mm",
        "near_clip",
        "far_clip",
    ):
        if key not in result and key in inherited:
            result[key] = inherited[key]
    return result


def collect_view_cameras(annotation: dict) -> dict[str, dict]:
    main_camera = inherit_camera_payload(annotation["camera"])
    cameras = {"main": main_camera}
    cameras.update(
        {
            name: inherit_camera_payload(camera, main_camera)
            for name, camera in annotation["camera"].get("other_camera", {}).items()
        }
    )
    return cameras


def add_trimesh_scene(pyrender_scene, loaded) -> None:
    import pyrender
    import trimesh

    if isinstance(loaded, trimesh.Scene):
        for node_name in loaded.graph.nodes_geometry:
            transform, geometry_name = loaded.graph[node_name]
            geometry = loaded.geometry[geometry_name]
            if geometry.is_empty:
                continue
            pyrender_scene.add(pyrender.Mesh.from_trimesh(geometry, smooth=False), pose=transform)
        return

    if loaded.is_empty:
        raise ValueError("Loaded OBJ-O mesh is empty.")
    pyrender_scene.add(pyrender.Mesh.from_trimesh(loaded, smooth=False))


def render_obj_o_pyrender(
    obj_o_path: Path,
    camera: dict,
    image_width: int,
    image_height: int,
    scene_cache: dict[str, object] | None = None,
) -> Image.Image:
    import pyrender
    import trimesh

    cache_key = str(Path(obj_o_path).resolve())
    loaded = None if scene_cache is None else scene_cache.get(cache_key)
    if loaded is None:
        loaded = trimesh.load(str(obj_o_path), force="scene", process=False)
        if scene_cache is not None:
            scene_cache[cache_key] = loaded

    scene = pyrender.Scene(bg_color=[255, 255, 255, 255], ambient_light=[0.50, 0.50, 0.50])
    add_trimesh_scene(scene, loaded)

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
    scene.add(pyrender.DirectionalLight(color=np.ones(3), intensity=1.8), pose=pose)

    fill_pose = np.eye(4, dtype=float)
    fill_pose[:3, 3] = -np.asarray(camera["position"], dtype=float)
    scene.add(pyrender.DirectionalLight(color=np.ones(3), intensity=0.45), pose=fill_pose)

    renderer = pyrender.OffscreenRenderer(viewport_width=width, viewport_height=height)
    try:
        color, _ = renderer.render(scene, flags=pyrender.RenderFlags.RGBA)
        return ensure_rgb(Image.fromarray(color.astype(np.uint8), mode="RGBA"))
    finally:
        renderer.delete()


def draw_adaptive_labels(
    draw: ImageDraw.ImageDraw,
    annotation: dict,
    camera: dict,
    width: int,
    height: int,
    style_scale: int = 1,
    label_resolver: LabelResolver | None = None,
) -> None:
    style_scale = max(1, int(style_scale))
    base = min(width, height) // style_scale
    line_width = max(3, base // 360) * style_scale
    dot_radius = max(5, base // 220) * style_scale
    padding_x = max(10, base // 105) * style_scale
    padding_y = max(7, base // 155) * style_scale

    # Draw leader lines first. Label boxes are drawn afterwards, so the line naturally
    # disappears behind the text area without using a 2D snapping endpoint.
    projected_records = []
    for index, group in enumerate(annotation.get("groups", [])):
        anchor_xy = projected_center(np.asarray(group["anchor"]["point"], dtype=float), camera, width, height)
        label_xy = projected_center(np.asarray(group["label"]["center"], dtype=float), camera, width, height)
        draw.line([tuple(anchor_xy), tuple(label_xy)], fill=(28, 28, 28), width=line_width)
        draw.ellipse(
            [
                anchor_xy[0] - dot_radius,
                anchor_xy[1] - dot_radius,
                anchor_xy[0] + dot_radius,
                anchor_xy[1] + dot_radius,
            ],
            fill=(209, 49, 43),
            outline=(25, 25, 25),
            width=max(1, line_width // 2),
        )
        bounds = projected_label_bounds(
            np.asarray(group["label"]["center"], dtype=float),
            np.asarray(group["label"]["box_size"], dtype=float),
            camera,
            width,
            height,
        )
        projected_records.append((index, group, bounds))

    for index, group, bounds in projected_records:
        left, top, right, bottom = bounds
        box_width = max(1.0, right - left)
        box_height = max(1.0, bottom - top)
        inner_padding_x = min(float(padding_x), box_width * 0.16)
        inner_padding_y = min(float(padding_y), box_height * 0.18)
        if label_resolver is None:
            text = str(group["label"]["text"])
        else:
            text = str(label_resolver(group, index))
        font, text_bbox = fit_font_to_box(draw, text, box_width, box_height, inner_padding_x, inner_padding_y)
        text_w = text_bbox[2] - text_bbox[0]
        text_h = text_bbox[3] - text_bbox[1]
        center_x = (left + right) * 0.5
        center_y = (top + bottom) * 0.5
        text_left = center_x - text_w * 0.5 - text_bbox[0]
        text_top = center_y - text_h * 0.5 - text_bbox[1]
        text_left = min(max(text_left, left + inner_padding_x - text_bbox[0]), right - inner_padding_x - text_w - text_bbox[0])
        text_top = min(max(text_top, top + inner_padding_y - text_bbox[1]), bottom - inner_padding_y - text_h - text_bbox[1])
        draw.rectangle(
            [left, top, right, bottom],
            fill=(255, 255, 250),
            outline=(20, 20, 20),
            width=max(2, line_width // 2),
        )
        draw.text((text_left, text_top), text, fill=(16, 16, 16), font=font)


def draw_antialiased_overlay(
    image: Image.Image,
    annotation: dict,
    camera: dict,
    settings: NewLayoutSettings,
    label_resolver: LabelResolver | None = None,
) -> Image.Image:
    width = int(settings.projection_image_width)
    height = int(settings.projection_image_height)
    scale = max(1, int(settings.projection_annotation_supersample))
    if scale == 1:
        draw_adaptive_labels(ImageDraw.Draw(image), annotation, camera, width, height, label_resolver=label_resolver)
        return image

    overlay = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
    draw_adaptive_labels(
        ImageDraw.Draw(overlay),
        annotation,
        camera,
        width * scale,
        height * scale,
        style_scale=scale,
        label_resolver=label_resolver,
    )
    overlay = overlay.resize((width, height), Image.Resampling.LANCZOS)
    composed = image.convert("RGBA")
    composed.alpha_composite(overlay)
    return ensure_rgb(composed)


def render_projection_image(
    merged_obj_path: Path,
    annotation: dict,
    camera: dict,
    output_path: Path,
    settings: NewLayoutSettings,
    mesh_cache: dict[str, object] | None = None,
    label_resolver: LabelResolver | None = None,
) -> Path:
    width = int(settings.projection_image_width)
    height = int(settings.projection_image_height)
    image = render_object_pyrender(merged_obj_path, camera, width, height, mesh_cache=mesh_cache)
    image = draw_antialiased_overlay(image, annotation, camera, settings, label_resolver=label_resolver)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def render_obj_o_projection_image(
    obj_o_path: Path,
    camera: dict,
    output_path: Path,
    settings: NewLayoutSettings,
    scene_cache: dict[str, object] | None = None,
) -> Path:
    width = int(settings.projection_image_width)
    height = int(settings.projection_image_height)
    image = render_obj_o_pyrender(obj_o_path, camera, width, height, scene_cache=scene_cache)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path)
    return output_path


def build_montage(output_paths: dict[str, str], output_path: Path, settings: NewLayoutSettings) -> Path:
    order = [*VIEW_ORDER, ""]
    width = int(settings.projection_image_width)
    height = int(settings.projection_image_height)
    title_height = max(70, height // 12)
    border = max(5, min(width, height) // 300)
    cell_width = width
    cell_height = height + title_height
    montage = Image.new("RGB", (cell_width * 3 + border * 4, cell_height * 2 + border * 3), (0, 0, 0))
    title_font = load_font(max(28, title_height // 2))
    draw = ImageDraw.Draw(montage)

    for index, name in enumerate(order):
        row = index // 3
        col = index % 3
        x0 = border + col * (cell_width + border)
        y0 = border + row * (cell_height + border)
        draw.rectangle([x0, y0, x0 + cell_width, y0 + cell_height], fill=(255, 255, 255))
        if not name:
            continue
        title_bbox = draw.textbbox((0, 0), name, font=title_font)
        title_w = title_bbox[2] - title_bbox[0]
        title_h = title_bbox[3] - title_bbox[1]
        draw.text(
            (x0 + (cell_width - title_w) * 0.5, y0 + (title_height - title_h) * 0.5 - title_bbox[1]),
            name,
            fill=(0, 0, 0),
            font=title_font,
        )
        with Image.open(output_paths[name]) as image:
            montage.paste(image.convert("RGB"), (x0, y0 + title_height))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    montage.save(output_path)
    return output_path


def render_all_views(
    merged_obj_path: Path,
    annotation: dict,
    projection_root: Path,
    category: str,
    sample_name: str,
    settings: NewLayoutSettings,
    label_resolver: LabelResolver | None = None,
) -> dict[str, str]:
    main_camera = inherit_camera_payload(annotation["camera"])
    cameras = {"main": main_camera}
    cameras.update(
        {
            name: inherit_camera_payload(camera, main_camera)
            for name, camera in annotation["camera"].get("other_camera", {}).items()
        }
    )
    mesh_cache: dict[str, object] = {}
    output_paths: dict[str, str] = {}
    sample_dir = projection_root if not category else projection_root / category / sample_name
    for name in ("main", "up", "down", "left", "right"):
        path = sample_dir / f"{sample_name}-{name}.png"
        render_projection_image(
            merged_obj_path,
            annotation,
            cameras[name],
            path,
            settings,
            mesh_cache=mesh_cache,
            label_resolver=label_resolver,
        )
        output_paths[name] = str(path)
    combined = sample_dir / f"{sample_name}-combined.png"
    output_paths["combined"] = str(build_montage(output_paths, combined, settings))
    return output_paths


def render_all_obj_o_views(
    obj_o_path: Path | dict[str, Path | str],
    annotation: dict,
    projection_root: Path,
    category: str,
    sample_name: str,
    settings: NewLayoutSettings,
) -> dict[str, str]:
    cameras = collect_view_cameras(annotation)
    scene_cache: dict[str, object] = {}
    output_paths: dict[str, str] = {}
    sample_dir = projection_root if not category else projection_root / category / sample_name
    for name in VIEW_ORDER:
        if name not in cameras:
            continue
        view_obj_o_path = Path(obj_o_path[name]) if isinstance(obj_o_path, dict) else Path(obj_o_path)
        path = sample_dir / f"{sample_name}-{name}.png"
        render_obj_o_projection_image(view_obj_o_path, cameras[name], path, settings, scene_cache=scene_cache)
        output_paths[name] = str(path)
    combined = sample_dir / f"{sample_name}-combined.png"
    output_paths["combined"] = str(build_montage(output_paths, combined, settings))
    return output_paths
