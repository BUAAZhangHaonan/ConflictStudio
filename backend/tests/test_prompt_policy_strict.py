from __future__ import annotations

import asyncio
import json

import pytest
from pydantic import ValidationError

from backend.domain.enums import (
    Category,
    ConflictDirection,
    ContentMode,
    ContentStatus,
    Ethnicity,
    Gender,
    ResourceStatus,
)
from backend.domain.models import ContentPlan, PromptPreset, VideoBackgroundPreset
from backend.domain.prompt_policy import (
    PromptPolicyViolation,
    direction_rule,
    validate_background_policy_text,
    validate_final_positive_prompt,
)
from backend.services.errors import ServiceError
from backend.services.prompts import GeneratedPromptComponents, PromptContext, PromptService


VA_DIALOGUE = "我没事，只是需要一点时间。"
VT_TEXT = "我需要再想一想。"

VALID_VA_PROMPT = (
    "An East Asian woman in a charcoal jacket keeps her dark hair neatly tucked behind one ear. "
    "She sits upright, folds both hands on her lap, presses her lips together, and raises her chin "
    "while her gaze stays level. She says \"我没事，只是需要一点时间。\" in a low steady voice as the "
    "ventilation hums softly and a wall clock ticks at an even pace. The private office has pale "
    "walls, a bare wooden table, and one closed window behind her stool. The camera holds a static "
    "eye-level medium shot with a slow, almost imperceptible push inward. Soft daylight falls from "
    "the left, leaving a narrow shadow along her jaw and gentle highlights across the jacket fabric."
)

VALID_VT_PROMPT = (
    "A South Asian man in a plain navy shirt wears his short black hair brushed away from his face. "
    "He stands upright, clasps both hands at his waist, presses his mouth into a narrow line, and "
    "keeps his gaze fixed ahead. He says \"我需要再想一想。\" in a quiet measured voice while the "
    "ventilation hums and a nearby clock ticks steadily. The small office has pale walls, a bare "
    "table, and one closed window behind his stool. The camera holds a static eye-level medium shot "
    "and makes a slow controlled push inward. Cool daylight enters from the right, drawing a soft "
    "shadow beneath his jaw and muted highlights across the shirt fabric."
)


class StaticPromptModel:
    configured = True

    def __init__(self, raw: str) -> None:
        self.raw = raw
        self.calls = 0

    async def generate(self, system_input: str, user_input: str) -> str:
        self.calls += 1
        return self.raw

    async def close(self) -> None:
        return None


def component_json(
    *,
    spoken_text: str = VA_DIALOGUE,
    visual_behavior: str = (
        "The subject sits upright, folds both hands on the lap, presses the lips together, raises the chin, "
        "and keeps a steady gaze through the end of the clip."
    ),
) -> str:
    return json.dumps(
        {
            "spokenText": spoken_text,
            "visualBehavior": visual_behavior,
            "vocalDelivery": "in a low, steady voice with a measured pace",
            "environmentalSound": "The ventilation hums softly while a wall clock ticks at an even pace.",
            "setting": "The private office has pale walls, a bare wooden table and one closed window.",
            "cameraSupplement": "",
            "lightingSupplement": "Soft daylight adds gentle highlights across the plain fabric.",
            "trueEmotionDescription": "说话内容和可见动作共同表达受控状态。",
        },
        ensure_ascii=False,
    )


def prompt_context(
    *,
    mode: ContentMode,
    category: Category = Category.A_VA,
    base_video_prompt: str = "",
    gender: Gender = Gender.FEMALE,
    ethnicity: Ethnicity = Ethnicity.EAST_ASIAN,
) -> PromptContext:
    is_va = category in {Category.A_VA, Category.C_VA}
    content = ContentPlan(
        name="Strict prompt",
        name_key="strict prompt",
        category=category,
        conflict_direction=None,
        mode=mode,
        status=ContentStatus.ACTIVE,
        true_emotion="contained",
        apparent_emotion="contained",
        scene="A private office.",
        trigger_event="The subject considers a short question.",
        psychological_background="The subject chooses a measured response.",
        dialogue=VA_DIALOGUE if is_va else None,
        display_text=None if is_va else VT_TEXT,
        true_emotion_description="说话内容和可见动作共同表达受控状态。",
        base_video_prompt=base_video_prompt,
        content_instruction="Create the requested observable scene." if mode is ContentMode.GENERATIVE else "",
    )
    preset = PromptPreset(
        name="Natural camera",
        name_key="natural camera",
        category=category,
        style_instruction=(
            "The camera holds a static eye-level medium shot and makes a slow controlled push inward."
        ),
        scene_supplement="",
        final_negative_prompt="subtitles, captions, distorted face",
        status=ResourceStatus.ACTIVE,
    )
    background = VideoBackgroundPreset(
        name="Private office",
        name_key="private office",
        scene="The private office has pale walls, a bare wooden table, and one closed window behind the stool.",
        ambient_audio=(
            "A low room tone carries a steady ventilation hum while a wall clock ticks at an even pace."
        ),
        relationship="The subject remains alone.",
        lighting=(
            "Soft daylight falls from the left, leaving a narrow shadow along the jaw and gentle highlights "
            "across the fabric."
        ),
        framing_supplement="",
        status=ResourceStatus.ACTIVE,
    )
    return PromptContext(
        content=content,
        preset=preset,
        positive_examples=[],
        negative_examples=[],
        background=background,
        age=25,
        gender=gender,
        ethnicity=ethnicity,
    )


def test_strict_policy_accepts_complete_va_prompt() -> None:
    validate_final_positive_prompt(
        VALID_VA_PROMPT,
        spoken_text=VA_DIALOGUE,
        true_emotion="contained",
        apparent_emotion="contained",
    )


@pytest.mark.parametrize(
    "category,direction,required_text",
    [
        (Category.C_VA, ConflictDirection.VISION, "words and vocal delivery carry the apparent state"),
        (Category.C_VA, ConflictDirection.AUDIO, "words and vocal delivery carry the true state"),
        (Category.C_VT, ConflictDirection.VISION, "stored Mandarin text carries the apparent state"),
        (Category.C_VT, ConflictDirection.TEXT, "stored Mandarin text carries the true state"),
    ],
)
def test_conflict_direction_rules_assign_every_retained_channel(
    category: Category,
    direction: ConflictDirection,
    required_text: str,
) -> None:
    assert required_text in direction_rule(category, direction)


def test_conflict_direction_rule_rejects_protocol_mismatch() -> None:
    with pytest.raises(ValueError, match="does not match"):
        direction_rule(Category.C_VA, ConflictDirection.TEXT)


@pytest.mark.parametrize(
    "invalid_prompt, expected",
    [
        (VALID_VA_PROMPT.replace("her gaze stays level", "her sad gaze stays level"), "emotion labels"),
        (VALID_VA_PROMPT.replace("ventilation hums softly", "soft music plays"), "music or score"),
        (VALID_VA_PROMPT.replace("An East Asian woman", "Two people"), "multiple on-screen"),
        (VALID_VA_PROMPT.replace("The camera holds", "A-VA rules apply and the camera holds"), "internal category"),
        (VALID_VA_PROMPT.replace("The private office", "The camera pans slowly. The private office"), "order"),
        (VALID_VA_PROMPT.replace(". She sits", ".\nShe sits"), "one plain-text paragraph"),
    ],
)
def test_strict_policy_rejects_semantically_invalid_prompt(invalid_prompt: str, expected: str) -> None:
    with pytest.raises(PromptPolicyViolation, match=expected):
        validate_final_positive_prompt(invalid_prompt, spoken_text=VA_DIALOGUE)


def test_generated_prompt_rejects_whitespace_only_fields() -> None:
    with pytest.raises(ValidationError):
        GeneratedPromptComponents.model_validate(
            {
                "spokenText": "   ",
                "visualBehavior": "The subject keeps a steady gaze.",
                "vocalDelivery": "in a steady voice",
                "environmentalSound": "The ventilation hums softly.",
                "setting": "The private office remains quiet.",
                "cameraSupplement": "",
                "lightingSupplement": "",
                "trueEmotionDescription": "有效说明",
            }
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("visualBehavior", "The subject turns into a side profile and keeps both hands still."),
        ("environmentalSound", "An off-screen voice answers while the ventilation hums."),
        ("setting", "The office contains a visible light fixture beside the desk."),
        ("cameraSupplement", "The camera pushes inward with a slow zoom."),
        ("lightingSupplement", "Dim lighting leaves a heavy shadow across the face."),
    ],
)
def test_generated_components_reject_prompt_make_rendering_failures(field: str, value: str) -> None:
    payload = json.loads(component_json())
    payload[field] = value
    with pytest.raises(ValidationError):
        GeneratedPromptComponents.model_validate(payload)


def test_fixed_and_generative_prompts_use_the_same_final_policy() -> None:
    invalid_action = (
        "She sits upright on a simple stool, folds both hands across her lap, and keeps a sad expression "
        "while she raises her chin and holds her shoulders still."
    )
    fixed_service = PromptService(StaticPromptModel("unused"))
    fixed = fixed_service.prepare(
        prompt_context(mode=ContentMode.FIXED, base_video_prompt=invalid_action)
    )
    with pytest.raises(ServiceError) as fixed_error:
        asyncio.run(fixed_service.complete(fixed, Category.A_VA))

    generated_service = PromptService(
        StaticPromptModel(
            component_json(
                visual_behavior=(
                    "The subject sits upright, folds both hands on the lap, and keeps a sad gaze level "
                    "through the end of the clip."
                )
            )
        )
    )
    generated = generated_service.prepare(prompt_context(mode=ContentMode.GENERATIVE))
    with pytest.raises(ServiceError) as generated_error:
        asyncio.run(generated_service.complete(generated, Category.A_VA))

    assert fixed_error.value.code == "invalid_prompt_response"
    assert generated_error.value.code == "invalid_prompt_response"


def test_valid_fixed_prompt_is_checked_after_ordered_composition() -> None:
    action = (
        "She sits upright on a simple stool, folds both hands across her lap, presses her lips together, "
        "and lifts her chin while her gaze remains level and her shoulders stay still."
    )
    service = PromptService(StaticPromptModel("unused"))
    prepared = service.prepare(prompt_context(mode=ContentMode.FIXED, base_video_prompt=action))
    result = asyncio.run(service.complete(prepared, Category.A_VA))

    assert f'"{VA_DIALOGUE}"' in result.final_positive_prompt
    assert result.final_positive_prompt == prepared.fixed_output.positive_prompt


def test_generative_components_are_assembled_in_fixed_render_order_without_repair() -> None:
    visual = (
        "The subject sits upright, folds  both hands on the lap, presses the lips together, raises the chin, "
        "and keeps a steady gaze through the end of the clip."
    )
    service = PromptService(StaticPromptModel(component_json(visual_behavior=visual)))
    prepared = service.prepare(prompt_context(mode=ContentMode.GENERATIVE))
    result = asyncio.run(service.complete(prepared, Category.A_VA))

    assert visual in result.final_positive_prompt
    assert result.final_positive_prompt.index(visual) < result.final_positive_prompt.index('The subject says "')
    assert "front-facing close-up head-and-shoulders" in result.final_positive_prompt
    assert "positivePrompt" not in result.raw_structured_response


def test_vt_source_prompt_contains_exact_independently_stored_spoken_text() -> None:
    model = StaticPromptModel(component_json(spoken_text=VT_TEXT))
    service = PromptService(model)
    prepared = service.prepare(
        prompt_context(
            mode=ContentMode.GENERATIVE,
            category=Category.A_VT,
            gender=Gender.MALE,
            ethnicity=Ethnicity.SOUTH_ASIAN,
        )
    )
    result = asyncio.run(service.complete(prepared, Category.A_VT))

    assert result.dialogue is None
    assert result.vt_text == VT_TEXT
    assert f'"{VT_TEXT}"' in result.final_positive_prompt
    assert "audio-bearing" in prepared.system_input
    assert "source vocal delivery follows the visible behavior" in prepared.system_input


def test_strict_json_rejects_code_fenced_response() -> None:
    raw = f"```json\n{component_json()}\n```"
    service = PromptService(StaticPromptModel(raw))
    prepared = service.prepare(prompt_context(mode=ContentMode.GENERATIVE))

    with pytest.raises(ServiceError) as error:
        asyncio.run(service.complete(prepared, Category.A_VA))
    assert error.value.code == "invalid_prompt_response"


@pytest.mark.parametrize(
    "raw",
    [
        component_json().replace('"spokenText":', '"spokenText": "duplicate", "spokenText":', 1),
        component_json().replace('"spokenText":', '"spoken_text":', 1),
        json.dumps(
            {
                "positivePrompt": VALID_VA_PROMPT,
                "dialogue": VA_DIALOGUE,
                "vtText": None,
                "trueEmotionDescription": "有效说明",
            },
            ensure_ascii=False,
        ),
    ],
)
def test_strict_json_rejects_duplicate_and_non_camel_keys(raw: str) -> None:
    service = PromptService(StaticPromptModel(raw))
    prepared = service.prepare(prompt_context(mode=ContentMode.GENERATIVE))
    with pytest.raises(ServiceError) as error:
        asyncio.run(service.complete(prepared, Category.A_VA))
    assert error.value.code == "invalid_prompt_response"


@pytest.mark.parametrize(
    "invalid_prompt",
    [
        VALID_VA_PROMPT.replace("An East Asian woman", "Three East Asian adults"),
        VALID_VA_PROMPT.replace("An East Asian woman", "An East Asian man and a white woman"),
        VALID_VA_PROMPT.replace("She sits upright", "A friend sits upright"),
        VALID_VA_PROMPT.replace("She sits upright", "A third adult sits upright"),
        VALID_VA_PROMPT.replace("gaze stays level", "melancholic gaze stays level"),
        VALID_VA_PROMPT.replace("ventilation hums softly", "an orchestra plays softly"),
        VALID_VA_PROMPT.replace("ventilation hums softly", "arranged music plays softly"),
        VALID_VA_PROMPT.replace("The private office", "Words appear on screen. The private office"),
    ],
)
def test_policy_rejects_additional_single_subject_and_rendering_violations(invalid_prompt: str) -> None:
    with pytest.raises(PromptPolicyViolation):
        validate_final_positive_prompt(invalid_prompt, spoken_text=VA_DIALOGUE)


def test_policy_accepts_matching_demographic_and_rejects_mismatch() -> None:
    validate_final_positive_prompt(
        VALID_VA_PROMPT,
        spoken_text=VA_DIALOGUE,
        expected_ethnicity="East Asian",
        expected_gender="Female",
    )
    with pytest.raises(PromptPolicyViolation, match="selected ethnicity"):
        validate_final_positive_prompt(
            VALID_VA_PROMPT,
            spoken_text=VA_DIALOGUE,
            expected_ethnicity="White",
            expected_gender="Female",
        )

    age_prompt = VALID_VA_PROMPT.replace("An East Asian woman", "A 25-year-old East Asian woman")
    validate_final_positive_prompt(age_prompt, spoken_text=VA_DIALOGUE, expected_age=25)
    with pytest.raises(PromptPolicyViolation, match="selected age"):
        validate_final_positive_prompt(age_prompt, spoken_text=VA_DIALOGUE, expected_age=35)


@pytest.mark.parametrize("spoken_text", ["Hello你there", "你A"])
def test_policy_rejects_spoken_text_without_a_chinese_majority(spoken_text: str) -> None:
    prompt = VALID_VA_PROMPT.replace(VA_DIALOGUE, spoken_text)
    with pytest.raises(PromptPolicyViolation, match="predominantly Chinese"):
        validate_final_positive_prompt(prompt, spoken_text=spoken_text)


@pytest.mark.parametrize(
    "value",
    [
        "A trusted colleague stands off camera.",
        "A friend waits beside the subject.",
        "A third adult stands nearby.",
        "Soft background music fills the room.",
        "An orchestra plays nearby.",
        "The walls create a sad atmosphere.",
        "The room feels melancholic.",
        "The A-VT protocol applies here.",
        "The scene is silent with no speech.",
        "The words appear on screen.",
    ],
)
def test_background_policy_rejects_person_music_emotion_internal_and_protocol_conflicts(value: str) -> None:
    with pytest.raises(PromptPolicyViolation):
        validate_background_policy_text(value, "scene")


def test_background_policy_returns_valid_text_unchanged() -> None:
    value = "Low room tone and steady ventilation remain audible."
    assert validate_background_policy_text(value, "ambientAudio") is value
