"""Settings for the new multi-view layout builder."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class NewLayoutSettings:
    """User-adjustable parameters exposed in the web UI."""

    text_height_ratio: float = 0.08
    label_padding_x_ratio: float = 0.15
    label_padding_y_ratio: float = 0.15
    label_thickness_ratio: float = 0.01
    side_margin_ratio: float = 0.20
    vertical_gap_ratio: float = 0.05
    top_bottom_preference_ratio: float = 0.30
    perimeter_layout_min_labels: int = 5
    main_view_safe_margin_ratio: float = 0.06
    depth_gap_ratio: float = 0.08
    depth_jitter_ratio: float = 0.015
    anchor_side_target_quantile: float = 0.22
    camera_radius: float = 10.0
    camera_focal_length_mm: float = 50.0
    camera_sensor_width_mm: float = 36.0
    camera_sensor_height_mm: float = 24.0
    camera_near_clip: float = 1e-6
    camera_far_clip: float = 1e6
    perturb_degrees: float = 45.0
    projection_image_width: int = 750
    projection_image_height: int = 500
    projection_annotation_supersample: int = 3
    label_orientation_mode: str = "adaptive"
    evaluation_view_mode: str = "multiview"
    max_label_overlap_pairs: int = 0
    max_object_overlap_count: int = 0
    max_overflow_count: int = 0
    max_leader_crossings: int = 0
    max_covered_anchor_count: int = 0
    candidate_margin_scales: tuple[float, ...] = (0.75, 1.0, 1.25, 1.55)
    candidate_depth_scales: tuple[float, ...] = (0.7, 1.0, 1.35, 1.75)
    min_score_for_perfect: float = 4.5

    def to_dict(self) -> dict:
        return asdict(self)


DEFAULT_SETTINGS = NewLayoutSettings()
