from __future__ import annotations

import copy
import json
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
    "concat_av": "LTXVConcatAVLatent",
    "noise": "RandomNoise",
    "sampler": "SamplerCustomAdvanced",
    "separate_av": "LTXVSeparateAVLatent",
    "vae_video": "LTXVSpatioTemporalTiledVAEDecode",
    "vae_audio": "LTXVAudioVAEDecode",
    "create_video": "CreateVideo",
    "save_video": "SaveVideo",
}

H3_NODE_TYPES = {
    "5": "MiniMaxH3ImageToVideo",
    "6": "RandomNoise",
    "10": "SamplerCustomAdvanced",
    "11": "VAEDecode",
    "12": "VAEDecodeAudio",
    "13": "CreateVideo",
    "14": "SaveVideo",
}
H3_REQUIRED_CLASS_TYPES = {
    "MiniMaxH3ImageToVideo",
    "VAEDecodeAudio",
    "CreateVideo",
    "SaveVideo",
}


class WorkflowTemplateError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Ltx23WorkflowBuilder:
    def __init__(self, template_path: Path) -> None:
        self._template = _load_ltx23_template(template_path)
        self.required_class_types = _class_types(self._template)

    def build(
        self,
        *,
        final_positive_prompt: str,
        final_negative_prompt: str,
        expected_has_audio: bool,
        seed: int,
        job_id: int,
        sequence: int,
    ) -> dict[str, dict[str, Any]]:
        _require_prompt(final_positive_prompt, "final_positive_prompt")
        _require_prompt(final_negative_prompt, "final_negative_prompt")
        _require_boolean(expected_has_audio, "expected_has_audio")
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
        if not expected_has_audio:
            workflow.pop("vae_audio")
            workflow["create_video"]["inputs"].pop("audio")
        workflow["save_video"]["inputs"]["filename_prefix"] = prefix
        return workflow


class H3WorkflowBuilder:
    def __init__(self, template_path: Path) -> None:
        self._template = _load_h3_template(template_path)
        self.required_class_types = _class_types(self._template)

    def build(
        self,
        *,
        final_positive_prompt: str,
        final_negative_prompt: str,
        expected_has_audio: bool,
        seed: int,
        job_id: int,
        sequence: int,
    ) -> dict[str, dict[str, Any]]:
        _require_prompt(final_positive_prompt, "final_positive_prompt")
        _require_prompt(final_negative_prompt, "final_negative_prompt")
        _require_boolean(expected_has_audio, "expected_has_audio")
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
        if not expected_has_audio:
            workflow.pop("12")
            workflow["13"]["inputs"].pop("audio")
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
    _validate_workflow(workflow, "LTX")
    _validate_ltx_audio_graph(workflow)
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
    _validate_workflow(workflow, "H3")
    _validate_h3_audio_graph(workflow)
    if not H3_REQUIRED_CLASS_TYPES <= _class_types(workflow):
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            "The configured H3 workflow template is not valid",
        )
    return workflow


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


def _validate_workflow(workflow: dict[str, Any], workflow_name: str) -> None:
    if not workflow:
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            f"The configured {workflow_name} workflow template is not valid",
        )
    for node_id, node in workflow.items():
        if (
            type(node_id) is not str
            or not isinstance(node, dict)
            or type(node.get("class_type")) is not str
            or not node["class_type"]
            or not isinstance(node.get("inputs"), dict)
        ):
            raise WorkflowTemplateError(
                "workflow_template_invalid",
                f"The configured {workflow_name} workflow template is not valid",
            )


def _class_types(workflow: dict[str, dict[str, Any]]) -> frozenset[str]:
    return frozenset(node["class_type"] for node in workflow.values())


def _validate_ltx_audio_graph(workflow: dict[str, dict[str, Any]]) -> None:
    expected_references = {
        ("concat_av", "audio_latent"): ["empty_audio", 0],
        ("sampler", "latent_image"): ["concat_av", 0],
        ("separate_av", "av_latent"): ["sampler", 1],
        ("vae_video", "latents"): ["separate_av", 0],
        ("vae_audio", "samples"): ["separate_av", 1],
        ("create_video", "images"): ["vae_video", 0],
        ("create_video", "audio"): ["vae_audio", 0],
    }
    _validate_references(workflow, expected_references, "LTX")


def _validate_h3_audio_graph(workflow: dict[str, dict[str, Any]]) -> None:
    expected_references = {
        ("10", "latent_image"): ["5", 1],
        ("11", "samples"): ["10", 0],
        ("12", "samples"): ["10", 0],
        ("13", "images"): ["11", 0],
        ("13", "audio"): ["12", 0],
    }
    _validate_references(workflow, expected_references, "H3")


def _validate_references(
    workflow: dict[str, dict[str, Any]],
    expected: dict[tuple[str, str], list[str | int]],
    workflow_name: str,
) -> None:
    if any(workflow[node_id]["inputs"].get(name) != reference for (node_id, name), reference in expected.items()):
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            f"The configured {workflow_name} workflow template is not valid",
        )


def _require_prompt(value: str, name: str) -> None:
    if type(value) is not str:
        raise TypeError(f"{name} must be a string")


def _require_boolean(value: bool, name: str) -> None:
    if type(value) is not bool:
        raise TypeError(f"{name} must be a boolean")


def _require_integer(value: int, name: str, *, minimum: int, maximum: int) -> None:
    if type(value) is not int:
        raise TypeError(f"{name} must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} is outside the supported range")


def _output_prefix(job_id: int, sequence: int) -> str:
    _require_integer(job_id, "job_id", minimum=1, maximum=MAX_JOB_ID)
    _require_integer(sequence, "sequence", minimum=1, maximum=MAX_SEQUENCE)
    return f"{job_id}/{sequence}"
