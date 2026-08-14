from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    ValidationInfo,
    field_validator,
)

from backend.adapters.llm import PromptAdapterError, PromptModel
from backend.domain.enums import Category, ContentMode, Ethnicity, Gender
from backend.domain.models import ContentPlan, PromptPreset, VideoBackgroundPreset
from backend.domain.prompt_policy import (
    BANNED_CERTAINTY_MODIFIERS,
    COMPONENT_WORD_LIMITS,
    POLICY_VERSION,
    POLICIES,
    PromptPolicyViolation,
    direction_rule,
    validate_component_word_limit,
    validate_final_positive_prompt,
    validate_fixed_positive_prompt,
    validate_generated_component,
)

from .errors import ServiceError


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


class GeneratedPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    spoken_text: str = Field(alias="spokenText", min_length=1)
    appearance: str = Field(min_length=1)
    body_action: str = Field(alias="bodyAction", min_length=1)
    vocal_delivery: str = Field(alias="vocalDelivery", min_length=1)
    environmental_sound: str = Field(alias="environmentalSound", min_length=1)
    setting: str = Field(min_length=1)
    camera: str = Field(min_length=1)
    lighting: str = Field(min_length=1)
    true_emotion_description: str = Field(alias="trueEmotionDescription", min_length=1)

    @field_validator(
        "spoken_text",
        "appearance",
        "body_action",
        "vocal_delivery",
        "environmental_sound",
        "setting",
        "camera",
        "lighting",
        "true_emotion_description",
    )
    @classmethod
    def reject_blank_required_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("The field must not be blank")
        return value

    @field_validator(*COMPONENT_WORD_LIMITS)
    @classmethod
    def enforce_english_component_word_limit(
        cls, value: str, info: ValidationInfo
    ) -> str:
        try:
            return validate_component_word_limit(value, info.field_name)
        except PromptPolicyViolation as error:
            raise ValueError(str(error)) from error


class FixedPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    positive_prompt: str = Field(alias="positivePrompt", min_length=1)
    dialogue: str | None
    vt_text: str | None = Field(alias="vtText")
    true_emotion_description: str = Field(alias="trueEmotionDescription", min_length=1)


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
    fixed_output: FixedPrompt | None


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
        fixed_output = None
        system_input = ""
        user_input = ""
        if context.content.mode is ContentMode.FIXED:
            fixed_output = self._fixed_output(context)
        else:
            policy = POLICIES[context.content.category]
            system_input = self.system_template.render(
                policy=policy,
                direction_rule=direction_rule(
                    context.content.category, context.content.conflict_direction
                ),
                banned_certainty_modifiers=BANNED_CERTAINTY_MODIFIERS,
                component_word_limits=COMPONENT_WORD_LIMITS,
            ).strip()
            user_input = self.user_template.render(
                policy=policy,
                content_instruction=context.content.content_requirements_en,
                scene=context.content.scene_en,
                trigger_event=context.content.trigger_event_en,
                psychological_background=context.content.psychological_background_en,
                true_emotion=context.content.true_emotion,
                apparent_emotion=context.content.apparent_emotion,
                requested_spoken_text=(
                    context.content.dialogue
                    if context.content.category in {Category.A_VA, Category.C_VA}
                    else context.content.display_text
                ),
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

    async def complete(
        self, prepared: PreparedPrompt, category: Category
    ) -> PromptResult:
        if category is not prepared.category:
            raise ServiceError(
                422,
                "validation_error",
                "The prepared prompt category does not match the request",
            )
        if prepared.fixed_output is None:
            try:
                raw = await self.model.generate(
                    prepared.system_input, prepared.user_input
                )
            except PromptAdapterError as error:
                status = 503 if error.code == "external_configuration_missing" else 502
                raise ServiceError(status, error.code, error.message) from error
            try:
                output = GeneratedPrompt.model_validate(_load_unique_json_object(raw))
            except (ValidationError, ValueError, json.JSONDecodeError) as error:
                raise ServiceError(
                    502,
                    "invalid_prompt_response",
                    "The prompt service returned data that does not match the required structure",
                ) from error
        else:
            output = prepared.fixed_output
            raw = output.model_dump_json(by_alias=True)
            return self._fixed_result(prepared, category, output, raw)
        return self._generated_result(prepared, category, output, raw)

    @classmethod
    def _generated_result(
        cls,
        prepared: PreparedPrompt,
        category: Category,
        output: GeneratedPrompt,
        raw: str,
    ) -> PromptResult:
        cls._validate_generated_output(output)
        positive_prompt = cls._assemble_positive_prompt(prepared, output)
        try:
            validate_final_positive_prompt(
                positive_prompt,
                spoken_text=output.spoken_text,
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
        is_va = category in {Category.A_VA, Category.C_VA}
        return PromptResult(
            policy_version=prepared.policy_version,
            system_input=prepared.system_input,
            user_input=prepared.user_input,
            raw_structured_response=raw,
            final_positive_prompt=positive_prompt,
            final_negative_prompt=prepared.final_negative_prompt,
            dialogue=output.spoken_text if is_va else None,
            vt_text=None if is_va else output.spoken_text,
            true_emotion_description=output.true_emotion_description,
        )

    @classmethod
    def _fixed_result(
        cls,
        prepared: PreparedPrompt,
        category: Category,
        output: FixedPrompt,
        raw: str,
    ) -> PromptResult:
        cls._validate_fixed_output(category, output)
        try:
            validate_fixed_positive_prompt(output.positive_prompt, category=category)
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

    def _fixed_output(self, context: PromptContext) -> FixedPrompt:
        content = context.content
        demographic = self._fixed_demographic_text(
            context.age, context.ethnicity, context.gender
        )
        positive = content.base_video_prompt.replace("{demographic}", demographic)
        return FixedPrompt(
            positivePrompt=positive,
            dialogue=content.dialogue,
            vtText=content.display_text,
            trueEmotionDescription=content.true_emotion_description,
        )

    @staticmethod
    def _validate_fixed_output(category: Category, output: FixedPrompt) -> None:
        is_va = category in {Category.A_VA, Category.C_VA}
        if is_va and (not output.dialogue or output.vt_text is not None):
            raise ServiceError(
                502,
                "invalid_prompt_response",
                "VA prompt output must contain dialogue and no VT text",
            )
        if not is_va and (not output.vt_text or output.dialogue is not None):
            raise ServiceError(
                502,
                "invalid_prompt_response",
                "VT prompt output must contain VT text and no dialogue",
            )
        chinese_values = [
            output.dialogue if is_va else output.vt_text,
            output.true_emotion_description,
        ]
        if any(
            not value or not re.search(r"[\u4e00-\u9fff]", value)
            for value in chinese_values
        ):
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
    def _validate_generated_output(output: GeneratedPrompt) -> None:
        try:
            _validate_spoken_text_component(output.spoken_text)
            for field_name in (
                "appearance",
                "body_action",
                "vocal_delivery",
                "environmental_sound",
                "setting",
                "camera",
                "lighting",
            ):
                validate_generated_component(getattr(output, field_name), field_name)
            _validate_true_emotion_description(output.true_emotion_description)
        except (PromptPolicyViolation, ValueError) as error:
            raise ServiceError(502, "invalid_prompt_response", str(error)) from error

    @classmethod
    def _assemble_positive_prompt(
        cls, prepared: PreparedPrompt, output: GeneratedPrompt
    ) -> str:
        person = "woman" if prepared.gender is Gender.FEMALE else "man"
        pronoun = "She" if prepared.gender is Gender.FEMALE else "He"
        demographic = (
            f"A {prepared.age}-year-old {cls._ethnicity_text(prepared.ethnicity)} {person} "
            "appears alone and faces the camera."
        )
        speech = f"{pronoun} says '{output.spoken_text}' once."
        return " ".join(
            (
                demographic,
                output.appearance,
                output.body_action,
                speech,
                output.vocal_delivery,
                output.environmental_sound,
                output.setting,
                output.camera,
                output.lighting,
            )
        )

    @staticmethod
    def _ethnicity_text(value: Ethnicity) -> str:
        return {
            Ethnicity.EAST_ASIAN: "East Asian",
            Ethnicity.WHITE: "White",
            Ethnicity.BLACK: "Black",
            Ethnicity.SOUTH_ASIAN: "South Asian",
            Ethnicity.LATINO: "Latino",
        }[value]

    @classmethod
    def _fixed_demographic_text(
        cls, age: int, ethnicity: Ethnicity, gender: Gender
    ) -> str:
        person = "woman" if gender is Gender.FEMALE else "man"
        return f"A {age}-year-old {cls._ethnicity_text(ethnicity)} {person}"


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


def _validate_spoken_text_component(value: str) -> str:
    if value != value.strip() or "\n" in value or "\r" in value:
        raise ValueError(
            "spokenText must not contain surrounding whitespace or line breaks"
        )
    if any(
        mark in value for mark in ('"', "'", "\u2018", "\u2019", "\u201c", "\u201d")
    ):
        raise ValueError("spokenText must not contain quote marks")
    han_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", value))
    other_alphanumeric_count = sum(
        1
        for character in value
        if character.isalnum()
        and not re.fullmatch(r"[\u3400-\u4dbf\u4e00-\u9fff]", character)
    )
    if han_count < 2 or han_count <= other_alphanumeric_count:
        raise ValueError(
            "spokenText must be natural Chinese and contain at least two Chinese characters"
        )
    if not 2 <= len(value) <= 40:
        raise ValueError("spokenText must contain 2 to 40 characters")
    return value


def _validate_true_emotion_description(value: str) -> str:
    if value != value.strip() or "\n" in value or "\r" in value:
        raise ValueError(
            "True emotion description must not contain surrounding whitespace or line breaks"
        )
    if not re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", value):
        raise ValueError(
            "True emotion description must use natural Chinese for a reviewer"
        )
    normalized = re.sub(r"[\s_-]+", "", value).casefold()
    if any(
        re.sub(r"[\s_-]+", "", token).casefold() in normalized
        for token in FORBIDDEN_TRUE_EMOTION_DESCRIPTION_TOKENS
    ):
        raise ValueError(
            "True emotion description must use natural Chinese for a reviewer"
        )
    return value
