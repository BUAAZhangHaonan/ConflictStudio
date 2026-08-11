from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from backend.adapters.llm import PromptAdapterError, PromptModel
from backend.domain.enums import Category, ContentMode, Ethnicity, Gender
from backend.domain.models import ContentPlan, PromptPreset, VideoBackgroundPreset
from backend.domain.prompt_policy import (
    POLICY_VERSION,
    POLICIES,
    PromptPolicyViolation,
    direction_rule,
    validate_final_positive_prompt,
)

from .errors import ServiceError


class GeneratedPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)

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
        ).strip()
        user_input = self.user_template.render(
            policy=policy,
            content_instruction=context.content.content_instruction,
            scene=context.content.scene,
            trigger_event=context.content.trigger_event,
            psychological_background=context.content.psychological_background,
            true_emotion=context.content.true_emotion,
            apparent_emotion=context.content.apparent_emotion,
            content_scene_supplement=context.content.scene_supplement,
            style_instruction=context.preset.style_instruction,
            preset_scene_supplement=context.preset.scene_supplement,
            positive_examples=context.positive_examples,
            negative_examples=context.negative_examples,
            background=context.background,
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
                output = GeneratedPrompt.model_validate_json(raw)
            except ValidationError as error:
                raise ServiceError(
                    502,
                    "invalid_prompt_response",
                    "The prompt service returned data that does not match the required structure",
                ) from error
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
                background.ambient_audio,
                background.scene,
                background.relationship,
                content.scene_supplement,
                context.preset.scene_supplement,
                context.preset.style_instruction,
                background.framing_supplement,
                background.lighting,
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

    @staticmethod
    def _ethnicity_text(value: Ethnicity) -> str:
        return {
            Ethnicity.EAST_ASIAN: "East Asian",
            Ethnicity.WHITE: "White",
            Ethnicity.BLACK: "Black",
            Ethnicity.SOUTH_ASIAN: "South Asian",
            Ethnicity.LATINO: "Latino",
        }[value]
