from __future__ import annotations

from dataclasses import dataclass

from .enums import Category, ConflictDirection


POLICY_VERSION = "2026-08-12.1"


@dataclass(frozen=True)
class CategoryPolicy:
    category: Category
    protocol_rule: str
    relation_rule: str
    output_rule: str


POLICIES = {
    Category.A_VA: CategoryPolicy(
        category=Category.A_VA,
        protocol_rule="The visible behavior and the Mandarin speech, including vocal delivery, convey the same underlying state.",
        relation_rule="Keep visual and audio evidence aligned without naming an emotion label in the video description.",
        output_rule="Return Mandarin dialogue and no VT text.",
    ),
    Category.A_VT: CategoryPolicy(
        category=Category.A_VT,
        protocol_rule="The visible behavior and the separate Mandarin text convey the same underlying state.",
        relation_rule="The video must remain understandable without speech, subtitles or rendered text.",
        output_rule="Return separate Mandarin VT text and no dialogue.",
    ),
    Category.C_VA: CategoryPolicy(
        category=Category.C_VA,
        protocol_rule="The visible behavior and Mandarin speech intentionally disagree.",
        relation_rule="One modality carries the underlying state and the other carries the surface state.",
        output_rule="Return Mandarin dialogue and no VT text.",
    ),
    Category.C_VT: CategoryPolicy(
        category=Category.C_VT,
        protocol_rule="The visible behavior and the separate Mandarin text intentionally disagree.",
        relation_rule="One modality carries the underlying state and the other carries the surface state. Do not render the text in the video.",
        output_rule="Return separate Mandarin VT text and no dialogue.",
    ),
}


def direction_rule(category: Category, direction: ConflictDirection | None) -> str:
    if category in {Category.A_VA, Category.A_VT}:
        return "There is no conflict direction because both modalities are aligned."
    labels = {
        ConflictDirection.VISION: "Visible behavior carries the underlying state; the other modality carries the surface state.",
        ConflictDirection.AUDIO: "Vocal delivery and speech carry the underlying state; visible behavior carries the surface state.",
        ConflictDirection.TEXT: "The separate text carries the underlying state; visible behavior carries the surface state.",
    }
    if direction is None:
        raise ValueError("Conflict content requires a direction")
    return labels[direction]

