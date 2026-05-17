from __future__ import annotations

import json
import mimetypes
import re
import threading
import colorsys
from copy import deepcopy
from dataclasses import replace
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
from PIL import Image, ImageDraw


APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "web_static"
PROJECT_ROOT = APP_ROOT.parents[1]

from camera import build_multiview_camera
from projection import camera_to_world, project_world_to_pixels, to_list, world_to_camera
from rendering import VIEW_ORDER, collect_view_cameras, render_all_obj_o_views
from settings import DEFAULT_SETTINGS, NewLayoutSettings


DATA_ROOT = APP_ROOT / "data"
DATA_INPUT_ROOT = DATA_ROOT / "input"
DATA_OUTPUT_ROOT = DATA_ROOT / "output"
DATA_TEMP_ROOT = DATA_ROOT / "temp"
DEFAULT_DATASET_ROOT = DATA_INPUT_ROOT
DEFAULT_OUTPUT_ROOT = DATA_OUTPUT_ROOT
DEFAULT_PORT = 8780
INPUT_LAYOUT_LEVEL = "layout2"
OUTPUT_LAYOUT_LEVEL = "layout1"
DEFAULT_ANNOTATION_JSON = DEFAULT_DATASET_ROOT / "Layout" / "Chair" / "691" / INPUT_LAYOUT_LEVEL / "Annotation" / "691.json"
DEFAULT_OBJ_P_PATH = DEFAULT_DATASET_ROOT / "Obj-P" / "Chair" / "691" / "691-P.obj"


STATE_LOCK = threading.Lock()
STATE: dict = {
    "annotation_path": None,
    "annotation": None,
    "obj_p_path": None,
    "projection_images": {},
    "part_overlay_images": {},
    "dataset_root": None,
    "output_root": None,
    "adjusted_json_path": None,
}
SNAP_MESH_CACHE: dict[str, tuple[np.ndarray, dict[str, list[list[int]]]]] = {}


def current_editor_name(annotation: dict) -> str:
    return str(annotation.get("editor_name") or annotation.get("annotator_name") or annotation.get("name") or "").strip()


def set_editor_name(annotation: dict, value: str) -> None:
    annotation["editor_name"] = str(value).strip()


def require_editor_name(annotation: dict) -> str:
    name = current_editor_name(annotation)
    if not name:
        raise ValueError("Please enter a name before saving.")
    return name


def numeric_name_key(value: str) -> tuple[int, int | str]:
    return (0, int(value)) if str(value).isdigit() else (1, str(value))


def load_json(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"Annotation JSON does not exist: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def make_group_id(label_text: str, part_id: int | str, ori_id: int | str) -> str:
    return f"{label_text}_{part_id}_{ori_id}"


def safe_stem(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z_\-]+", "_", str(value).strip())
    cleaned = cleaned.strip("_")
    return cleaned or "label"


def ensure_group_id(group: dict, index: int = 0) -> str:
    label = group.setdefault("label", {})
    text = str(label.get("text") or group.get("name") or f"group_{index}")
    part_id = group.get("id", index)
    ori_id = group.get("ori_id", part_id)
    group_id = make_group_id(text, part_id, ori_id)
    group.pop("name", None)
    if group.get("group_id") != group_id or next(iter(group.keys()), None) != "group_id":
        rest = dict(group)
        rest.pop("group_id", None)
        group.clear()
        group["group_id"] = group_id
        group.update(rest)
    return str(group["group_id"])


def normalize_group_ids(annotation: dict) -> None:
    for index, group in enumerate(annotation.get("groups", [])):
        ensure_group_id(group, index)


def annotation_identity(annotation_path: Path, annotation: dict) -> tuple[str, str]:
    model_cat = str(annotation.get("category") or annotation.get("model_cat") or "")
    return model_cat, str(annotation.get("sample_id") or annotation_path.stem)


def layout_dir(output_root: Path, sample_name: str, layout_level: str = OUTPUT_LAYOUT_LEVEL, category: str | None = None) -> Path:
    if not category:
        raise ValueError("Category is required for 3DLPD layout paths.")
    return output_root / "Layout" / category / sample_name / str(layout_level)


def infer_obj_p_path(annotation_path: Path, annotation: dict) -> Path:
    recorded = annotation.get("merged_obj_path")
    if recorded:
        candidate = Path(recorded).expanduser()
        if candidate.is_file():
            return candidate.resolve()

    model_cat, sample_name = annotation_identity(annotation_path, annotation)
    dataset_root = infer_dataset_root(annotation_path)
    for candidate in (
        dataset_root / "Obj-P" / model_cat / sample_name / f"{sample_name}-P.obj",
    ):
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(f"Could not infer OBJ-P path for annotation: {annotation_path}")


def infer_dataset_root(annotation_path: Path) -> Path:
    parts = list(annotation_path.parts)
    upper_parts = [part.upper() for part in parts]
    if "LAYOUT" in upper_parts:
        index = upper_parts.index("LAYOUT")
        if index > 0:
            return Path(*parts[:index]).resolve()
    return annotation_path.parent.resolve()


def output_json_path(output_root: Path, annotation_path: Path, annotation: dict) -> Path:
    category, sample_name = annotation_identity(annotation_path, annotation)
    return layout_dir(output_root, sample_name, OUTPUT_LAYOUT_LEVEL, category) / "Annotation" / f"{sample_name}.json"


def output_mutiviews_dir(output_root: Path, sample_name: str, layout_level: str = OUTPUT_LAYOUT_LEVEL, category: str | None = None) -> Path:
    return layout_dir(output_root, sample_name, layout_level, category) / "Mutiviews"


def output_obj_o_dir(output_root: Path, sample_name: str, layout_level: str = OUTPUT_LAYOUT_LEVEL, category: str | None = None) -> Path:
    return layout_dir(output_root, sample_name, layout_level, category) / "Obj-O"


def output_obj_o_path(output_root: Path, annotation_path: Path, annotation: dict) -> Path:
    category, sample_name = annotation_identity(annotation_path, annotation)
    return output_obj_o_dir(output_root, sample_name, OUTPUT_LAYOUT_LEVEL, category) / f"{sample_name}-main-O.obj"


def projection_filename(sample_name: str, view: str) -> str:
    suffix = "combined" if view == "combined" else view
    return f"{sample_name}-{suffix}.png"


def manual_output_info(output_root: Path | None, sample_name: str, category: str | None = None) -> dict:
    if output_root is None:
        return {"complete": False, "missing": ["output_root"], "layout_dir": None}
    layout_one = layout_dir(Path(output_root).expanduser().resolve(), sample_name, OUTPUT_LAYOUT_LEVEL, category)
    annotation_path = layout_one / "Annotation" / f"{sample_name}.json"
    mutiviews_dir = layout_one / "Mutiviews"
    obj_o_dir = layout_one / "Obj-O"
    rating_dir = layout_one / "Rating"
    required_paths = [annotation_path]
    required_paths.extend(mutiviews_dir / projection_filename(sample_name, view) for view in (*VIEW_ORDER, "combined"))
    required_paths.append(obj_o_dir / f"{sample_name}-O.mtl")
    required_paths.extend(obj_o_dir / f"{sample_name}-{view}-O.obj" for view in VIEW_ORDER)
    missing = [str(path) for path in required_paths if not path.is_file()]
    if not rating_dir.is_dir():
        missing.append(str(rating_dir))
    return {
        "complete": not missing,
        "missing": missing,
        "layout_dir": str(layout_one),
        "annotation_path": str(annotation_path),
        "mutiviews_dir": str(mutiviews_dir),
        "obj_o_dir": str(obj_o_dir),
        "rating_dir": str(rating_dir),
    }


def preview_label_name(index: int) -> str:
    return f"label_{index + 1}"


def preview_label_resolver(_: dict, index: int) -> str:
    return preview_label_name(index)


def resolve_projection_images(
    annotation: dict,
    dataset_root: Path,
    output_root: Path,
    category: str,
    sample_name: str,
    annotation_path: Path | None = None,
) -> dict[str, str]:
    recorded = dict(annotation.get("projection_images") or {})
    resolved: dict[str, str] = {}
    roots: list[Path] = []
    resolved_output_root = Path(output_root).expanduser().resolve()
    if annotation_path is not None:
        roots.append(infer_dataset_root(annotation_path))
    roots.extend([output_root, dataset_root])
    unique_roots: list[Path] = []
    seen_roots: set[str] = set()
    for root in roots:
        resolved_root = Path(root).expanduser().resolve()
        key = str(resolved_root).lower()
        if key not in seen_roots:
            seen_roots.add(key)
            unique_roots.append(resolved_root)
    for view in ("main", "up", "down", "left", "right", "combined"):
        candidates: list[Path] = []
        if recorded.get(view):
            candidates.append(Path(recorded[view]).expanduser())
        for root in unique_roots:
            layout_levels = (OUTPUT_LAYOUT_LEVEL,) if root == resolved_output_root else (INPUT_LAYOUT_LEVEL,)
            for layout_level in layout_levels:
                candidates.append(
                    root
                    / "Layout"
                    / category
                    / sample_name
                    / layout_level
                    / "Mutiviews"
                    / projection_filename(sample_name, view)
                )
            candidates.append(root / "PROJECTION" / category / sample_name / projection_filename(sample_name, view))
        for candidate in candidates:
            candidate = candidate.resolve()
            if candidate.is_file():
                resolved[view] = str(candidate)
                break
    return resolved


def render_preview_views(
    merged_obj_path: Path,
    annotation: dict,
    category: str,
    sample_name: str,
    settings: NewLayoutSettings,
    annotation_path: Path | None = None,
    dataset_root: Path | None = None,
    output_root: Path | None = None,
    obj_o_root: Path | None = None,
) -> dict[str, str]:
    annotation_path = annotation_path or STATE.get("annotation_path")
    dataset_root = dataset_root or STATE.get("dataset_root")
    output_root = output_root or STATE.get("output_root")
    info = text_objs_info(annotation_path, annotation, dataset_root, output_root, merged_obj_path)
    if not info["available"] or not info["text_objs_dir"]:
        missing = ", ".join(info["missing"]) if info["missing"] else "Text_objs directory"
        raise FileNotFoundError(f"Cannot render OBJ-O projection, missing text OBJ resources: {missing}")
    obj_o_dir = obj_o_root or (DATA_TEMP_ROOT / "preview_obj_o" / sample_name)
    obj_o_paths = export_obj_o_for_orientation(
        merged_obj_path,
        annotation,
        Path(info["text_objs_dir"]),
        obj_o_dir,
        sample_name,
        settings,
    )
    return render_all_obj_o_views(
        obj_o_paths,
        annotation,
        DATA_TEMP_ROOT / "preview_projection",
        category,
        sample_name,
        settings,
    )


def sample_json_path(dataset_root: Path, category: str, sample_name: str) -> Path:
    candidates = [
        dataset_root / "Layout" / category / sample_name / INPUT_LAYOUT_LEVEL / "Annotation" / f"{sample_name}.json",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return candidates[0].resolve()


def sample_obj_p_path(dataset_root: Path, category: str, sample_name: str) -> Path | None:
    candidates = [
        dataset_root / "Obj-P" / category / sample_name / f"{sample_name}-P.obj",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def settings_from_annotation(annotation: dict) -> NewLayoutSettings:
    camera = annotation.get("camera") or {}
    projection = annotation.get("_projection") or {}
    return replace(
        DEFAULT_SETTINGS,
        camera_radius=float(camera.get("camera_radius", DEFAULT_SETTINGS.camera_radius)),
        camera_focal_length_mm=float(camera.get("focal_length_mm", DEFAULT_SETTINGS.camera_focal_length_mm)),
        camera_sensor_width_mm=float(camera.get("sensor_width_mm", DEFAULT_SETTINGS.camera_sensor_width_mm)),
        camera_sensor_height_mm=float(camera.get("sensor_height_mm", DEFAULT_SETTINGS.camera_sensor_height_mm)),
        camera_near_clip=float(camera.get("near_clip", DEFAULT_SETTINGS.camera_near_clip)),
        camera_far_clip=float(camera.get("far_clip", DEFAULT_SETTINGS.camera_far_clip)),
        projection_image_width=int(projection.get("image_width", DEFAULT_SETTINGS.projection_image_width)),
        projection_image_height=int(projection.get("image_height", DEFAULT_SETTINGS.projection_image_height)),
        label_orientation_mode=str(projection.get("label_orientation_mode", DEFAULT_SETTINGS.label_orientation_mode)),
    )


def replace_settings(annotation: dict, patch: dict) -> NewLayoutSettings:
    return settings_from_annotation(annotation)


def serialize_camera_payload(camera: dict) -> dict:
    return {
        key: serialize_camera_payload(value) if isinstance(value, dict) else to_list(value) if isinstance(value, np.ndarray) else value
        for key, value in camera.items()
    }


def internal_camera_payload(settings: NewLayoutSettings | None = None) -> dict:
    return serialize_camera_payload(build_multiview_camera(settings or DEFAULT_SETTINGS))


def apply_internal_camera(annotation: dict) -> None:
    annotation["camera"] = internal_camera_payload(DEFAULT_SETTINGS)
    annotation["_projection"] = {
        "image_width": int(DEFAULT_SETTINGS.projection_image_width),
        "image_height": int(DEFAULT_SETTINGS.projection_image_height),
        "label_orientation_mode": str(DEFAULT_SETTINGS.label_orientation_mode),
    }


def sync_group_line(group: dict) -> None:
    label_center = group.get("label", {}).get("center")
    if label_center is None:
        return
    leader_line = group.setdefault("leader_line", {})
    if not leader_line.get("bend_points"):
        leader_line["end"] = list(label_center)


def sync_group_anchor(group: dict) -> None:
    anchor = group.get("anchor", {}).get("point")
    if anchor is None:
        return
    leader_line = group.setdefault("leader_line", {})
    leader_line["start"] = list(anchor)


def group_payload(annotation: dict) -> list[dict]:
    camera = annotation["camera"]
    groups = []
    for index, group in enumerate(annotation.get("groups", [])):
        group_id = ensure_group_id(group, index)
        label_world = np.asarray(group["label"]["center"], dtype=float)
        label_camera = world_to_camera(label_world, camera)[0]
        anchor_world = np.asarray(
            group.get("anchor", {}).get("point") or group.get("leader_line", {}).get("start") or [0.0, 0.0, 0.0],
            dtype=float,
        )
        anchor_camera = world_to_camera(anchor_world, camera)[0]
        groups.append(
            {
                "index": index,
                "group_id": group_id,
                "text": str(group.get("label", {}).get("text") or ""),
                "target_g": list(group.get("target_g") or []),
                "label_world_center": to_list(label_world),
                "label_camera_center": to_list(label_camera),
                "anchor_world": to_list(anchor_world),
                "anchor_camera_center": to_list(anchor_camera),
                "box_size": list(group.get("label", {}).get("box_size") or []),
            }
        )
    return groups


def camera_payload(annotation: dict) -> dict:
    camera = annotation["camera"]
    settings = settings_from_annotation(annotation)
    return {
        "camera_radius": float(camera.get("camera_radius", settings.camera_radius)),
        "focal_length_mm": float(camera.get("focal_length_mm", settings.camera_focal_length_mm)),
        "sensor_width_mm": float(camera.get("sensor_width_mm", settings.camera_sensor_width_mm)),
        "sensor_height_mm": float(camera.get("sensor_height_mm", settings.camera_sensor_height_mm)),
        "near_clip": float(camera.get("near_clip", settings.camera_near_clip)),
        "far_clip": float(camera.get("far_clip", settings.camera_far_clip)),
        "perturb_degrees": float(settings.perturb_degrees),
        "projection_image_width": int(settings.projection_image_width),
        "projection_image_height": int(settings.projection_image_height),
        "label_orientation_mode": str(settings.label_orientation_mode),
    }


def projection_camera_payload(annotation: dict) -> dict[str, dict]:
    main_camera = deepcopy(annotation["camera"])
    cameras = {"main": main_camera}
    allowed_keys = {
        "type",
        "camera_radius",
        "focal_length_mm",
        "sensor_width_mm",
        "sensor_height_mm",
        "near_clip",
        "far_clip",
        "position",
        "x_view",
        "y_view",
        "z_view",
    }
    for name, camera in main_camera.get("other_camera", {}).items():
        inherited = deepcopy(camera)
        for key in (
            "type",
            "camera_radius",
            "focal_length_mm",
            "sensor_width_mm",
            "sensor_height_mm",
            "near_clip",
            "far_clip",
        ):
            if key not in inherited and key in main_camera:
                inherited[key] = main_camera[key]
        cameras[name] = inherited
    return {
        name: {key: value for key, value in camera.items() if key in allowed_keys}
        for name, camera in cameras.items()
    }


def dataset_root_for_annotation(json_path: Path) -> Path:
    parts = list(json_path.parts)
    upper_parts = [part.upper() for part in parts]
    if "LAYOUT" in upper_parts:
        index = upper_parts.index("LAYOUT")
        if index > 0:
            return Path(*parts[:index]).resolve()
    return json_path.parent.resolve()


def sample_record_from_json(json_path: Path, output_root: Path | None = None) -> dict:
    json_path = json_path.resolve()
    dataset_root = dataset_root_for_annotation(json_path)
    category = ""
    sample = json_path.stem
    try:
        payload = load_json(json_path)
        category = str(payload.get("category") or payload.get("model_cat") or category)
        sample = str(payload.get("sample_id") or sample)
    except Exception:
        pass
    obj_path = sample_obj_p_path(dataset_root, category, sample)
    display = f"{category} / {sample}" if category else sample
    if dataset_root != DEFAULT_DATASET_ROOT and DEFAULT_DATASET_ROOT in dataset_root.parents:
        display = f"{dataset_root.name} / {display}"
    output_info = manual_output_info(output_root or DEFAULT_OUTPUT_ROOT, sample, category)
    return {
        "name": sample,
        "display_name": display,
        "category": category,
        "dataset_root": str(dataset_root),
        "annotation_path": str(json_path),
        "obj_p_path": str(obj_path) if obj_path else "",
        "manual_output_complete": bool(output_info["complete"]),
        "manual_output_layout_dir": output_info.get("layout_dir"),
    }


def annotation_level_from_path(json_path: Path | str) -> str:
    parts = list(Path(json_path).parts)
    upper_parts = [part.upper() for part in parts]
    if "ANNOTATION" not in upper_parts:
        return ""
    index = upper_parts.index("ANNOTATION")
    if index <= 0:
        return ""
    return parts[index - 1]


def annotation_level_rank(json_path: Path | str) -> int:
    level = annotation_level_from_path(json_path)
    return {INPUT_LAYOUT_LEVEL: 0, OUTPUT_LAYOUT_LEVEL: 1, "layout3": 2}.get(level, 9)


def dedupe_sample_records(samples: list[dict]) -> list[dict]:
    best: dict[tuple[str, str, str], dict] = {}
    for sample in samples:
        key = (
            str(sample.get("dataset_root") or "").lower(),
            str(sample.get("category") or ""),
            str(sample.get("name") or ""),
        )
        current = best.get(key)
        if current is None or annotation_level_rank(sample["annotation_path"]) < annotation_level_rank(current["annotation_path"]):
            best[key] = sample
    return list(best.values())


def list_annotation_samples(root: Path | str, output_root: Path | str | None = None) -> dict:
    root = Path(root).expanduser().resolve()
    resolved_output_root = Path(output_root).expanduser().resolve() if output_root else DEFAULT_OUTPUT_ROOT
    if not root.is_dir():
        return {"root": str(root), "samples": [], "error": "root does not exist"}

    seen: set[Path] = set()
    samples: list[dict] = []
    direct_roots = [root]
    direct_roots.extend(
        path
        for path in root.iterdir()
        if path.is_dir() and (path / "Layout").is_dir()
    )
    for candidate_root in direct_roots:
        layout_root = candidate_root / "Layout"
        if layout_root.is_dir():
            for json_path in layout_root.glob(f"*/*/{INPUT_LAYOUT_LEVEL}/Annotation/*.json"):
                resolved = json_path.resolve()
                if resolved not in seen:
                    seen.add(resolved)
                    samples.append(sample_record_from_json(resolved, resolved_output_root))

    samples = dedupe_sample_records(samples)
    samples.sort(key=lambda item: (item.get("category") or "", numeric_name_key(item["name"]), item["annotation_path"]))
    categories: dict[str, dict] = {}
    for sample in samples:
        category = sample.get("category") or "(root)"
        entry = categories.setdefault(category, {"name": category, "path": "", "count": 0, "samples": []})
        entry["samples"].append(sample)
        entry["count"] += 1
    return {"root": str(root), "samples": samples, "categories": list(categories.values())}


def candidate_obj_o_dirs(
    annotation_path: Path,
    annotation: dict,
    dataset_root: Path | None,
    output_root: Path | None,
) -> list[Path]:
    category, sample_name = annotation_identity(annotation_path, annotation)
    roots: list[tuple[Path, tuple[str, ...]]] = []
    if output_root is not None:
        roots.append((Path(output_root).expanduser().resolve(), (OUTPUT_LAYOUT_LEVEL,)))
    if dataset_root is not None:
        roots.append((Path(dataset_root).expanduser().resolve(), (INPUT_LAYOUT_LEVEL,)))
    inferred = infer_dataset_root(annotation_path)
    roots.append((inferred, (INPUT_LAYOUT_LEVEL,)))

    result: list[Path] = []
    seen: set[str] = set()
    for root, levels in roots:
        for level in levels:
            for candidate in (
                root / "Layout" / category / sample_name / level / "Obj-O",
            ):
                key = str(candidate).lower()
                if key not in seen:
                    seen.add(key)
                    result.append(candidate)
    return result


def obj_o_info_from_dir(obj_o_dir: Path, sample_name: str) -> dict:
    obj_o_dir = Path(obj_o_dir).expanduser().resolve()
    adaptive_paths = {view: obj_o_dir / f"{sample_name}-{view}-O.obj" for view in VIEW_ORDER}
    existing_adaptive = {view: str(path.resolve()) for view, path in adaptive_paths.items() if path.is_file()}
    fixed_path = obj_o_dir / f"{sample_name}-O.obj"
    if existing_adaptive:
        mtl_path = obj_o_dir / f"{sample_name}-O.mtl"
        main_path = existing_adaptive.get("main") or next(iter(existing_adaptive.values()))
        return {
            "mode": "adaptive",
            "dir": str(obj_o_dir),
            "paths": existing_adaptive,
            "path": main_path,
            "mtl_path": str(mtl_path.resolve()) if mtl_path.is_file() else None,
            "exists": True,
            "exists_by_view": {view: view in existing_adaptive for view in VIEW_ORDER},
        }
    if fixed_path.is_file():
        mtl_path = fixed_path.with_suffix(".mtl")
        fixed = str(fixed_path.resolve())
        return {
            "mode": "fixed",
            "dir": str(obj_o_dir),
            "paths": {view: fixed for view in VIEW_ORDER},
            "path": fixed,
            "mtl_path": str(mtl_path.resolve()) if mtl_path.is_file() else None,
            "exists": True,
            "exists_by_view": {view: True for view in VIEW_ORDER},
        }
    return {
        "mode": "missing",
        "dir": str(obj_o_dir),
        "paths": {},
        "path": None,
        "mtl_path": None,
        "exists": False,
        "exists_by_view": {view: False for view in VIEW_ORDER},
    }


def resolve_obj_o_sources(
    annotation_path: Path,
    annotation: dict,
    dataset_root: Path | None,
    output_root: Path | None,
) -> dict[str, dict]:
    category, sample_name = annotation_identity(annotation_path, annotation)
    input_candidates = candidate_obj_o_dirs(annotation_path, annotation, dataset_root, None)
    input_info = obj_o_info_from_dir(input_candidates[0], sample_name)
    for candidate in input_candidates:
        candidate_info = obj_o_info_from_dir(candidate, sample_name)
        if candidate_info["exists"]:
            input_info = candidate_info
            break
    resolved_output_root = Path(output_root).expanduser().resolve() if output_root else DEFAULT_OUTPUT_ROOT
    return {
        "input": input_info,
        "output": obj_o_info_from_dir(output_obj_o_dir(resolved_output_root, sample_name, OUTPUT_LAYOUT_LEVEL, category), sample_name),
        "temp": obj_o_info_from_dir(DATA_TEMP_ROOT / "preview_obj_o" / sample_name, sample_name),
    }


def resolve_obj_o_info(
    annotation_path: Path,
    annotation: dict,
    dataset_root: Path | None,
    output_root: Path | None,
) -> dict:
    _, sample_name = annotation_identity(annotation_path, annotation)
    for obj_o_dir in candidate_obj_o_dirs(annotation_path, annotation, dataset_root, output_root):
        info = obj_o_info_from_dir(obj_o_dir, sample_name)
        if info["exists"]:
            return info
    return obj_o_info_from_dir(DATA_TEMP_ROOT / "missing_obj_o" / sample_name, sample_name)


def current_state_payload() -> dict:
    with STATE_LOCK:
        annotation = deepcopy(STATE["annotation"])
        annotation_path = STATE["annotation_path"]
        obj_p_path = STATE["obj_p_path"]
        projection_images = dict(STATE.get("projection_images") or {})
        part_overlay_images = dict(STATE.get("part_overlay_images") or {})
        dataset_root = STATE.get("dataset_root")
        output_root = STATE.get("output_root")
        adjusted_json_path = STATE.get("adjusted_json_path")
    if annotation is None:
        return {"loaded": False}
    text_info = text_objs_info(annotation_path, annotation, dataset_root, output_root, obj_p_path)
    obj_o_sources = resolve_obj_o_sources(annotation_path, annotation, dataset_root, output_root) if annotation_path else {}
    obj_o_default_source = next((name for name in ("input", "output", "temp") if obj_o_sources.get(name, {}).get("exists")), "input")
    obj_o_info = obj_o_sources.get(obj_o_default_source) or {}
    category, sample_name = annotation_identity(annotation_path, annotation)
    output_info = manual_output_info(output_root, sample_name, category)
    return {
        "loaded": True,
        "dataset_root": str(dataset_root) if dataset_root else None,
        "output_root": str(output_root) if output_root else None,
        "annotation_path": str(annotation_path),
        "obj_p_path": str(obj_p_path),
        "adjusted_json_path": str(adjusted_json_path) if adjusted_json_path else None,
        "editor_name": current_editor_name(annotation),
        "obj_o_mode": obj_o_info.get("mode"),
        "obj_o_path": obj_o_info.get("path"),
        "obj_o_paths": obj_o_info.get("paths") or {},
        "obj_o_exists_by_view": obj_o_info.get("exists_by_view") or {},
        "obj_o_mtl_path": obj_o_info.get("mtl_path"),
        "obj_o_mtl_paths": {view: obj_o_info.get("mtl_path") for view in VIEW_ORDER if obj_o_info.get("mtl_path")},
        "obj_o_exists": bool(obj_o_info.get("exists")),
        "obj_o_mtl_exists": bool(obj_o_info.get("mtl_path")),
        "obj_o_sources": obj_o_sources,
        "obj_o_default_source": obj_o_default_source,
        "text_objs_available": bool(text_info["available"]),
        "text_objs_dir": text_info["text_objs_dir"],
        "missing_text_objs": text_info["missing"],
        "camera": camera_payload(annotation),
        "view_cameras": projection_camera_payload(annotation),
        "groups": group_payload(annotation),
        "projection_images": projection_images,
        "part_overlay_images": part_overlay_images,
        "manual_output_complete": bool(output_info["complete"]),
        "manual_output_info": output_info,
    }


def parse_obj_group_faces(obj_path: Path) -> tuple[np.ndarray, list[tuple[str, list[list[int]]]]]:
    vertices: list[list[float]] = []
    groups: list[tuple[str, list[list[int]]]] = []
    current_name = "object"
    current_faces: list[list[int]] = []

    def push_group() -> None:
        nonlocal current_faces
        if current_faces:
            groups.append((current_name, current_faces))
            current_faces = []

    with Path(obj_path).open("r", encoding="utf-8", errors="ignore") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("v "):
                parts = line.split()
                if len(parts) >= 4:
                    vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
                continue
            if line.startswith("g ") or line.startswith("o "):
                if line.startswith("g "):
                    push_group()
                    current_name = line[2:].strip() or "object"
                continue
            if line.startswith("f "):
                face: list[int] = []
                for token in line.split()[1:]:
                    raw_index = token.split("/")[0]
                    if not raw_index:
                        continue
                    index = int(raw_index)
                    if index < 0:
                        index = len(vertices) + index + 1
                    face.append(index - 1)
                if len(face) >= 3:
                    current_faces.append(face)
    push_group()
    return np.asarray(vertices, dtype=float), groups


def cached_obj_group_face_map(obj_path: Path) -> tuple[np.ndarray, dict[str, list[list[int]]]]:
    cache_key = str(Path(obj_path).resolve())
    cached = SNAP_MESH_CACHE.get(cache_key)
    if cached is not None:
        return cached
    vertices, groups = parse_obj_group_faces(obj_path)
    group_faces: dict[str, list[list[int]]] = {}
    for name, faces in groups:
        group_faces.setdefault(name, []).extend(faces)
    cached = (vertices, group_faces)
    SNAP_MESH_CACHE[cache_key] = cached
    return cached


def closest_point_on_triangle(point: np.ndarray, a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    ab = b - a
    ac = c - a
    ap = point - a
    d1 = float(np.dot(ab, ap))
    d2 = float(np.dot(ac, ap))
    if d1 <= 0.0 and d2 <= 0.0:
        return a

    bp = point - b
    d3 = float(np.dot(ab, bp))
    d4 = float(np.dot(ac, bp))
    if d3 >= 0.0 and d4 <= d3:
        return b

    vc = d1 * d4 - d3 * d2
    if vc <= 0.0 and d1 >= 0.0 and d3 <= 0.0:
        v = d1 / max(d1 - d3, 1e-12)
        return a + v * ab

    cp = point - c
    d5 = float(np.dot(ab, cp))
    d6 = float(np.dot(ac, cp))
    if d6 >= 0.0 and d5 <= d6:
        return c

    vb = d5 * d2 - d1 * d6
    if vb <= 0.0 and d2 >= 0.0 and d6 <= 0.0:
        w = d2 / max(d2 - d6, 1e-12)
        return a + w * ac

    va = d3 * d6 - d5 * d4
    if va <= 0.0 and (d4 - d3) >= 0.0 and (d5 - d6) >= 0.0:
        w = (d4 - d3) / max((d4 - d3) + (d5 - d6), 1e-12)
        return b + w * (c - b)

    denom = max(va + vb + vc, 1e-12)
    v = vb / denom
    w = vc / denom
    return a + ab * v + ac * w


def closest_point_on_target_groups(
    point: np.ndarray,
    obj_path: Path,
    target_g: list[str],
) -> tuple[np.ndarray, float, float, int]:
    vertices, group_faces = cached_obj_group_face_map(obj_path)
    if vertices.size == 0:
        raise ValueError(f"OBJ-P has no vertices: {obj_path}")
    target_faces: list[list[int]] = []
    for name in target_g:
        target_faces.extend(group_faces.get(str(name), []))
    if not target_faces:
        raise ValueError(f"target_g not found in OBJ-P: {target_g}")

    target_vertex_indices: set[int] = set()
    best_point: np.ndarray | None = None
    best_dist2 = float("inf")
    triangle_count = 0
    for face in target_faces:
        if len(face) < 3 or any(index < 0 or index >= len(vertices) for index in face):
            continue
        for index in face:
            target_vertex_indices.add(index)
        anchor = face[0]
        for cursor in range(1, len(face) - 1):
            tri = [anchor, face[cursor], face[cursor + 1]]
            a, b, c = vertices[tri]
            nearest = closest_point_on_triangle(point, a, b, c)
            dist2 = float(np.dot(point - nearest, point - nearest))
            triangle_count += 1
            if dist2 < best_dist2:
                best_dist2 = dist2
                best_point = nearest
    if best_point is None or not np.isfinite(best_dist2):
        raise ValueError(f"No valid target faces for target_g: {target_g}")

    model_diag = float(np.linalg.norm(np.ptp(vertices, axis=0)))
    target_vertices = vertices[sorted(target_vertex_indices)] if target_vertex_indices else vertices
    target_diag = float(np.linalg.norm(np.ptp(target_vertices, axis=0))) if len(target_vertices) else 0.0
    tolerance = max(model_diag * 0.0015, target_diag * 0.01, 1e-5)
    return best_point, float(np.sqrt(best_dist2)), tolerance, triangle_count


def snap_group_anchor_to_target(annotation: dict, obj_p_path: Path, index: int) -> dict:
    groups = annotation.get("groups") or []
    if index < 0 or index >= len(groups):
        raise IndexError(f"Anchor index out of range: {index}")
    group = groups[index]
    group_id = ensure_group_id(group, index)
    target_g = [str(name) for name in (group.get("target_g") or []) if str(name).strip()]
    if not target_g:
        return {"available": False, "snapped": False, "index": index, "group_id": group_id, "reason": "missing target_g"}
    anchor = group.get("anchor", {}).get("point") or group.get("leader_line", {}).get("start")
    if anchor is None:
        return {"available": False, "snapped": False, "index": index, "group_id": group_id, "reason": "missing anchor"}

    anchor_point = np.asarray(anchor, dtype=float)
    nearest, distance, tolerance, triangle_count = closest_point_on_target_groups(anchor_point, obj_p_path, target_g)
    snapped = bool(distance > tolerance)
    if snapped:
        group.setdefault("anchor", {})["point"] = to_list(nearest)
        sync_group_anchor(group)
    camera_anchor = world_to_camera(nearest if snapped else anchor_point, annotation["camera"])[0]
    return {
        "available": True,
        "snapped": snapped,
        "index": index,
        "group_id": group_id,
        "target_g": target_g,
        "distance": distance,
        "tolerance": tolerance,
        "triangle_count": triangle_count,
        "anchor_world": to_list(nearest if snapped else anchor_point),
        "anchor_camera_center": to_list(camera_anchor),
    }


def snap_anchor_in_state(index: int) -> dict:
    with STATE_LOCK:
        annotation = STATE["annotation"]
        obj_p_path = STATE["obj_p_path"]
        if annotation is None or obj_p_path is None:
            raise ValueError("No annotation loaded.")
        report = snap_group_anchor_to_target(annotation, obj_p_path, index)
    payload = current_state_payload()
    payload["anchor_snap_report"] = report
    return payload


def snap_all_anchors_in_state() -> dict:
    reports = []
    with STATE_LOCK:
        annotation = STATE["annotation"]
        obj_p_path = STATE["obj_p_path"]
        if annotation is None or obj_p_path is None:
            return {"reports": [], "snapped_count": 0}
        for index, _group in enumerate(annotation.get("groups", [])):
            try:
                reports.append(snap_group_anchor_to_target(annotation, obj_p_path, index))
            except Exception as exc:
                reports.append({"available": False, "snapped": False, "index": index, "reason": str(exc)})
    return {"reports": reports, "snapped_count": sum(1 for item in reports if item.get("snapped"))}


def part_color(index: int) -> tuple[int, int, int, int]:
    palette = [
        (222, 72, 66, 88),
        (44, 127, 184, 88),
        (49, 163, 84, 88),
        (156, 99, 190, 88),
        (232, 150, 38, 88),
        (35, 154, 160, 88),
        (213, 83, 140, 88),
        (132, 132, 42, 88),
    ]
    return palette[index % len(palette)]


def render_part_overlay_image(
    obj_path: Path,
    camera: dict,
    output_path: Path,
    width: int,
    height: int,
    parsed_cache: dict[str, object] | None = None,
) -> Path:
    cache_key = str(Path(obj_path).resolve())
    parsed = parsed_cache.get(cache_key) if parsed_cache is not None else None
    if parsed is None:
        parsed = parse_obj_group_faces(obj_path)
        if parsed_cache is not None:
            parsed_cache[cache_key] = parsed
    vertices, groups = parsed
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    if vertices.size == 0 or not groups:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        overlay.save(output_path)
        return output_path

    try:
        projected = project_world_to_pixels(vertices, camera, width, height)
        camera_vertices = world_to_camera(vertices, camera)
    except Exception:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        overlay.save(output_path)
        return output_path

    draw = ImageDraw.Draw(overlay, "RGBA")
    drawable_faces: list[tuple[float, int, list[tuple[float, float]]]] = []
    for group_index, (_name, faces) in enumerate(groups):
        for face in faces:
            if any(index < 0 or index >= len(vertices) for index in face):
                continue
            points = [(float(projected[index, 0]), float(projected[index, 1])) for index in face]
            depth = float(np.mean(-camera_vertices[face, 2]))
            drawable_faces.append((depth, group_index, points))
    for _depth, group_index, points in sorted(drawable_faces, key=lambda item: item[0], reverse=True):
        color = part_color(group_index)
        draw.polygon(points, fill=color)
        outline = (color[0], color[1], color[2], min(175, color[3] + 75))
        draw.line(points + [points[0]], fill=outline, width=1)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    overlay.save(output_path)
    return output_path


def render_part_overlay_views(
    obj_path: Path,
    annotation: dict,
    overlay_root: Path,
    category: str,
    sample_name: str,
    settings: NewLayoutSettings,
) -> dict[str, str]:
    width = int(settings.projection_image_width)
    height = int(settings.projection_image_height)
    cameras = projection_camera_payload(annotation)
    parsed_cache: dict[str, object] = {}
    output_paths: dict[str, str] = {}
    sample_dir = overlay_root / category / sample_name
    for view in ("main", "up", "down", "left", "right"):
        if view not in cameras:
            continue
        output_path = sample_dir / f"{sample_name}-{view}-parts.png"
        render_part_overlay_image(obj_path, cameras[view], output_path, width, height, parsed_cache)
        output_paths[view] = str(output_path)
    return output_paths


def candidate_dataset_roots(
    annotation_path: Path,
    dataset_root: Path | None,
    output_root: Path | None,
    obj_p_path: Path | None,
) -> list[Path]:
    roots: list[Path] = []
    for root in (infer_dataset_root(annotation_path), dataset_root, output_root):
        if root is not None:
            roots.append(Path(root).expanduser().resolve())
    if obj_p_path is not None:
        obj_path = Path(obj_p_path).expanduser().resolve()
        upper_parts = [part.upper() for part in obj_path.parts]
        if "OBJ-P" in upper_parts:
            index = upper_parts.index("OBJ-P")
            if index > 0:
                roots.append(Path(*obj_path.parts[:index]).resolve())
    unique: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        key = str(root).lower()
        if key not in seen:
            seen.add(key)
            unique.append(root)
    return unique


def find_text_objs_dir(
    annotation_path: Path,
    annotation: dict,
    dataset_root: Path | None,
    output_root: Path | None,
    obj_p_path: Path | None,
) -> Path | None:
    category, sample_name = annotation_identity(annotation_path, annotation)
    for root in candidate_dataset_roots(annotation_path, dataset_root, output_root, obj_p_path):
        candidates = [root / "Text_objs" / category / sample_name]
        for candidate in candidates:
            if candidate.is_dir():
                return candidate.resolve()
    return None


def resolve_text_obj_path(group: dict, text_objs_dir: Path | None) -> Path | None:
    label_text = str(group.get("label", {}).get("text") or group.get("group_id") or "")
    candidates: list[Path] = []
    if text_objs_dir is not None:
        candidates.append(text_objs_dir / f"{safe_stem(label_text)}.obj")
        recorded = group.get("label", {}).get("text_obj_path")
        if recorded:
            candidates.append(text_objs_dir / Path(recorded).name)
    recorded = group.get("label", {}).get("text_obj_path")
    if recorded:
        candidates.append(Path(recorded).expanduser())
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.is_file():
            return resolved
    return None


def text_objs_info(
    annotation_path: Path,
    annotation: dict,
    dataset_root: Path | None,
    output_root: Path | None,
    obj_p_path: Path | None,
) -> dict:
    text_objs_dir = find_text_objs_dir(annotation_path, annotation, dataset_root, output_root, obj_p_path)
    missing: list[str] = []
    paths: dict[str, str] = {}
    for index, group in enumerate(annotation.get("groups", [])):
        group_id = ensure_group_id(group, index)
        text_obj_path = resolve_text_obj_path(group, text_objs_dir)
        if text_obj_path is None:
            missing.append(group_id)
        else:
            paths[group_id] = str(text_obj_path)
    return {
        "available": text_objs_dir is not None and not missing,
        "text_objs_dir": str(text_objs_dir) if text_objs_dir else None,
        "missing": missing,
        "paths": paths,
    }


def count_obj_vertices(obj_path: Path) -> int:
    count = 0
    with Path(obj_path).open("r", encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if line.startswith("v "):
                count += 1
    return count


def parse_text_obj_mesh(obj_path: Path) -> tuple[np.ndarray, list[list[int]], list[str]]:
    vertices: list[list[float]] = []
    faces: list[list[int]] = []
    face_materials: list[str] = []
    current_material = "label_text_black"
    with Path(obj_path).open("r", encoding="utf-8", errors="ignore") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("usemtl "):
                current_material = line.split(None, 1)[1].strip() or current_material
                continue
            if line.startswith("v "):
                parts = line.split()
                if len(parts) >= 4:
                    vertices.append([float(parts[1]), float(parts[2]), float(parts[3])])
                continue
            if line.startswith("f "):
                face: list[int] = []
                for token in line.split()[1:]:
                    raw_index = token.split("/")[0]
                    if not raw_index:
                        continue
                    index = int(raw_index)
                    if index < 0:
                        index = len(vertices) + index + 1
                    face.append(index - 1)
                if len(face) >= 3:
                    faces.append(face)
                    face_materials.append(current_material)
    return np.asarray(vertices, dtype=float), faces, face_materials


def transform_text_vertices(vertices: np.ndarray, group: dict, camera: dict) -> np.ndarray:
    """Scale the whole label OBJ bbox to label.box_size.

    The current Text_objs already include the panel, so the annotation box size
    is treated as the panel size rather than the raw text glyph bounds.
    """

    if vertices.size == 0:
        return vertices
    label = group.get("label", {})
    center = np.asarray(label["center"], dtype=float)
    box_size = np.asarray(label.get("box_size") or [1.0, 0.2, 0.02], dtype=float)
    local_min = np.min(vertices, axis=0)
    local_max = np.max(vertices, axis=0)
    local_center = (local_min + local_max) * 0.5
    local_size = np.maximum(local_max - local_min, 1e-9)
    local = vertices - local_center
    x_view = normalized_vector(np.asarray(camera["x_view"], dtype=float))
    y_view = normalized_vector(np.asarray(camera["y_view"], dtype=float))
    z_view = normalized_vector(np.asarray(camera["z_view"], dtype=float))
    scale_x = float(box_size[0]) / float(local_size[0])
    scale_y = float(box_size[1]) / float(local_size[1])
    scale_z = float(box_size[2]) / float(local_size[2])
    return (
        center
        + local[:, 0:1] * scale_x * x_view
        + local[:, 1:2] * scale_y * y_view
        + local[:, 2:3] * scale_z * z_view
    )


def safe_material_name(value: str) -> str:
    return safe_stem(value).replace("-", "_")


def anchor_region_color(index: int) -> tuple[float, float, float]:
    hue = (0.07 + index * 0.61803398875) % 1.0
    red, green, blue = colorsys.hsv_to_rgb(hue, 0.62, 0.88)
    return float(red), float(green), float(blue)


def build_obj_o_materials(annotation: dict) -> tuple[dict[str, tuple[float, float, float]], dict[str, str]]:
    materials: dict[str, tuple[float, float, float]] = {
        "object_default": (0.72, 0.72, 0.72),
        "label_text_black": (0.0, 0.0, 0.0),
        "label_panel_face": (0.96, 0.94, 0.82),
        "label_panel_border": (0.06, 0.06, 0.055),
        "leader_line_color": (0.95, 0.18, 0.08),
    }
    group_materials: dict[str, str] = {}
    for index, group in enumerate(annotation.get("groups", [])):
        group_id = str(group.get("group_id") or group.get("label", {}).get("text") or f"region_{index + 1}")
        material = f"anchor_region_{index + 1}_{safe_material_name(group_id)}"
        materials[material] = anchor_region_color(index)
        for target_group in group.get("target_g") or []:
            group_materials[str(target_group)] = material
    return materials, group_materials


def write_mtl_file(path: Path, materials: dict[str, tuple[float, float, float]]) -> None:
    lines = ["# Materials exported by manual_adjust_app"]
    for name, color in materials.items():
        red, green, blue = color
        lines.extend(
            [
                f"newmtl {name}",
                f"Ka {red:.6f} {green:.6f} {blue:.6f}",
                f"Kd {red:.6f} {green:.6f} {blue:.6f}",
                "Ks 0.050000 0.050000 0.050000",
                "Ns 16.000000",
                "d 1.000000",
                "illum 2",
                "",
            ]
        )
    path.write_text("\n".join(lines), encoding="utf-8", newline="\n")


def colorized_base_obj_lines(obj_p_path: Path, mtl_filename: str, group_materials: dict[str, str]) -> list[str]:
    lines = [f"mtllib {mtl_filename}", "usemtl object_default"]
    for raw_line in Path(obj_p_path).read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("mtllib ") or stripped.startswith("usemtl "):
            continue
        lines.append(raw_line.rstrip())
        if stripped.startswith("g "):
            group_name = stripped[2:].strip()
            lines.append(f"usemtl {group_materials.get(group_name, 'object_default')}")
    return lines


def append_transformed_text_obj(
    lines: list[str],
    vertex_offset: int,
    group: dict,
    text_obj_path: Path,
    camera: dict,
    material_name: str = "label_text_black",
) -> int:
    vertices, faces, face_materials = parse_text_obj_mesh(text_obj_path)
    if vertices.size == 0:
        return vertex_offset
    transformed = transform_text_vertices(vertices, group, camera)
    group_id = str(group.get("group_id") or group.get("label", {}).get("text") or "label")
    lines.append(f"o label_{safe_stem(group_id)}")
    for vertex in transformed:
        lines.append(f"v {vertex[0]:.9f} {vertex[1]:.9f} {vertex[2]:.9f}")
    current_material = None
    for face, face_material in zip(faces, face_materials):
        face_material = face_material or material_name
        if face_material != current_material:
            lines.append(f"usemtl {face_material}")
            current_material = face_material
        indices = " ".join(str(vertex_offset + index + 1) for index in face)
        lines.append(f"f {indices}")
    return vertex_offset + len(transformed)


def normalized_vector(values: np.ndarray) -> np.ndarray:
    length = float(np.linalg.norm(values))
    if length < 1e-12:
        return values
    return values / length


def leader_tube_radius(group: dict) -> float:
    box_size = np.asarray(group.get("label", {}).get("box_size") or [1.0, 0.16, 0.02], dtype=float)
    if box_size.size < 2:
        return 0.006
    radius = float(np.min(box_size[:2])) * 0.035
    return float(np.clip(radius, 0.004, 0.012))


def clipped_label_boundary_point(group: dict, source: np.ndarray, target: np.ndarray, camera: dict) -> np.ndarray:
    label = group.get("label", {})
    if "center" not in label or "box_size" not in label:
        return target
    center = np.asarray(label["center"], dtype=float)
    box_size = np.asarray(label["box_size"], dtype=float)
    if box_size.size < 3:
        return target
    axes = [
        normalized_vector(np.asarray(camera["x_view"], dtype=float)),
        normalized_vector(np.asarray(camera["y_view"], dtype=float)),
        normalized_vector(np.asarray(camera["z_view"], dtype=float)),
    ]
    half = np.maximum(box_size * 0.5, 1e-9)
    target_local = np.asarray([float(np.dot(target - center, axis)) for axis in axes], dtype=float)
    target_ratio = np.max(np.abs(target_local) / half)
    if target_ratio > 1.0 + 1e-6:
        return target
    source_local = np.asarray([float(np.dot(source - center, axis)) for axis in axes], dtype=float)
    source_ratio = np.max(np.abs(source_local) / half)
    if source_ratio <= 1.0 + 1e-6:
        return target
    return center + (source - center) / source_ratio


def leader_polyline_points(group: dict, camera: dict) -> list[np.ndarray]:
    leader_line = group.get("leader_line") or {}
    start = leader_line.get("start") or group.get("anchor", {}).get("point")
    end = leader_line.get("end") or group.get("label", {}).get("center")
    if start is None or end is None:
        return []
    points = [np.asarray(start, dtype=float)]
    points.extend(np.asarray(point, dtype=float) for point in (leader_line.get("bend_points") or []))
    points.append(np.asarray(end, dtype=float))
    if len(points) >= 2:
        points[-1] = clipped_label_boundary_point(group, points[-2], points[-1], camera)
    return points


def append_tube_segment(
    lines: list[str],
    vertex_offset: int,
    start: np.ndarray,
    end: np.ndarray,
    radius: float,
    sides: int = 10,
) -> int:
    direction = end - start
    length = float(np.linalg.norm(direction))
    if length < 1e-9:
        return vertex_offset
    direction = direction / length
    helper = np.array([0.0, 0.0, 1.0], dtype=float)
    if abs(float(np.dot(direction, helper))) > 0.92:
        helper = np.array([0.0, 1.0, 0.0], dtype=float)
    axis_u = normalized_vector(np.cross(direction, helper))
    axis_v = normalized_vector(np.cross(direction, axis_u))

    base_index = vertex_offset + 1
    for center in (start, end):
        for side in range(sides):
            angle = 2.0 * np.pi * side / sides
            point = center + radius * (np.cos(angle) * axis_u + np.sin(angle) * axis_v)
            lines.append(f"v {point[0]:.9f} {point[1]:.9f} {point[2]:.9f}")
    start_center_index = base_index + sides * 2
    end_center_index = start_center_index + 1
    lines.append(f"v {start[0]:.9f} {start[1]:.9f} {start[2]:.9f}")
    lines.append(f"v {end[0]:.9f} {end[1]:.9f} {end[2]:.9f}")

    for side in range(sides):
        next_side = (side + 1) % sides
        a = base_index + side
        b = base_index + next_side
        c = base_index + sides + next_side
        d = base_index + sides + side
        lines.append(f"f {a} {b} {c} {d}")
        lines.append(f"f {start_center_index} {b} {a}")
        lines.append(f"f {end_center_index} {d} {c}")
    return vertex_offset + sides * 2 + 2


def append_leader_tubes(lines: list[str], vertex_offset: int, annotation: dict) -> int:
    camera = annotation["camera"]
    for group in annotation.get("groups", []):
        points = leader_polyline_points(group, camera)
        if len(points) < 2:
            continue
        object_written = False
        radius = leader_tube_radius(group)
        for start, end in zip(points[:-1], points[1:]):
            if float(np.linalg.norm(end - start)) < 1e-9:
                continue
            if not object_written:
                group_id = str(group.get("group_id") or group.get("label", {}).get("text") or "leader")
                lines.append(f"o leader_{safe_stem(group_id)}")
                lines.append("usemtl leader_line_color")
                object_written = True
            vertex_offset = append_tube_segment(lines, vertex_offset, start, end, radius)
    return vertex_offset


def export_annotated_obj_o(
    obj_p_path: Path,
    annotation: dict,
    text_objs_dir: Path,
    output_path: Path,
    mtl_path: Path | None = None,
    mtl_reference: str | None = None,
    write_mtl: bool = True,
) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    normalize_group_ids(annotation)
    mtl_path = Path(mtl_path) if mtl_path is not None else output_path.with_suffix(".mtl")
    materials, group_materials = build_obj_o_materials(annotation)
    if write_mtl:
        mtl_path.parent.mkdir(parents=True, exist_ok=True)
        write_mtl_file(mtl_path, materials)
    mtl_name = mtl_reference or mtl_path.name
    lines = [
        *colorized_base_obj_lines(obj_p_path, mtl_name, group_materials),
        "",
        "# ---- annotated labels exported by manual_adjust_app ----",
    ]
    vertex_offset = count_obj_vertices(obj_p_path)
    camera = annotation["camera"]
    for group in annotation.get("groups", []):
        text_obj_path = resolve_text_obj_path(group, text_objs_dir)
        if text_obj_path is None:
            raise FileNotFoundError(f"Missing text OBJ for group: {group.get('group_id')}")
        vertex_offset = append_transformed_text_obj(lines, vertex_offset, group, text_obj_path, camera)
    vertex_offset = append_leader_tubes(lines, vertex_offset, annotation)
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return output_path


def is_adaptive_label_orientation(settings: NewLayoutSettings) -> bool:
    return str(settings.label_orientation_mode).lower() in {
        "adaptive",
        "view_adaptive",
        "adaptive_view",
        "view_facing",
        "per_view",
    }


def annotation_for_view_camera(annotation: dict, camera: dict, view_name: str) -> dict:
    view_annotation = deepcopy(annotation)
    view_camera = deepcopy(camera)
    view_camera.pop("other_camera", None)
    view_annotation["camera"] = view_camera
    view_annotation["_label_orientation_view"] = view_name
    return view_annotation


def export_obj_o_for_orientation(
    obj_p_path: Path,
    annotation: dict,
    text_objs_dir: Path,
    obj_o_dir: Path,
    sample_name: str,
    settings: NewLayoutSettings,
) -> Path | dict[str, Path]:
    obj_o_dir.mkdir(parents=True, exist_ok=True)
    if not is_adaptive_label_orientation(settings):
        return export_annotated_obj_o(
            obj_p_path,
            annotation,
            text_objs_dir,
            obj_o_dir / f"{sample_name}-O.obj",
        )

    cameras = collect_view_cameras(annotation)
    shared_mtl_path = obj_o_dir / f"{sample_name}-O.mtl"
    output_paths: dict[str, Path] = {}
    for index, view_name in enumerate(VIEW_ORDER):
        view_annotation = annotation_for_view_camera(annotation, cameras[view_name], view_name)
        output_path = obj_o_dir / f"{sample_name}-{view_name}-O.obj"
        output_paths[view_name] = export_annotated_obj_o(
            obj_p_path,
            view_annotation,
            text_objs_dir,
            output_path,
            mtl_path=shared_mtl_path,
            mtl_reference=shared_mtl_path.name,
            write_mtl=index == 0,
        )
    return output_paths


def export_current_obj_o() -> dict:
    snap_report = snap_all_anchors_in_state()
    with STATE_LOCK:
        annotation = deepcopy(STATE["annotation"])
        annotation_path = STATE["annotation_path"]
        obj_p_path = STATE["obj_p_path"]
        dataset_root = STATE["dataset_root"]
        output_root = STATE["output_root"]
    if annotation is None or annotation_path is None or obj_p_path is None:
        raise ValueError("No annotation loaded.")
    require_editor_name(annotation)
    info = text_objs_info(annotation_path, annotation, dataset_root, output_root, obj_p_path)
    if not info["available"] or not info["text_objs_dir"]:
        missing = ", ".join(info["missing"]) if info["missing"] else "Text_objs directory"
        raise FileNotFoundError(f"Cannot export OBJ-O, missing text OBJ resources: {missing}")
    settings = settings_from_annotation(annotation)
    category, sample_name = annotation_identity(annotation_path, annotation)
    obj_o_dir = output_obj_o_dir(output_root, sample_name, OUTPUT_LAYOUT_LEVEL, category)
    output_paths = export_obj_o_for_orientation(obj_p_path, annotation, Path(info["text_objs_dir"]), obj_o_dir, sample_name, settings)
    payload = current_state_payload()
    if isinstance(output_paths, dict):
        payload["obj_o_paths"] = {name: str(path) for name, path in output_paths.items()}
        payload["obj_o_path"] = str(output_paths.get("main") or next(iter(output_paths.values())))
    else:
        payload["obj_o_path"] = str(output_paths)
    payload["anchor_snap_report"] = snap_report
    return payload


def load_annotation(
    annotation_json: Path | str,
    obj_p_path: Path | str | None = None,
    dataset_root: Path | str | None = None,
    output_root: Path | str | None = None,
) -> dict:
    annotation_path = Path(annotation_json).expanduser().resolve()
    annotation = load_json(annotation_path)
    normalize_group_ids(annotation)
    resolved_dataset_root = Path(dataset_root).expanduser().resolve() if dataset_root else infer_dataset_root(annotation_path)
    resolved_output_root = Path(output_root).expanduser().resolve() if output_root else DEFAULT_OUTPUT_ROOT
    apply_internal_camera(annotation)
    annotation.pop("editor_name", None)
    annotation.pop("annotator_name", None)
    resolved_obj_p = Path(obj_p_path).expanduser().resolve() if obj_p_path else infer_obj_p_path(annotation_path, annotation)
    adjusted_json_path = output_json_path(resolved_output_root, annotation_path, annotation)
    model_cat, sample_name = annotation_identity(annotation_path, annotation)
    projection_images = resolve_projection_images(
        annotation,
        resolved_dataset_root,
        resolved_output_root,
        model_cat,
        sample_name,
        annotation_path,
    )
    part_overlay_images = {}
    with STATE_LOCK:
        STATE["annotation_path"] = annotation_path
        STATE["annotation"] = annotation
        STATE["obj_p_path"] = resolved_obj_p
        STATE["projection_images"] = projection_images
        STATE["part_overlay_images"] = part_overlay_images
        STATE["dataset_root"] = resolved_dataset_root
        STATE["output_root"] = resolved_output_root
        STATE["adjusted_json_path"] = adjusted_json_path
    return current_state_payload()


def load_sample(dataset_root: Path | str, category: str, sample_name: str, output_root: Path | str | None = None) -> dict:
    root = Path(dataset_root).expanduser().resolve()
    annotation_path = sample_json_path(root, category, sample_name)
    obj_p_path = sample_obj_p_path(root, category, sample_name)
    return load_annotation(annotation_path, obj_p_path, root, output_root)


def apply_update(payload: dict) -> dict:
    with STATE_LOCK:
        annotation = STATE["annotation"]
        if annotation is None:
            raise ValueError("No annotation loaded.")
        normalize_group_ids(annotation)
        output = payload.get("output") or {}
        if output.get("output_root"):
            STATE["output_root"] = Path(output["output_root"]).expanduser().resolve()
            STATE["adjusted_json_path"] = output_json_path(STATE["output_root"], STATE["annotation_path"], annotation)
        if "editor_name" in payload:
            set_editor_name(annotation, payload.get("editor_name", ""))
        for item in payload.get("groups", []):
            index = int(item["index"])
            group = annotation["groups"][index]
            if "label_camera_center" in item or "camera_center" in item:
                camera_xyz = np.asarray(item.get("label_camera_center", item.get("camera_center")), dtype=float)
                group["label"]["center"] = to_list(camera_to_world(camera_xyz, annotation["camera"]))
                sync_group_line(group)
            elif "label_world_center" in item or "world_center" in item:
                group["label"]["center"] = to_list(np.asarray(item.get("label_world_center", item.get("world_center")), dtype=float))
                sync_group_line(group)
            if "anchor_camera_center" in item:
                camera_xyz = np.asarray(item["anchor_camera_center"], dtype=float)
                anchor_world = to_list(camera_to_world(camera_xyz, annotation["camera"]))
                group.setdefault("anchor", {})["point"] = anchor_world
                sync_group_anchor(group)
            elif "anchor_world" in item:
                group.setdefault("anchor", {})["point"] = to_list(np.asarray(item["anchor_world"], dtype=float))
                sync_group_anchor(group)
            sync_group_line(group)
        if "camera" in payload:
            replace_settings(annotation, payload["camera"])
    return current_state_payload()


def annotation_for_storage(annotation: dict, layout_level: str = OUTPUT_LAYOUT_LEVEL) -> dict:
    stored = deepcopy(annotation)
    editor_name = current_editor_name(stored)
    stored["version"] = "after_mannual_adjust"
    stored["layout_level"] = str(layout_level)
    stored["layout_type"] = "manual_adjusted" if str(layout_level) == OUTPUT_LAYOUT_LEVEL else stored.get("layout_type", "rule_generated")
    stored.pop("camera", None)
    stored.pop("settings", None)
    stored.pop("_projection", None)
    stored.pop("_label_orientation_view", None)
    stored.pop("projection_images", None)
    stored.pop("layout_goal", None)
    stored.pop("sample_root", None)
    stored.pop("bad_generation", None)
    stored.pop("model_cat", None)
    stored.pop("editor_name", None)
    stored.pop("annotator_name", None)
    stored.pop("name", None)
    for group in stored.get("groups", []):
        group.pop("layout", None)
        label = group.get("label")
        if isinstance(label, dict):
            label.pop("text_obj_path", None)
        leader_line = group.get("leader_line")
        if isinstance(leader_line, dict):
            leader_line.pop("mode", None)
    ordered = {"version": stored.pop("version"), "name": editor_name}
    ordered.update(stored)
    return ordered


def render_current(write_json: bool = False) -> dict:
    with STATE_LOCK:
        annotation = deepcopy(STATE["annotation"])
        annotation_path = STATE["annotation_path"]
        obj_p_path = STATE["obj_p_path"]
        dataset_root = STATE["dataset_root"]
        output_root = STATE["output_root"]
        adjusted_json_path = STATE["adjusted_json_path"]
    if annotation is None or annotation_path is None or obj_p_path is None:
        raise ValueError("No annotation loaded.")
    if write_json:
        require_editor_name(annotation)
    settings = settings_from_annotation(annotation)
    model_cat, sample_name = annotation_identity(annotation_path, annotation)
    info = text_objs_info(annotation_path, annotation, dataset_root, output_root, obj_p_path)
    if not info["available"] or not info["text_objs_dir"]:
        missing = ", ".join(info["missing"]) if info["missing"] else "Text_objs directory"
        raise FileNotFoundError(f"Cannot render OBJ-O projection, missing text OBJ resources: {missing}")
    temp_obj_o_dir = output_obj_o_dir(output_root, sample_name, OUTPUT_LAYOUT_LEVEL, model_cat) if write_json else DATA_TEMP_ROOT / "preview_obj_o" / sample_name
    obj_o_paths = export_obj_o_for_orientation(
        obj_p_path,
        annotation,
        Path(info["text_objs_dir"]),
        temp_obj_o_dir,
        sample_name,
        settings,
    )
    if write_json:
        (layout_dir(output_root, sample_name, OUTPUT_LAYOUT_LEVEL, model_cat) / "Rating").mkdir(parents=True, exist_ok=True)
        paths = render_all_obj_o_views(
            obj_o_paths,
            annotation=annotation,
            projection_root=output_mutiviews_dir(output_root, sample_name, OUTPUT_LAYOUT_LEVEL, model_cat),
            category="",
            sample_name=sample_name,
            settings=settings,
        )
    else:
        paths = render_all_obj_o_views(
            obj_o_paths,
            annotation=annotation,
            projection_root=DATA_TEMP_ROOT / "preview_projection",
            category=model_cat,
            sample_name=sample_name,
            settings=settings,
        )
        annotation["projection_images"] = paths
    part_overlay_paths = render_part_overlay_views(
        obj_p_path,
        annotation,
        DATA_TEMP_ROOT / "part_overlays",
        model_cat,
        sample_name,
        settings,
    )
    if write_json:
        save_json(adjusted_json_path, annotation_for_storage(annotation, layout_level=OUTPUT_LAYOUT_LEVEL))
    with STATE_LOCK:
        STATE["annotation"] = annotation
        STATE["projection_images"] = paths
        STATE["part_overlay_images"] = part_overlay_paths
    return current_state_payload()


def save_current() -> dict:
    snap_report = snap_all_anchors_in_state()
    payload = render_current(write_json=True)
    payload["anchor_snap_report"] = snap_report
    return payload


def json_response(handler: SimpleHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


class EditorHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.serve_static("index.html")
            return
        if parsed.path.startswith("/static/"):
            self.serve_static(parsed.path.removeprefix("/static/"))
            return
        if parsed.path == "/api/state":
            json_response(self, current_state_payload())
            return
        if parsed.path == "/api/defaults":
            json_response(self, {"dataset_root": str(DEFAULT_DATASET_ROOT), "output_root": str(DEFAULT_OUTPUT_ROOT), "temp_root": str(DATA_TEMP_ROOT)})
            return
        if parsed.path == "/api/samples":
            query = parse_qs(parsed.query)
            root_value = unquote(query.get("root", [str(DEFAULT_DATASET_ROOT)])[0]).strip()
            output_root_value = unquote(query.get("output_root", [str(DEFAULT_OUTPUT_ROOT)])[0]).strip()
            root = Path(root_value) if root_value else DEFAULT_DATASET_ROOT
            output_root = Path(output_root_value) if output_root_value else DEFAULT_OUTPUT_ROOT
            json_response(self, list_annotation_samples(root, output_root))
            return
        if parsed.path == "/api/file":
            query = parse_qs(parsed.query)
            path = Path(unquote(query.get("path", [""])[0]))
            self.serve_file(path)
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        try:
            payload = self.read_json()
            if parsed.path == "/api/load":
                if payload.get("sample_name") is not None:
                    json_response(
                        self,
                        load_sample(
                            payload["dataset_root"],
                            str(payload.get("category") or ""),
                            str(payload["sample_name"]),
                            payload.get("output_root") or None,
                        ),
                    )
                else:
                    json_response(
                        self,
                        load_annotation(
                            payload["annotation_json"],
                            payload.get("obj_p_path") or None,
                            payload.get("dataset_root") or None,
                            payload.get("output_root") or None,
                        ),
                    )
                return
            if parsed.path == "/api/update":
                json_response(self, apply_update(payload))
                return
            if parsed.path == "/api/snap_anchor":
                apply_update(payload)
                json_response(self, snap_anchor_in_state(int(payload.get("index", 0))))
                return
            if parsed.path == "/api/render":
                apply_update(payload)
                json_response(self, render_current(write_json=False))
                return
            if parsed.path == "/api/save":
                apply_update(payload)
                json_response(self, save_current())
                return
            if parsed.path == "/api/export_obj_o":
                apply_update(payload)
                json_response(self, export_current_obj_o())
                return
        except Exception as exc:
            json_response(self, {"error": str(exc)}, status=500)
            return
        self.send_error(404)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def serve_static(self, relative: str) -> None:
        path = (STATIC_ROOT / relative).resolve()
        if not str(path).startswith(str(STATIC_ROOT.resolve())) or not path.is_file():
            self.send_error(404)
            return
        self.serve_file(path)

    def serve_file(self, path: Path) -> None:
        path = path.expanduser().resolve()
        if not path.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    port = DEFAULT_PORT

    try:
        samples = list_annotation_samples(DEFAULT_DATASET_ROOT, DEFAULT_OUTPUT_ROOT).get("samples") or []
        if samples:
            first = next((sample for sample in samples if not sample.get("manual_output_complete")), samples[0])
            load_annotation(
                first["annotation_path"],
                first.get("obj_p_path") or None,
                DEFAULT_DATASET_ROOT,
                DEFAULT_OUTPUT_ROOT,
            )
        elif DEFAULT_ANNOTATION_JSON.is_file():
            load_annotation(
                DEFAULT_ANNOTATION_JSON,
                DEFAULT_OBJ_P_PATH if DEFAULT_OBJ_P_PATH.is_file() else None,
                DEFAULT_DATASET_ROOT,
                DEFAULT_OUTPUT_ROOT,
            )
    except Exception as exc:
        print(f"Initial annotation load failed: {exc}", flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", int(port)), EditorHandler)
    print(f"manual projection editor: http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
