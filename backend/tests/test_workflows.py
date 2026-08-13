from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.adapters.workflows import (
    H3_NEGATIVE_PROMPT_SENTENCE,
    MAX_JOB_ID,
    MAX_SEED,
    MAX_SEQUENCE,
    H3WorkflowBuilder,
    Ltx23WorkflowBuilder,
    Ltx25WorkflowBuilder,
    WorkflowTemplateError,
)
from backend.domain.enums import Precision


FIXTURES = Path(__file__).parent / "fixtures" / "workflows"
LTX25_RESOURCES = Path(__file__).parents[1] / "resources" / "workflows"


def ltx_builder() -> Ltx23WorkflowBuilder:
    return Ltx23WorkflowBuilder(FIXTURES / "ltx23_minimal.json")


def h3_builder() -> H3WorkflowBuilder:
    return H3WorkflowBuilder(FIXTURES / "h3_minimal.json")


def ltx25_builder() -> Ltx25WorkflowBuilder:
    return Ltx25WorkflowBuilder(
        LTX25_RESOURCES / "ltx25_bf16.json",
        LTX25_RESOURCES / "ltx25_int8.json",
    )


def test_ltx25_builder_accepts_profiles_that_only_change_allowed_loader_files() -> None:
    builder = ltx25_builder()
    bf16 = json.loads((LTX25_RESOURCES / "ltx25_bf16.json").read_text(encoding="utf-8"))

    assert builder.required_class_types == {
        node["class_type"] for node in bf16.values()
    }


@pytest.mark.parametrize(
    ("precision", "transformer", "encoder"),
    [
        (Precision.BF16, "ltx-2.5-22b-distilled-transformer-bf16.safetensors", "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"),
        (Precision.INT8, "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors", "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"),
    ],
)
def test_ltx25_builder_selects_validated_profile_and_maps_runtime_inputs(
    precision: Precision,
    transformer: str,
    encoder: str,
) -> None:
    workflow = ltx25_builder().build(
        precision=precision,
        final_positive_prompt="A static portrait with audible room tone.",
        final_negative_prompt="subtitles, distortion",
        seed=MAX_SEED,
        job_id=15,
        sequence=4,
    )

    assert workflow["5508"]["inputs"]["value"] == "A static portrait with audible room tone."
    assert workflow["5509"]["inputs"]["value"] == "subtitles, distortion"
    assert workflow["5516:4832"]["inputs"]["noise_seed"] == MAX_SEED
    assert workflow["5014:4988"]["inputs"]["value"] == 121
    assert workflow["5511"]["inputs"]["value"] == 24
    assert workflow["5514:3059"]["inputs"] == {"batch_size": 1, "height": 768, "length": ["5014:4988", 0], "width": 1344}
    assert workflow["5516:4828"]["inputs"]["cfg"] == 1
    assert workflow["5516:4831"]["inputs"]["sampler_name"] == "euler_ancestral"
    assert workflow["5516:4984"]["inputs"]["sigmas"] == "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
    assert workflow["5004:5569"]["inputs"]["unet_name"] == transformer
    assert workflow["5004:5572"]["inputs"]["clip_name"] == encoder
    assert workflow["5004:5571"]["inputs"]["vae_name"] == "ltx-2.5-video-vae-bf16.safetensors"
    assert workflow["5518:4849"]["inputs"]["audio"] == ["5518:4848", 0]
    assert workflow["4852"]["inputs"]["filename_prefix"] == "15/4"
    assert "gemma4_e2b" not in str(workflow)


def test_ltx25_builder_rejects_changed_fixed_profile(tmp_path: Path) -> None:
    bf16 = (LTX25_RESOURCES / "ltx25_bf16.json").read_text(encoding="utf-8")
    changed_path = tmp_path / "changed.json"
    changed_path.write_text(bf16.replace('"cfg": 1', '"cfg": 2'), encoding="utf-8")

    with pytest.raises(WorkflowTemplateError) as error:
        Ltx25WorkflowBuilder(changed_path, LTX25_RESOURCES / "ltx25_int8.json")
    assert error.value.code == "workflow_template_invalid"


@pytest.mark.parametrize(
    ("node_id", "input_name", "changed_value"),
    [
        ("5014:1241", "positive", ["5014:2483", 1]),
        ("5518:4849", "bit_depth", 16),
    ],
    ids=["edge", "static-input"],
)
def test_ltx25_builder_rejects_cross_profile_graph_changes(
    tmp_path: Path,
    node_id: str,
    input_name: str,
    changed_value: object,
) -> None:
    int8 = json.loads((LTX25_RESOURCES / "ltx25_int8.json").read_text(encoding="utf-8"))
    int8[node_id]["inputs"][input_name] = changed_value
    changed_path = tmp_path / "changed-int8.json"
    changed_path.write_text(json.dumps(int8), encoding="utf-8")

    with pytest.raises(WorkflowTemplateError) as error:
        Ltx25WorkflowBuilder(LTX25_RESOURCES / "ltx25_bf16.json", changed_path)

    assert error.value.code == "workflow_template_invalid"
    assert "not equivalent" in error.value.message


def test_ltx23_builder_maps_every_static_input_and_returns_only_nodes() -> None:
    builder = ltx_builder()
    workflow = builder.build(
        final_positive_prompt="final positive",
        final_negative_prompt="final negative",
        seed=MAX_SEED,
        job_id=42,
        sequence=7,
    )

    assert "_comment" not in workflow
    assert workflow["enc_pos"]["inputs"]["text"] == "final positive"
    assert workflow["enc_neg"]["inputs"]["text"] == "final negative"
    assert workflow["noise"]["inputs"]["noise_seed"] == MAX_SEED
    assert workflow["empty_video"]["inputs"] == {
        "batch_size": 1,
        "height": 768,
        "length": 121,
        "width": 1344,
    }
    assert workflow["empty_audio"]["inputs"] == {
        "audio_vae": ["loader_audio_vae", 0],
        "batch_size": 1,
        "frame_rate": 24,
        "frames_number": 121,
    }
    assert workflow["conditioning"]["inputs"]["frame_rate"] == 24.0
    assert workflow["create_video"]["inputs"]["fps"] == 24.0
    assert workflow["create_video"]["inputs"]["audio"] == ["vae_audio", 0]
    assert workflow["vae_audio"]["class_type"] == "LTXVAudioVAEDecode"
    assert workflow["save_video"]["inputs"]["filename_prefix"] == "42/7"
    assert workflow["loader_model"]["class_type"] == "CheckpointLoaderSimple"
    assert builder.required_class_types == {
        node["class_type"] for node in workflow.values()
    }

    second = builder.build(
        final_positive_prompt="second",
        final_negative_prompt="",
        seed=0,
        job_id=1,
        sequence=1,
    )
    assert second["enc_pos"]["inputs"]["text"] == "second"
    assert workflow["enc_pos"]["inputs"]["text"] == "final positive"


def test_h3_builder_maps_static_inputs_and_merges_one_negative_sentence() -> None:
    builder = h3_builder()
    workflow = builder.build(
        final_positive_prompt="A locked-off portrait.",
        final_negative_prompt="subtitles, camera shake",
        seed=91,
        job_id=8,
        sequence=3,
    )

    assert "enc_neg" not in workflow
    assert workflow["5"]["inputs"]["prompt"] == (
        "A locked-off portrait.\n\n"
        + H3_NEGATIVE_PROMPT_SENTENCE.format(
            negative_prompt="subtitles, camera shake"
        )
    )
    assert workflow["5"]["inputs"]["width"] == 1344
    assert workflow["5"]["inputs"]["height"] == 768
    assert workflow["5"]["inputs"]["length"] == 124
    assert workflow["6"]["inputs"]["noise_seed"] == 91
    assert workflow["13"]["inputs"]["fps"] == 24.0
    assert workflow["14"]["inputs"]["filename_prefix"] == "8/3"
    assert workflow["12"]["class_type"] == "VAEDecodeAudio"
    assert workflow["13"]["inputs"]["audio"] == ["12", 0]
    assert builder.required_class_types == {
        node["class_type"] for node in workflow.values()
    }


def test_h3_builder_leaves_positive_prompt_alone_when_negative_is_empty() -> None:
    workflow = h3_builder().build(
        final_positive_prompt="One subject.",
        final_negative_prompt="",
        seed=0,
        job_id=1,
        sequence=1,
    )
    assert workflow["5"]["inputs"]["prompt"] == "One subject."


@pytest.mark.parametrize("invalid_seed", [True, "1", -1, MAX_SEED + 1])
def test_builders_reject_invalid_31_bit_seeds(invalid_seed: object) -> None:
    with pytest.raises((TypeError, ValueError)):
        ltx_builder().build(
            final_positive_prompt="positive",
            final_negative_prompt="negative",
            seed=invalid_seed,  # type: ignore[arg-type]
            job_id=1,
            sequence=1,
        )


@pytest.mark.parametrize(
    ("field", "invalid"),
    [
        ("job_id", True),
        ("job_id", "1"),
        ("job_id", -1),
        ("job_id", 0),
        ("job_id", MAX_JOB_ID + 1),
        ("job_id", "1/2"),
        ("job_id", "."),
        ("job_id", "/absolute"),
        ("job_id", "caller/path"),
        ("sequence", True),
        ("sequence", "1"),
        ("sequence", -1),
        ("sequence", 0),
        ("sequence", MAX_SEQUENCE + 1),
        ("sequence", "1\\2"),
        ("sequence", ".."),
        ("sequence", "C:\\absolute"),
    ],
)
def test_output_prefix_accepts_only_bounded_integer_job_and_sequence(
    field: str,
    invalid: object,
) -> None:
    values: dict[str, object] = {"job_id": 1, "sequence": 1}
    values[field] = invalid
    with pytest.raises((TypeError, ValueError)):
        h3_builder().build(
            final_positive_prompt="positive",
            final_negative_prompt="negative",
            seed=1,
            job_id=values["job_id"],  # type: ignore[arg-type]
            sequence=values["sequence"],  # type: ignore[arg-type]
        )


def test_h3_builder_rejects_payload_without_required_audio_decoder(tmp_path: Path) -> None:
    payload = (FIXTURES / "h3_minimal.json").read_text(encoding="utf-8")
    (tmp_path / "payload.json").write_text(
        payload.replace('"VAEDecodeAudio"', '"WrongAudioDecoder"'),
        encoding="utf-8",
    )

    with pytest.raises(WorkflowTemplateError) as error:
        H3WorkflowBuilder(tmp_path / "payload.json")
    assert error.value.code == "workflow_template_invalid"


@pytest.mark.parametrize(
    ("fixture_name", "builder_type", "audio_fragment"),
    [
        ("ltx23_minimal.json", Ltx23WorkflowBuilder, '"audio": ["vae_audio", 0]'),
        ("h3_minimal.json", H3WorkflowBuilder, '"audio": ["12", 0]'),
    ],
)
def test_builders_reject_workflows_without_audio_output_connection(
    tmp_path: Path,
    fixture_name: str,
    builder_type: type[Ltx23WorkflowBuilder] | type[H3WorkflowBuilder],
    audio_fragment: str,
) -> None:
    payload = (FIXTURES / fixture_name).read_text(encoding="utf-8")
    (tmp_path / fixture_name).write_text(
        payload.replace(audio_fragment, '"audio_removed": null'),
        encoding="utf-8",
    )

    with pytest.raises(WorkflowTemplateError) as error:
        builder_type(tmp_path / fixture_name)
    assert error.value.code == "workflow_template_invalid"
