from __future__ import annotations

import asyncio
import json

import pytest
from pydantic import ValidationError

from backend.adapters.llm import PromptModelResponse, PromptResponseMetadata
from backend.domain.enums import (
    Category,
    ConflictDirection,
    ContentMode,
    ContentStatus,
    Ethnicity,
    Gender,
    ModelName,
    ResourceStatus,
)
from backend.domain.models import ContentScript, PromptTemplateVersion, Scene
from backend.domain.prompt_policy import (
    ASSEMBLY_ENGLISH_WORD_OVERHEAD_MAX,
    COMPONENT_WORD_LIMITS,
    FINAL_POSITIVE_PROMPT_MAX_WORDS,
    PromptPolicyViolation,
    count_english_words,
    direction_rule,
    validate_scene_policy_text,
    validate_generated_component,
    validate_final_positive_prompt,
)
from backend.services.errors import ServiceError
from backend.services.prompts import GeneratedPrompt, PromptContext, PromptService


VA_DIALOGUE = "我没事，只是需要一点时间。"
VT_TEXT = "我需要再想一想。"

FIXED_PROMPT = (
    "One person only in the frame. {demographic} alone in a small rented room, lips moving as they speak. "
    "The main character says aloud with visible lip movement: 'Everything is going well.' The delivery is bright "
    "and clear. Photorealistic live action footage with a natural human face. Subject facing directly forward, "
    "close-up head-and-shoulders framing, bright soft lighting, quiet room tone, and a locked-off static shot."
)


class StaticPromptModel:
    configured = True

    def __init__(self, raw: str) -> None:
        self.raw = raw
        self.calls = 0

    async def generate(
        self, system_input: str, user_input: str
    ) -> PromptModelResponse:
        self.calls += 1
        return PromptModelResponse(
            content=self.raw,
            metadata=PromptResponseMetadata(
                http_status=200, finish_reason="stop", request_id="strict-test"
            ),
        )

    async def close(self) -> None:
        return None


def component_values(
    *,
    spoken_text: str = VA_DIALOGUE,
    pronoun: str = "She",
    body_action: str | None = None,
    vocal_delivery: str | None = None,
    true_emotion_description: str = "说话内容、声音和可见动作共同呈现人物当前的真实感受。",
) -> dict[str, object]:
    possessive = "her" if pronoun == "She" else "his"
    return {
        "spokenText": spoken_text,
        "appearance": (
            f"{pronoun} wears a charcoal jacket, and {possessive} dark hair remains neatly tucked away from the face."
        ),
        "bodyAction": body_action
        or (
            f"{pronoun} sits upright, folds both hands on the lap, presses the lips together, raises the chin, "
            "and keeps the gaze level through the final word."
        ),
        "vocalDelivery": vocal_delivery
        or f"{pronoun} keeps the voice low and steady, with measured pacing and firm articulation.",
        "environmentalSound": (
            "A soft ventilation hum and the even ticking of a wall clock remain audible throughout the clip."
        ),
        "setting": (
            "The private office contains pale walls, a bare wooden table, and one closed window behind the seat."
        ),
        "camera": (
            "The camera holds a static front-facing close-up head-and-shoulders view with the face fully readable."
        ),
        "lighting": (
            "Soft daylight keeps the face bright and evenly lit with gentle highlights across the plain fabric."
        ),
        "trueEmotionDescription": true_emotion_description,
    }


def component_json(**overrides: object) -> str:
    values = component_values()
    values.update(overrides)
    return json.dumps(values, ensure_ascii=False)


def component_boundary_sentence(field_name: str, word_count: int) -> str:
    opening = {
        "appearance": "Fabric",
        "body_action": "Posture",
        "vocal_delivery": "Voice",
        "environmental_sound": "Ventilation",
        "setting": "Office",
        "camera": "Lens",
        "lighting": "Daylight",
    }[field_name]
    return f"{opening} {'detail ' * (word_count - 1)}".strip() + "."


def prompt_context(
    *,
    mode: ContentMode,
    category: Category = Category.A_VA,
    conflict_direction: ConflictDirection | None = None,
    content_id: int | None = None,
    base_video_prompt: str = "",
    true_emotion_description: str = "人物的言语和表现共同呈现当前的真实感受。",
    gender: Gender = Gender.FEMALE,
    ethnicity: Ethnicity = Ethnicity.EAST_ASIAN,
) -> PromptContext:
    is_va = category in {Category.A_VA, Category.C_VA}
    content = ContentScript(
        id=content_id,
        name_zh="严格提示词",
        name_zh_key="严格提示词",
        name_en="Strict prompt",
        name_en_key="strict prompt",
        category=category,
        conflict_direction=conflict_direction,
        mode=mode,
        status=ContentStatus.ACTIVE,
        true_emotion="contained",
        apparent_emotion="guarded",
        scene_zh="一间私人办公室。",
        scene_en="A private office.",
        trigger_event_zh="人物准备作出简短回应。",
        trigger_event_en="The subject prepares a short response.",
        psychological_background_zh="人物选择克制地作答。",
        psychological_background_en="The subject chooses a measured response.",
        dialogue=VA_DIALOGUE if is_va else None,
        display_text=None if is_va else VT_TEXT,
        true_emotion_description=true_emotion_description,
        base_video_prompt=base_video_prompt,
        content_requirements_zh="生成可观察场景。"
        if mode is ContentMode.GENERATIVE
        else "",
        content_requirements_en="Create the requested observable scene."
        if mode is ContentMode.GENERATIVE
        else "",
        scene_supplement_zh="",
        scene_supplement_en="",
    )
    preset = PromptTemplateVersion(
        template_id=1,
        version=1,
        organization_instruction="Keep the selected records in component order.",
        style_instruction="Use restrained natural performance and a static close-up.",
        ltx_negative_prompt="subtitles, captions, distorted face",
        h3_negative_prompt="subtitles, captions, distorted face",
    )
    background = Scene(
        name_zh="私人办公室",
        name_zh_key="私人办公室",
        name_en="Private office",
        name_en_key="private office",
        scene_zh="办公室内只有人物一人。",
        scene_en="The private office has pale walls and one closed window.",
        ambient_sound_zh="",
        ambient_sound_en="A low room tone carries a steady ventilation hum.",
        participant_relationship_zh="人物独自一人。",
        participant_relationship_en="The subject remains alone.",
        lighting_zh="",
        lighting_en="Soft daylight keeps the face evenly lit.",
        framing_zh="",
        framing_en="Use a static front-facing close-up.",
        status=ResourceStatus.ACTIVE,
    )
    return PromptContext(
        content=content,
        template_version=preset,
        positive_examples=[],
        negative_examples=[],
        scene=background,
        age=25,
        gender=gender,
        ethnicity=ethnicity,
        model=ModelName.LTX,
    )


def complete_generated(
    values: dict[str, object],
    *,
    category: Category = Category.A_VA,
    direction: ConflictDirection | None = None,
    gender: Gender = Gender.FEMALE,
    ethnicity: Ethnicity = Ethnicity.EAST_ASIAN,
):
    service = PromptService(StaticPromptModel(json.dumps(values, ensure_ascii=False)))
    prepared = service.prepare(
        prompt_context(
            mode=ContentMode.GENERATIVE,
            category=category,
            conflict_direction=direction,
            gender=gender,
            ethnicity=ethnicity,
        )
    )
    return asyncio.run(service.complete(prepared, category)), prepared


@pytest.mark.parametrize(
    "category,direction,required_text",
    [
        (
            Category.C_VA,
            ConflictDirection.VISION,
            "words and vocal delivery carry the apparent state",
        ),
        (
            Category.C_VA,
            ConflictDirection.AUDIO,
            "words and vocal delivery carry the true state",
        ),
        (
            Category.C_VT,
            ConflictDirection.VISION,
            "stored Mandarin text carries the apparent state",
        ),
        (
            Category.C_VT,
            ConflictDirection.TEXT,
            "stored Mandarin text carries the true state",
        ),
    ],
)
def test_conflict_direction_assigns_the_true_state(
    category: Category,
    direction: ConflictDirection,
    required_text: str,
) -> None:
    assert required_text in direction_rule(category, direction)


def test_strict_components_are_assembled_in_verified_order() -> None:
    values = component_values()
    result, prepared = complete_generated(values)

    ordered = [
        values["appearance"],
        values["bodyAction"],
        f"She says '{VA_DIALOGUE}' once.",
        values["vocalDelivery"],
        values["environmentalSound"],
        values["setting"],
        values["camera"],
        values["lighting"],
    ]
    positions = [result.final_positive_prompt.index(str(value)) for value in ordered]
    assert positions == sorted(positions)
    assert result.final_positive_prompt.startswith(
        "A 25-year-old East Asian woman appears alone and faces the camera."
    )
    assert result.final_positive_prompt.count(VA_DIALOGUE) == 1
    assert f"'{VA_DIALOGUE}'" in result.final_positive_prompt
    assert json.loads(result.raw_structured_response) == values
    for field_name in COMPONENT_WORD_LIMITS:
        assert result.final_positive_prompt.count(
            str(values[_component_alias(field_name)])
        ) == 1
    assert result.negative_prompt == "subtitles, captions, distorted face"
    assert "Do not return positivePrompt" in prepared.user_input


def _component_alias(field_name: str) -> str:
    return {
        "body_action": "bodyAction",
        "vocal_delivery": "vocalDelivery",
        "environmental_sound": "environmentalSound",
    }.get(field_name, field_name)


@pytest.mark.parametrize("field_name,max_words", COMPONENT_WORD_LIMITS.items())
def test_pydantic_enforces_each_component_word_boundary(
    field_name: str, max_words: int
) -> None:
    alias = _component_alias(field_name)
    values = component_values()
    boundary = component_boundary_sentence(field_name, max_words)
    values[alias] = boundary

    output = GeneratedPrompt.model_validate(values)

    assert getattr(output, field_name) == boundary
    values[alias] = component_boundary_sentence(field_name, max_words + 1)
    with pytest.raises(ValidationError, match=f"no more than {max_words} English words"):
        GeneratedPrompt.model_validate(values)


@pytest.mark.parametrize("field_name,max_words", COMPONENT_WORD_LIMITS.items())
def test_domain_validation_enforces_each_component_word_boundary(
    field_name: str, max_words: int
) -> None:
    boundary = component_boundary_sentence(field_name, max_words)

    assert validate_generated_component(boundary, field_name) == boundary
    with pytest.raises(
        PromptPolicyViolation,
        match=f"no more than {max_words} English words",
    ):
        validate_generated_component(
            component_boundary_sentence(field_name, max_words + 1), field_name
        )


def test_setting_accepts_18_words_and_rejects_19_words() -> None:
    setting_at_limit = component_boundary_sentence("setting", 18)

    assert validate_generated_component(setting_at_limit, "setting") == setting_at_limit
    with pytest.raises(
        PromptPolicyViolation,
        match="setting must contain no more than 18 English words; found 19",
    ):
        validate_generated_component(
            component_boundary_sentence("setting", 19), "setting"
        )


def test_component_budgets_bound_theoretical_assembly_without_truncation() -> None:
    values = component_values()
    for field_name, max_words in COMPONENT_WORD_LIMITS.items():
        values[_component_alias(field_name)] = component_boundary_sentence(
            field_name, max_words
        )

    result, _ = complete_generated(values)

    assert (
        sum(COMPONENT_WORD_LIMITS.values())
        + ASSEMBLY_ENGLISH_WORD_OVERHEAD_MAX
        <= FINAL_POSITIVE_PROMPT_MAX_WORDS
    )
    assert count_english_words(result.final_positive_prompt) == 150
    for field_name in COMPONENT_WORD_LIMITS:
        assert str(values[_component_alias(field_name)]) in result.final_positive_prompt


def test_system_prompt_states_budgets_target_and_complete_valid_json_example() -> None:
    prepared = PromptService(StaticPromptModel("unused")).prepare(
        prompt_context(mode=ContentMode.GENERATIVE)
    )

    assert "Target 100 to 135 English words" in prepared.system_input
    assert "hard final limit remains 80 to 150 English words" in prepared.system_input
    for field_name, max_words in COMPONENT_WORD_LIMITS.items():
        assert f"{_component_alias(field_name)} {max_words}" in prepared.system_input
    example = prepared.system_input.rsplit("\n", 1)[-1]
    output = GeneratedPrompt.model_validate_json(example)
    example_component_words = 0
    for field_name, max_words in COMPONENT_WORD_LIMITS.items():
        component_words = count_english_words(getattr(output, field_name))
        assert component_words <= max_words
        example_component_words += component_words
    assert 100 <= example_component_words + ASSEMBLY_ENGLISH_WORD_OVERHEAD_MAX <= 135


@pytest.mark.parametrize(
    "category,direction,values,gender,ethnicity",
    [
        (
            Category.A_VA,
            None,
            component_values(
                body_action="She keeps both shoulders level and rests both open hands on the table throughout the reply.",
                vocal_delivery="She uses even volume, smooth pacing, and stable breath through every word.",
            ),
            Gender.FEMALE,
            Ethnicity.EAST_ASIAN,
        ),
        (
            Category.A_VT,
            None,
            component_values(
                spoken_text=VT_TEXT,
                pronoun="He",
                body_action="He keeps his chin level and taps one finger at a regular pace while facing forward.",
                vocal_delivery="He uses an even tempo, steady volume, and clean articulation through the source recording.",
            ),
            Gender.MALE,
            Ethnicity.SOUTH_ASIAN,
        ),
        (
            Category.C_VA,
            ConflictDirection.AUDIO,
            component_values(
                body_action="She grips the chair edge, lifts both shoulders, narrows the mouth, and keeps her posture rigid.",
                vocal_delivery="She uses loose breath, light volume, and an easy flowing pace through the spoken line.",
                true_emotion_description="声音和话语承载人物真实感受，可见动作呈现另一种表面状态。",
            ),
            Gender.FEMALE,
            Ethnicity.EAST_ASIAN,
        ),
        (
            Category.C_VT,
            ConflictDirection.TEXT,
            component_values(
                spoken_text=VT_TEXT,
                pronoun="He",
                body_action="He holds both elbows close, lowers the chin, and pauses with one hand fixed above the table.",
                vocal_delivery="He uses broken pacing, tight breath, and reduced volume in the audio-bearing source recording.",
                true_emotion_description="独立文字承载人物真实感受，画面和源声音呈现另一种表面状态。",
            ),
            Gender.MALE,
            Ethnicity.SOUTH_ASIAN,
        ),
    ],
)
def test_four_categories_use_distinct_components_and_map_spoken_text(
    category: Category,
    direction: ConflictDirection | None,
    values: dict[str, object],
    gender: Gender,
    ethnicity: Ethnicity,
) -> None:
    result, prepared = complete_generated(
        values,
        category=category,
        direction=direction,
        gender=gender,
        ethnicity=ethnicity,
    )

    is_va = category in {Category.A_VA, Category.C_VA}
    assert result.dialogue == values["spokenText"] if is_va else result.dialogue is None
    assert result.vt_text is None if is_va else result.vt_text == values["spokenText"]
    assert str(values["bodyAction"]) in result.final_positive_prompt
    assert str(values["vocalDelivery"]) in result.final_positive_prompt
    assert 80 <= count_english_words(result.final_positive_prompt) <= 150
    for field_name in COMPONENT_WORD_LIMITS:
        assert str(values[_component_alias(field_name)]) in result.final_positive_prompt
    assert direction_rule(category, direction) in prepared.system_input


def test_json_key_order_is_irrelevant() -> None:
    values = component_values()
    reversed_values = dict(reversed(list(values.items())))
    result, _ = complete_generated(reversed_values)
    assert result.dialogue == VA_DIALOGUE


def test_invalid_json_has_distinct_error() -> None:
    service = PromptService(StaticPromptModel('{"spokenText":'))
    prepared = service.prepare(prompt_context(mode=ContentMode.GENERATIVE))
    with pytest.raises(ServiceError) as error:
        asyncio.run(service.complete(prepared, Category.A_VA))
    assert error.value.code == "invalid_prompt_json"
    assert error.value.details == {
        "httpStatus": 200,
        "finishReason": "stop",
        "requestId": "strict-test",
    }


def test_duplicate_json_key_has_distinct_error() -> None:
    raw = component_json().replace(
        '"spokenText":', '"spokenText": "重复", "spokenText":', 1
    )
    service = PromptService(StaticPromptModel(raw))
    prepared = service.prepare(prompt_context(mode=ContentMode.GENERATIVE))
    with pytest.raises(ServiceError) as error:
        asyncio.run(service.complete(prepared, Category.A_VA))
    assert error.value.code == "duplicate_prompt_key"
    assert error.value.details == {
        "httpStatus": 200,
        "finishReason": "stop",
        "requestId": "strict-test",
    }


@pytest.mark.parametrize(
    "raw",
    [
        component_json(extraField="model-output-secret"),
        component_json(camera=42),
        component_json().replace('"spokenText":', '"dialogue":', 1),
        "[]",
    ],
)
def test_schema_error_has_only_safe_field_diagnostics(raw: str) -> None:
    service = PromptService(StaticPromptModel(raw))
    prepared = service.prepare(prompt_context(mode=ContentMode.GENERATIVE))
    with pytest.raises(ServiceError) as error:
        asyncio.run(service.complete(prepared, Category.A_VA))

    assert error.value.code == "invalid_prompt_schema"
    assert set(error.value.details) == {
        "httpStatus",
        "finishReason",
        "requestId",
        "fields",
    }
    assert error.value.details["fields"]
    assert all(
        set(field) == {"path", "type", "reason"}
        for field in error.value.details["fields"]
    )
    assert "model-output-secret" not in json.dumps(error.value.details)


def test_generated_prompt_model_rejects_blank_and_wrong_types() -> None:
    values = component_values()
    values["appearance"] = "   "
    with pytest.raises(ValidationError):
        GeneratedPrompt.model_validate(values)
    values = component_values()
    values["lighting"] = ["Soft light."]
    with pytest.raises(ValidationError):
        GeneratedPrompt.model_validate(values)


@pytest.mark.parametrize(
    "field,value",
    [
        ("appearance", "她穿着一件深色夹克。"),
        ("bodyAction", "She obviously raises her chin and keeps both hands still."),
        ("vocalDelivery", "She sounds sad through the final word."),
    ],
)
def test_components_reject_chinese_certainty_and_emotion_labels(
    field: str, value: str
) -> None:
    values = component_values()
    values[field] = value
    with pytest.raises(ServiceError) as error:
        complete_generated(values)
    assert error.value.code == "invalid_prompt_response"


def test_camera_allows_clearly_for_direct_physical_framing() -> None:
    values = component_values()
    values["camera"] = (
        "The camera clearly frames the face in a static front-facing close-up head-and-shoulders view."
    )

    result, _ = complete_generated(values)

    assert str(values["camera"]) in result.final_positive_prompt


@pytest.mark.parametrize(
    "field,value,required_violation",
    [
        (
            "appearance",
            "Her plain charcoal jacket clearly shows sadness.",
            "emotion labels: sadness",
        ),
        (
            "vocalDelivery",
            "Her vocal delivery clearly reveals anxiety.",
            "certainty claims: clearly reveals",
        ),
        (
            "setting",
            "The sparse room clearly indicates an unspoken conflict.",
            "certainty claims: clearly indicates",
        ),
    ],
)
def test_components_reject_clearly_scoped_to_semantic_claims(
    field: str, value: str, required_violation: str
) -> None:
    values = component_values()
    values[field] = value

    with pytest.raises(ServiceError) as error:
        complete_generated(values)

    assert error.value.code == "invalid_prompt_response"
    assert required_violation in error.value.message


@pytest.mark.parametrize("spoken_text", ["Hello there", "你A", "含有'引号"])
def test_spoken_text_must_be_natural_unquoted_chinese(spoken_text: str) -> None:
    values = component_values(spoken_text=spoken_text)
    with pytest.raises(ServiceError) as error:
        complete_generated(values)
    assert error.value.code == "invalid_prompt_response"


def test_true_emotion_description_keeps_independent_chinese_validation() -> None:
    values = component_values(true_emotion_description="English reviewer text.")

    with pytest.raises(ServiceError) as error:
        complete_generated(values)

    assert error.value.code == "invalid_prompt_response"
    assert "natural Chinese" in error.value.message


def test_final_policy_rejects_repeated_or_unquoted_spoken_text() -> None:
    result, _ = complete_generated(component_values())
    with pytest.raises(PromptPolicyViolation, match="single quotes"):
        validate_final_positive_prompt(
            result.final_positive_prompt.replace(f"'{VA_DIALOGUE}'", VA_DIALOGUE),
            spoken_text=VA_DIALOGUE,
        )
    with pytest.raises(PromptPolicyViolation, match="single quotes"):
        validate_final_positive_prompt(
            result.final_positive_prompt + f" {VA_DIALOGUE}",
            spoken_text=VA_DIALOGUE,
        )


@pytest.mark.parametrize(
    "content_id,category,direction",
    [
        (22, Category.C_VA, ConflictDirection.VISION),
        (23, Category.C_VT, ConflictDirection.TEXT),
        (46, Category.A_VA, None),
    ],
)
def test_required_content_scripts_can_prepare(
    content_id: int,
    category: Category,
    direction: ConflictDirection | None,
) -> None:
    prepared = PromptService(StaticPromptModel("unused")).prepare(
        prompt_context(
            mode=ContentMode.GENERATIVE,
            category=category,
            conflict_direction=direction,
            content_id=content_id,
        )
    )
    assert prepared.category is category
    assert "spokenText" in prepared.system_input
    assert "bodyAction" in prepared.system_input
    assert "vocalDelivery" in prepared.system_input


def test_fixed_content_uses_the_same_strict_deepseek_path() -> None:
    model = StaticPromptModel(component_json())
    service = PromptService(model)
    prepared = service.prepare(
        prompt_context(mode=ContentMode.FIXED, base_video_prompt=FIXED_PROMPT)
    )
    result = asyncio.run(service.complete(prepared, Category.A_VA))

    assert model.calls == 1
    assert "spokenText" in prepared.system_input
    assert FIXED_PROMPT in prepared.user_input
    assert result.final_positive_prompt.startswith(
        "A 25-year-old East Asian woman"
    )


def test_old_complete_prompt_response_has_no_compatibility_entry() -> None:
    raw = json.dumps(
        {
            "positivePrompt": "A woman speaks aloud.",
            "dialogue": VA_DIALOGUE,
            "vtText": None,
            "trueEmotionDescription": "人物当前的真实感受较为平稳。",
        },
        ensure_ascii=False,
    )
    service = PromptService(StaticPromptModel(raw))
    prepared = service.prepare(prompt_context(mode=ContentMode.GENERATIVE))
    with pytest.raises(ServiceError) as error:
        asyncio.run(service.complete(prepared, Category.A_VA))
    assert error.value.code == "invalid_prompt_schema"


@pytest.mark.parametrize(
    "value",
    [
        "A friend waits beside the subject.",
        "One other person waits beside the subject.",
        "One other woman speaks from off frame.",
        "A voice answers from off-frame.",
        "Soft background music fills the room.",
        "The walls create a sad atmosphere.",
        "The A-VT protocol applies here.",
        "The words appear on screen.",
    ],
)
def test_background_policy_rejects_person_music_emotion_internal_and_protocol_conflicts(
    value: str,
) -> None:
    with pytest.raises(PromptPolicyViolation):
        validate_scene_policy_text(value, "scene")


def test_background_policy_keeps_valid_text_unchanged() -> None:
    value = "Low room tone and steady ventilation remain audible."
    assert validate_scene_policy_text(value, "ambientAudio") is value


@pytest.mark.parametrize(
    "value",
    [
        "The subject faces the camera.",
        "The subject directly addresses the camera.",
    ],
)
def test_background_policy_allows_direct_camera_address(value: str) -> None:
    assert validate_scene_policy_text(value, "framingEn") is value


@pytest.mark.parametrize("mode", [ContentMode.GENERATIVE, ContentMode.FIXED])
def test_prepare_revalidates_historical_background_text(mode: ContentMode) -> None:
    context = prompt_context(mode=mode, base_video_prompt=FIXED_PROMPT)
    context.scene.participant_relationship_en = (
        "One other person remains off frame."
    )

    with pytest.raises(ServiceError) as error:
        PromptService(StaticPromptModel("unused")).prepare(context)

    assert error.value.status_code == 422
    assert error.value.code == "validation_error"
    assert error.value.details["fields"][0]["path"] == "scene"
