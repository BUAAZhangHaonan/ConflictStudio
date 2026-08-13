from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from backend.domain.enums import Precision


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
H3_REQUIRED_CLASS_TYPES = {
    "MiniMaxH3ImageToVideo",
    "VAEDecodeAudio",
    "CreateVideo",
    "SaveVideo",
}

LTX_AUDIO_DECODER = "LTXVAudioVAEDecode"
H3_AUDIO_DECODER = "VAEDecodeAudio"

LTX25_WIDTH = 1344
LTX25_HEIGHT = 768
LTX25_FRAME_COUNT = 121
LTX25_FPS = 24
LTX25_SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
LTX25_PROFILE_MODELS = {
    Precision.BF16: (
        "ltx-2.5-22b-distilled-transformer-bf16.safetensors",
        "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    ),
    Precision.INT8: (
        "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
        "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    ),
}
LTX25_NODE_TYPES = {
    "4852": "SaveVideo",
    "5004:5569": "UNETLoader",
    "5004:5570": "VAELoader",
    "5004:5571": "VAELoader",
    "5004:5572": "CLIPLoader",
    "5014:1241": "LTXVConditioning",
    "5014:2483": "CLIPTextEncode",
    "5014:2612": "CLIPTextEncode",
    "5014:4988": "PrimitiveInt",
    "5014:5017": "PrimitiveFloat",
    "5508": "PrimitiveStringMultiline",
    "5509": "PrimitiveStringMultiline",
    "5511": "PrimitiveFloat",
    "5514:3059": "EmptyLTXVLatentVideo",
    "5514:3980": "LTXVEmptyLatentAudio",
    "5514:4528": "LTXVConcatAVLatent",
    "5514:5000": "LTXFloatToInt",
    "5516:4828": "CFGGuider",
    "5516:4829": "SamplerCustomAdvanced",
    "5516:4831": "KSamplerSelect",
    "5516:4832": "RandomNoise",
    "5516:4845": "LTXVSeparateAVLatent",
    "5516:4984": "ManualSigmas",
    "5518:4848": "LTXVAudioVAEDecode",
    "5518:4849": "CreateVideo",
    "5518:5538": "VAEDecodeTiled",
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


class Ltx25WorkflowBuilder:
    def __init__(self, bf16_template_path: Path, int8_template_path: Path) -> None:
        self._templates = {
            Precision.BF16: _load_ltx25_template(bf16_template_path, Precision.BF16),
            Precision.INT8: _load_ltx25_template(int8_template_path, Precision.INT8),
        }
        normalized = {
            precision: _normalize_ltx25_profile(template, precision)
            for precision, template in self._templates.items()
        }
        if normalized[Precision.BF16] != normalized[Precision.INT8]:
            raise WorkflowTemplateError(
                "workflow_template_invalid",
                "The configured LTX-2.5 workflow templates are not equivalent",
            )
        self.required_class_types = _class_types(self._templates[Precision.BF16])

    def build(
        self,
        *,
        precision: Precision,
        final_positive_prompt: str,
        final_negative_prompt: str,
        seed: int,
        job_id: int,
        sequence: int,
    ) -> dict[str, dict[str, Any]]:
        if precision not in self._templates:
            raise ValueError("LTX-2.5 requires BF16 or INT8 precision")
        _require_prompt(final_positive_prompt, "final_positive_prompt")
        _require_prompt(final_negative_prompt, "final_negative_prompt")
        _require_integer(seed, "seed", minimum=0, maximum=MAX_SEED)

        workflow = copy.deepcopy(self._templates[precision])
        workflow["5508"]["inputs"]["value"] = final_positive_prompt
        workflow["5509"]["inputs"]["value"] = final_negative_prompt
        workflow["5516:4832"]["inputs"]["noise_seed"] = seed
        workflow["5014:4988"]["inputs"]["value"] = LTX25_FRAME_COUNT
        workflow["5511"]["inputs"]["value"] = LTX25_FPS
        workflow["5514:3059"]["inputs"].update(
            width=LTX25_WIDTH,
            height=LTX25_HEIGHT,
            length=["5014:4988", 0],
        )
        workflow["4852"]["inputs"]["filename_prefix"] = _output_prefix(job_id, sequence)
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
    _validate_workflow(workflow, "LTX")
    _validate_audio_output(
        workflow,
        create_video_node_id="create_video",
        decoder_class_type=LTX_AUDIO_DECODER,
        workflow_name="LTX",
    )
    return workflow


def _load_ltx25_template(path: Path, precision: Precision) -> dict[str, dict[str, Any]]:
    document = _read_json(path)
    if not isinstance(document, dict):
        raise _ltx25_template_error()
    workflow = {
        node_id: node
        for node_id, node in document.items()
        if isinstance(node, dict) and "class_type" in node
    }
    if set(workflow) != set(LTX25_NODE_TYPES):
        raise _ltx25_template_error()
    _validate_nodes(workflow, LTX25_NODE_TYPES, "LTX-2.5")
    _validate_workflow(workflow, "LTX-2.5")
    _validate_ltx25_contract(workflow, precision)
    return workflow


def _validate_ltx25_contract(workflow: dict[str, dict[str, Any]], precision: Precision) -> None:
    inputs = {node_id: node["inputs"] for node_id, node in workflow.items()}
    contract = (
        inputs["5004:5569"] == {"unet_name": LTX25_PROFILE_MODELS[precision][0], "weight_dtype": "default"}
        and inputs["5004:5570"] == {"vae_name": "ltx-2.5-audio-vae-bf16.safetensors"}
        and inputs["5004:5571"] == {"vae_name": "ltx-2.5-video-vae-bf16.safetensors"}
        and inputs["5004:5572"] == {"clip_name": LTX25_PROFILE_MODELS[precision][1], "device": "default", "type": "ltxv"}
        and inputs["5014:4988"] == {"value": LTX25_FRAME_COUNT}
        and inputs["5511"] == {"value": LTX25_FPS}
        and inputs["5514:3059"] == {"batch_size": 1, "height": LTX25_HEIGHT, "length": ["5014:4988", 0], "width": LTX25_WIDTH}
        and inputs["5516:4828"]["cfg"] == 1
        and inputs["5516:4831"] == {"sampler_name": "euler_ancestral"}
        and inputs["5516:4984"] == {"sigmas": LTX25_SIGMAS}
        and inputs["5518:4849"]["audio"] == ["5518:4848", 0]
    )
    if not contract:
        raise _ltx25_template_error()
    _validate_audio_output(
        workflow,
        create_video_node_id="5518:4849",
        decoder_class_type=LTX_AUDIO_DECODER,
        workflow_name="LTX-2.5",
    )


def _normalize_ltx25_profile(
    workflow: dict[str, dict[str, Any]],
    precision: Precision,
) -> dict[str, dict[str, Any]]:
    normalized = copy.deepcopy(workflow)
    transformer, encoder = LTX25_PROFILE_MODELS[precision]
    if (
        normalized["5004:5569"]["inputs"].get("unet_name") != transformer
        or normalized["5004:5572"]["inputs"].get("clip_name") != encoder
    ):
        raise _ltx25_template_error()
    normalized["5004:5569"]["inputs"]["unet_name"] = "<LTX25_TRANSFORMER>"
    normalized["5004:5572"]["inputs"]["clip_name"] = "<LTX25_TEXT_ENCODER>"
    return normalized


def _ltx25_template_error() -> WorkflowTemplateError:
    return WorkflowTemplateError(
        "workflow_template_invalid",
        "The configured LTX-2.5 workflow template is not valid",
    )


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
    if not H3_REQUIRED_CLASS_TYPES <= _class_types(workflow):
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            "The configured H3 workflow template is not valid",
        )
    _validate_audio_output(
        workflow,
        create_video_node_id="13",
        decoder_class_type=H3_AUDIO_DECODER,
        workflow_name="H3",
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


def _validate_audio_output(
    workflow: dict[str, dict[str, Any]],
    *,
    create_video_node_id: str,
    decoder_class_type: str,
    workflow_name: str,
) -> None:
    audio_input = workflow[create_video_node_id]["inputs"].get("audio")
    if (
        not isinstance(audio_input, list)
        or len(audio_input) != 2
        or type(audio_input[0]) is not str
        or type(audio_input[1]) is not int
    ):
        raise WorkflowTemplateError(
            "workflow_template_invalid",
            f"The configured {workflow_name} workflow template is not valid",
        )
    decoder = workflow.get(audio_input[0])
    if not isinstance(decoder, dict) or decoder.get("class_type") != decoder_class_type:
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
