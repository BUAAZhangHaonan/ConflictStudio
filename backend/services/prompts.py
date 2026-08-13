from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from backend.adapters.llm import PromptAdapterError, PromptModel
from backend.domain.enums import Category, ContentMode, Ethnicity, Gender
from backend.domain.models import ContentPlan, PromptPreset, VideoBackgroundPreset
from backend.domain.prompt_policy import (
    BANNED_CERTAINTY_MODIFIERS,
    POLICY_VERSION,
    POLICIES,
    PromptPolicyViolation,
    direction_rule,
    validate_final_positive_prompt,
)

from .errors import ServiceError


FORBIDDEN_COMPONENT_PERSON_PHRASES = (
    "another person",
    "second person",
    "off-camera person",
    "off camera person",
    "off-screen person",
    "offscreen person",
    "off-camera voice",
    "off camera voice",
    "off-screen voice",
    "offscreen voice",
)
FORBIDDEN_COMPONENT_CAMERA_PHRASES = (
    "camera movement",
    "camera moves",
    "camera pans",
    "camera tracks",
    "handheld camera",
    "push-in",
    "push in",
    "pushes inward",
    "zoom",
    "wide shot",
    "full-body shot",
    "full body shot",
)
FORBIDDEN_COMPONENT_PORTRAIT_PHRASES = (
    "side profile",
    "profile view",
    "back of the head",
    "back of head",
    "turned away from the camera",
)
FORBIDDEN_COMPONENT_LIGHTING_PHRASES = (
    "dim lighting",
    "dimly lit",
    "heavy shadow",
    "backlit silhouette",
    "visible lamp",
    "visible light fixture",
    "lighting equipment",
)
FORBIDDEN_TRUE_EMOTION_DESCRIPTION_TOKENS = (
    "a-va",
    "a-vt",
    "c-va",
    "c-vt",
    "positiveprompt",
    "dialogue",
    "vttext",
    "spokentext",
    "visualbehavior",
    "vocaldelivery",
    "environmentalsound",
    "setting",
    "camerasupplement",
    "lightingsupplement",
    "trueemotiondescription",
    "true_emotion_description",
    "spoken_text",
    "visual_behavior",
    "vocal_delivery",
    "environmental_sound",
    "camera_supplement",
    "lighting_supplement",
)
SILENT_ENVIRONMENT_SOUND = "No ambient sound is audible."


class GeneratedPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    positive_prompt: str = Field(alias="positivePrompt", min_length=1)
    dialogue: str | None
    vt_text: str | None = Field(alias="vtText")
    true_emotion_description: str = Field(alias="trueEmotionDescription", min_length=1)

    @field_validator("positive_prompt", "true_emotion_description")
    @classmethod
    def reject_blank_required_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("The field must not be blank")
        return value

    @field_validator("dialogue", "vt_text")
    @classmethod
    def reject_blank_optional_text(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("The field must not be blank")
        return value


class GeneratedPromptComponents(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    spoken_text: str = Field(alias="spokenText", min_length=1)
    visual_behavior: str = Field(alias="visualBehavior", min_length=1)
    vocal_delivery: str = Field(alias="vocalDelivery", min_length=1)
    environmental_sound: str | None = Field(alias="environmentalSound")
    setting: str = Field(min_length=1)
    camera_supplement: str = Field(alias="cameraSupplement")
    lighting_supplement: str = Field(alias="lightingSupplement")
    true_emotion_description: str = Field(alias="trueEmotionDescription", min_length=1)

    @field_validator(
        "spoken_text",
        "visual_behavior",
        "vocal_delivery",
        "environmental_sound",
        "setting",
        "camera_supplement",
        "lighting_supplement",
        "true_emotion_description",
    )
    @classmethod
    def reject_changed_whitespace(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value != value.strip() or "\n" in value or "\r" in value:
            raise ValueError("Component text must not contain surrounding whitespace or line breaks")
        return value

    @field_validator("environmental_sound")
    @classmethod
    def validate_environmental_sound(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip():
            raise ValueError("Environmental sound must be null or a non-blank sentence")
        if value != value.strip() or "\n" in value or "\r" in value:
            raise ValueError("Component text must not contain surrounding whitespace or line breaks")
        return value

    @field_validator("true_emotion_description")
    @classmethod
    def validate_true_emotion_description(cls, value: str) -> str:
        return _validate_true_emotion_description(value)

    @field_validator(
        "visual_behavior",
        "vocal_delivery",
        "environmental_sound",
        "setting",
        "camera_supplement",
        "lighting_supplement",
    )
    @classmethod
    def require_english_component_text(cls, value: str | None) -> str | None:
        if value and (re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", value) or '"' in value):
            raise ValueError("Render prompt components must use English and contain no double quotes")
        return value

    @field_validator("visual_behavior", "environmental_sound", "setting")
    @classmethod
    def require_complete_sentence(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value[-1] not in ".!?":
            raise ValueError("The component must be a complete sentence")
        return value

    @field_validator("vocal_delivery")
    @classmethod
    def require_delivery_phrase(cls, value: str) -> str:
        if value[-1] in ".!?":
            raise ValueError("Vocal delivery must be a phrase without terminal punctuation")
        return value

    @field_validator("camera_supplement", "lighting_supplement")
    @classmethod
    def validate_optional_sentence(cls, value: str) -> str:
        if value and value[-1] not in ".!?":
            raise ValueError("A non-empty supplement must be a complete sentence")
        return value

    @field_validator("visual_behavior", "environmental_sound", "setting")
    @classmethod
    def reject_other_people(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cls._reject_phrases(value, FORBIDDEN_COMPONENT_PERSON_PHRASES, "another person")
        return value

    @field_validator("visual_behavior")
    @classmethod
    def reject_non_portrait_behavior(cls, value: str) -> str:
        cls._reject_phrases(value, FORBIDDEN_COMPONENT_PORTRAIT_PHRASES, "non-frontal behavior")
        return value

    @field_validator("camera_supplement")
    @classmethod
    def reject_camera_changes(cls, value: str) -> str:
        cls._reject_phrases(value, FORBIDDEN_COMPONENT_CAMERA_PHRASES, "camera movement or wide framing")
        return value

    @field_validator("lighting_supplement", "setting")
    @classmethod
    def reject_unreadable_lighting(cls, value: str) -> str:
        cls._reject_phrases(value, FORBIDDEN_COMPONENT_LIGHTING_PHRASES, "unreadable lighting or visible equipment")
        return value

    @staticmethod
    def _reject_phrases(value: str, phrases: tuple[str, ...], label: str) -> None:
        normalized = value.casefold()
        if any(phrase in normalized for phrase in phrases):
            raise ValueError(f"Component text must not contain {label}")


@dataclass(frozen=True)
class PromptContext:
    content: ContentPlan
    preset: PromptPreset
    positive_examples: list[str]
    negative_examples: list[str]
    background: VideoBackgroundPreset
    age: int
    gender: Gender
    ethnicity: Ethnicity


@dataclass(frozen=True)
class PreparedPrompt:
    policy_version: str
    category: Category
    true_emotion: str
    apparent_emotion: str
    age: int
    gender: Gender
    ethnicity: Ethnicity
    system_input: str
    user_input: str
    final_negative_prompt: str
    fixed_output: GeneratedPrompt | None


@dataclass(frozen=True)
class PromptResult:
    policy_version: str
    system_input: str
    user_input: str
    raw_structured_response: str
    final_positive_prompt: str
    final_negative_prompt: str
    dialogue: str | None
    vt_text: str | None
    true_emotion_description: str


class PromptService:
    def __init__(self, model: PromptModel) -> None:
        template_root = Path(__file__).with_name("templates")
        self.environment = Environment(
            loader=FileSystemLoader(template_root),
            undefined=StrictUndefined,
            autoescape=False,
            keep_trailing_newline=False,
        )
        self.system_template = self.environment.get_template("prompt_system.j2")
        self.user_template = self.environment.get_template("prompt_user.j2")
        self.model = model

    def prepare(self, context: PromptContext) -> PreparedPrompt:
        policy = POLICIES[context.content.category]
        system_input = self.system_template.render(
            policy=policy,
            direction_rule=direction_rule(context.content.category, context.content.conflict_direction),
            banned_certainty_modifiers=BANNED_CERTAINTY_MODIFIERS,
        ).strip()
        user_input = self.user_template.render(
            policy=policy,
            content_instruction=context.content.content_requirements_en,
            scene=context.content.scene_en,
            trigger_event=context.content.trigger_event_en,
            psychological_background=context.content.psychological_background_en,
            true_emotion=context.content.true_emotion,
            apparent_emotion=context.content.apparent_emotion,
            content_scene_supplement=context.content.scene_supplement_en,
            style_instruction=context.preset.style_instruction,
            preset_scene_supplement=context.preset.scene_supplement,
            positive_examples=context.positive_examples,
            negative_examples=context.negative_examples,
            background={
                "scene": context.background.scene_en,
                "ambient_audio": context.background.ambient_sound_en,
                "relationship": context.background.participant_relationship_en,
                "lighting": context.background.lighting_en,
                "framing_supplement": context.background.framing_en,
            },
            age=context.age,
            gender=context.gender.value,
            ethnicity=context.ethnicity.value,
        ).strip()
        fixed_output = self._fixed_output(context) if context.content.mode is ContentMode.FIXED else None
        return PreparedPrompt(
            policy_version=POLICY_VERSION,
            category=context.content.category,
            true_emotion=context.content.true_emotion,
            apparent_emotion=context.content.apparent_emotion,
            age=context.age,
            gender=context.gender,
            ethnicity=context.ethnicity,
            system_input=system_input,
            user_input=user_input,
            final_negative_prompt=context.preset.final_negative_prompt,
            fixed_output=fixed_output,
        )

    async def complete(self, prepared: PreparedPrompt, category: Category) -> PromptResult:
        if category is not prepared.category:
            raise ServiceError(422, "validation_error", "The prepared prompt category does not match the request")
        if prepared.fixed_output is None:
            try:
                raw = await self.model.generate(prepared.system_input, prepared.user_input)
            except PromptAdapterError as error:
                status = 503 if error.code == "external_configuration_missing" else 502
                raise ServiceError(status, error.code, error.message) from error
            try:
                components = GeneratedPromptComponents.model_validate(_load_unique_json_object(raw))
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                raise ServiceError(
                    502,
                    "invalid_prompt_response",
                    "The prompt service returned data that does not match the required structure",
                ) from error
            output = self._generated_output(prepared, category, components)
        else:
            output = prepared.fixed_output
            raw = output.model_dump_json(by_alias=True)
        return self._result(prepared, category, output, raw)

    @classmethod
    def _result(
        cls,
        prepared: PreparedPrompt,
        category: Category,
        output: GeneratedPrompt,
        raw: str,
    ) -> PromptResult:
        cls._validate_output(category, output)
        spoken_text = output.dialogue if category in {Category.A_VA, Category.C_VA} else output.vt_text
        assert spoken_text is not None
        try:
            validate_final_positive_prompt(
                output.positive_prompt,
                spoken_text=spoken_text,
                true_emotion=prepared.true_emotion,
                apparent_emotion=prepared.apparent_emotion,
                expected_ethnicity=cls._ethnicity_text(prepared.ethnicity),
                expected_gender=prepared.gender.value,
                expected_age=prepared.age,
            )
        except PromptPolicyViolation as error:
            raise ServiceError(
                502,
                "invalid_prompt_response",
                f"The final positive prompt violates the prompt policy: {error}",
            ) from error
        return PromptResult(
            policy_version=prepared.policy_version,
            system_input=prepared.system_input,
            user_input=prepared.user_input,
            raw_structured_response=raw,
            final_positive_prompt=output.positive_prompt,
            final_negative_prompt=prepared.final_negative_prompt,
            dialogue=output.dialogue,
            vt_text=output.vt_text,
            true_emotion_description=output.true_emotion_description,
        )

    @classmethod
    def _generated_output(
        cls,
        prepared: PreparedPrompt,
        category: Category,
        components: GeneratedPromptComponents,
    ) -> GeneratedPrompt:
        subject = (
            f"A {prepared.age}-year-old {cls._ethnicity_text(prepared.ethnicity)} "
            f"{prepared.gender.value.lower()} is the only person visible in photorealistic live-action footage "
            "with natural skin texture."
        )
        speech = f'The subject says "{components.spoken_text}" {components.vocal_delivery}.'
        camera = (
            "The camera stays locked off in a front-facing close-up head-and-shoulders portrait, "
            "with the full face filling much of the frame."
        )
        lighting = "Bright, soft, even lighting keeps the face fully readable without heavy shadows."
        environmental_sound = cls._environmental_sound_text(components.environmental_sound)
        positive = " ".join(
            value
            for value in (
                subject,
                components.visual_behavior,
                speech,
                environmental_sound,
                components.setting,
                camera,
                components.camera_supplement,
                lighting,
                components.lighting_supplement,
            )
            if value
        )
        is_va = category in {Category.A_VA, Category.C_VA}
        return GeneratedPrompt(
            positivePrompt=positive,
            dialogue=components.spoken_text if is_va else None,
            vtText=None if is_va else components.spoken_text,
            trueEmotionDescription=components.true_emotion_description,
        )

    def _fixed_output(self, context: PromptContext) -> GeneratedPrompt:
        content = context.content
        background = context.background
        demographic = (
            f"The subject is a {context.age}-year-old {self._ethnicity_text(context.ethnicity)} "
            f"{context.gender.value.lower()} adult."
        )
        positive = " ".join(
            value
            for value in (
                demographic,
                content.base_video_prompt,
                self._dialogue_instruction(content),
                self._environmental_sound_text(background.ambient_sound_en),
                background.scene_en,
                background.participant_relationship_en,
                content.scene_supplement_en,
                context.preset.scene_supplement,
                context.preset.style_instruction,
                background.framing_en,
                background.lighting_en,
            )
            if value
        )
        return GeneratedPrompt(
            positivePrompt=positive,
            dialogue=content.dialogue,
            vtText=content.display_text,
            trueEmotionDescription=content.true_emotion_description,
        )

    @staticmethod
    def _dialogue_instruction(content: ContentPlan) -> str:
        spoken_text = (
            content.dialogue
            if content.category in {Category.A_VA, Category.C_VA}
            else content.display_text
        )
        if not spoken_text:
            return ""
        return f'The subject says "{spoken_text}" with a natural, audible voice.'

    @staticmethod
    def _validate_output(category: Category, output: GeneratedPrompt) -> None:
        is_va = category in {Category.A_VA, Category.C_VA}
        if is_va and (not output.dialogue or output.vt_text is not None):
            raise ServiceError(502, "invalid_prompt_response", "VA prompt output must contain dialogue and no VT text")
        if not is_va and (not output.vt_text or output.dialogue is not None):
            raise ServiceError(502, "invalid_prompt_response", "VT prompt output must contain VT text and no dialogue")
        chinese_values = [output.dialogue if is_va else output.vt_text, output.true_emotion_description]
        if any(not value or not re.search(r"[\u4e00-\u9fff]", value) for value in chinese_values):
            raise ServiceError(
                502,
                "invalid_prompt_response",
                "Dialogue, VT text and the true emotion description must use Chinese where required",
            )
        try:
            _validate_true_emotion_description(output.true_emotion_description)
        except ValueError as error:
            raise ServiceError(
                502,
                "invalid_prompt_response",
                str(error),
            ) from error

    @staticmethod
    def _environmental_sound_text(value: str | None) -> str:
        return value if value else SILENT_ENVIRONMENT_SOUND

    @staticmethod
    def _ethnicity_text(value: Ethnicity) -> str:
        return {
            Ethnicity.EAST_ASIAN: "East Asian",
            Ethnicity.WHITE: "White",
            Ethnicity.BLACK: "Black",
            Ethnicity.SOUTH_ASIAN: "South Asian",
            Ethnicity.LATINO: "Latino",
        }[value]


def _load_unique_json_object(raw: str) -> dict[str, object]:
    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    value = json.loads(raw, object_pairs_hook=reject_duplicate_keys)
    if not isinstance(value, dict):
        raise ValueError("The prompt response must be a JSON object")
    return value


def _validate_true_emotion_description(value: str) -> str:
    if value != value.strip() or "\n" in value or "\r" in value:
        raise ValueError("True emotion description must not contain surrounding whitespace or line breaks")
    if not re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", value):
        raise ValueError("True emotion description must use natural Chinese for a reviewer")
    normalized = re.sub(r"[\s_-]+", "", value).casefold()
    if any(re.sub(r"[\s_-]+", "", token).casefold() in normalized for token in FORBIDDEN_TRUE_EMOTION_DESCRIPTION_TOKENS):
        raise ValueError("True emotion description must use natural Chinese for a reviewer")
    return value
