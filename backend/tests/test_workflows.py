from __future__ import annotations

from pathlib import Path

import pytest

from backend.adapters.workflows import (
    H3_NEGATIVE_PROMPT_SENTENCE,
    MAX_JOB_ID,
    MAX_SEED,
    MAX_SEQUENCE,
    H3WorkflowBuilder,
    Ltx23WorkflowBuilder,
    WorkflowTemplateError,
)


FIXTURES = Path(__file__).parent / "fixtures" / "workflows"


def ltx_builder() -> Ltx23WorkflowBuilder:
    return Ltx23WorkflowBuilder(FIXTURES / "ltx23_minimal.json")


def h3_builder() -> H3WorkflowBuilder:
    return H3WorkflowBuilder(FIXTURES / "h3_minimal.json")


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
