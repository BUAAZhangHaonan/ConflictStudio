from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_SEED = (1 << 31) - 1
MAX_JOB_ID = (1 << 63) - 1
MAX_SEQUENCE = (1 << 31) - 1

H3_NEGATIVE_PROMPT_SENTENCE = (
    "Do not include any of the following unwanted content or defects: {negative_prompt}."
)

LTX23_NODE_TYPES = {
    "enc_pos": "CLIPTextEncode",
    "enc_neg": "CLIPTextEncode",
    "conditioning": "LTXVConditioning",
    "empty_video": "EmptyLTXVLatentVideo",
    "empty_audio": "LTXVEmptyLatentAudio",
    "noise": "RandomNoise",
    "create_video": "CreateVideo",
    "save_video": "SaveVideo",
}

H3_NODE_TYPES = {
    "5": "MiniMaxH3ImageToVideo",
    "6": "RandomNoise",
    "13": "CreateVideo",
    "14": "SaveVideo",
}


class WorkflowTemplateError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class WorkflowServiceConfig:
    allowed_root: Path
    ltx23_template: Path
    h3_template: Path

    def __post_init__(self) -> None:
        root = self.allowed_root.resolve()
        ltx23 = self._resolve_template(root, self.ltx23_template)
        h3 = self._resolve_template(root, self.h3_template)
        object.__setattr__(self, "allowed_root", root)
        object.__setattr__(self, "ltx23_template", ltx23)
        object.__setattr__(self, "h3_template", h3)

    @staticmethod
    def _resolve_template(root: Path, configured_path: Path) -> Path:
        candidate = configured_path if configured_path.is_absolute() else root / configured_path
        resolved = candidate.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("A workflow template must stay within the configured workflow root")
        return resolved


class Ltx23WorkflowBuilder:
    def __init__(self, config: WorkflowServiceConfig) -> None:
        self._template = _load_ltx23_template(config.ltx23_template)

    def build(
        self,
        *,
        final_positive_prompt: str,
        final_negative_prompt: str,
        seed: int,
        job_id: int,
        sequence: int,
    ) -> dict[str, dict[str, Any]]:
        _require_prompt(final_positive_prompt, "final_positive_prompt")
        _require_prompt(final_negative_prompt, "final_negative_prompt")
        _require_integer(seed, "seed", minimum=0, maximum=MAX_SEED)
        prefix = _output_prefix(job_id, sequence)

        workflow = copy.deepcopy(self._template)
        workflow["enc_pos"]["inputs"]["text"] = final_positive_prompt
        workflow["enc_neg"]["inputs"]["text"] = final_negative_prompt
        workflow["noise"]["inputs"]["noise_seed"] = seed
        workflow["empty_video"]["inputs"].update(width=1344, height=768, length=121)
        workflow["empty_audio"]["inputs"].update(frames_number=121, frame_rate=24)
        workflow["conditioning"]["inputs"]["frame_rate"] = 24.0
        workflow["create_video"]["inputs"]["fps"] = 24.0
        workflow["save_video"]["inputs"]["filename_prefix"] = prefix
        return workflow


class H3WorkflowBuilder:
    def __init__(self, config: WorkflowServiceConfig) -> None:
        self._template = _load_h3_template(config.h3_template)

    def build(
        self,
        *,
        final_positive_prompt: str,
        final_negative_prompt: str,
        seed: int,
        job_id: int,
        sequence: int,
    ) -> dict[str, dict[str, Any]]:
        _require_prompt(final_positive_prompt, "final_positive_prompt")
        _require_prompt(final_negative_prompt, "final_negative_prompt")
        _require_integer(seed, "seed", minimum=0, maximum=MAX_SEED)
        prefix = _output_prefix(job_id, sequence)

        prompt = final_positive_prompt
        if final_negative_prompt != "":
            prompt = (
                f"{prompt}\n\n"
                f"{H3_NEGATIVE_PROMPT_SENTENCE.format(negative_prompt=final_negative_prompt)}"
            )

        workflow = copy.deepcopy(self._template)
        workflow["5"]["inputs"].update(
            prompt=prompt,
            width=1344,
            height=768,
            length=124,
        )
        workflow["6"]["inputs"]["noise_seed"] = seed
        workflow["13"]["inputs"]["fps"] = 24.0
        workflow["14"]["inputs"]["filename_prefix"] = prefix
        return workflow


def _load_ltx23_template(path: Path) -> dict[str, dict[str, Any]]:
    document = _read_json(path)
    if not isinstance(document, dict):
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            "The configured LTX workflow template is not valid",
        )
    workflow = {
        node_id: node
        for node_id, node in document.items()
        if isinstance(node, dict) and "class_type" in node
    }
    _validate_nodes(workflow, LTX23_NODE_TYPES, "LTX")
    return workflow


def _load_h3_template(path: Path) -> dict[str, dict[str, Any]]:
    document = _read_json(path)
    if not isinstance(document, dict) or set(document) != {"prompt", "client_id"}:
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            "The configured H3 workflow template is not valid",
        )
    workflow = document.get("prompt")
    if not isinstance(workflow, dict):
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            "The configured H3 workflow template is not valid",
        )
    _validate_nodes(workflow, H3_NODE_TYPES, "H3")
    return {node_id: workflow[node_id] for node_id in H3_NODE_TYPES}


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise WorkflowTemplateError(
            "workflow_template_unavailable",
            "The configured workflow template could not be loaded",
        ) from error


def _validate_nodes(
    workflow: dict[str, Any],
    expected: dict[str, str],
    workflow_name: str,
) -> None:
    for node_id, class_type in expected.items():
        node = workflow.get(node_id)
        if (
            not isinstance(node, dict)
            or node.get("class_type") != class_type
            or not isinstance(node.get("inputs"), dict)
        ):
            raise WorkflowTemplateError(
                "workflow_template_invalid",
                f"The configured {workflow_name} workflow template is not valid",
            )


def _require_prompt(value: str, name: str) -> None:
    if type(value) is not str:
        raise TypeError(f"{name} must be a string")


def _require_integer(value: int, name: str, *, minimum: int, maximum: int) -> None:
    if type(value) is not int:
        raise TypeError(f"{name} must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} is outside the supported range")


def _output_prefix(job_id: int, sequence: int) -> str:
    _require_integer(job_id, "job_id", minimum=1, maximum=MAX_JOB_ID)
    _require_integer(sequence, "sequence", minimum=1, maximum=MAX_SEQUENCE)
    return f"{job_id}/{sequence}"
