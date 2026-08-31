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
from backend.domain.enums import Category, Ethnicity, Gender, Language, ModelName
from backend.domain.models import ContentScript, PromptTemplateVersion, Scene
from backend.domain.schemas import PromptFailureDetails, PromptSchemaFieldDetail
from backend.domain.prompt_policy import (
    BANNED_CERTAINTY_MODIFIERS,
    COMPONENT_WORD_LIMITS,
    LANGUAGE_DISPLAY,
    POLICY_VERSION,
    SPOKEN_LINE_RULES,
    POLICIES,
    PromptPolicyViolation,
    direction_rule,
    validate_scene_policy_fields,
    validate_component_word_limit,
    validate_final_positive_prompt,
    validate_generated_component,
)

from .errors import PromptServiceError, ServiceError


MAX_PROMPT_ATTEMPTS = 3
RETRYABLE_PROMPT_FAILURE_CODES = frozenset(
    {
        "invalid_prompt_json",
        "duplicate_prompt_key",
        "invalid_prompt_schema",
        "invalid_prompt_response",
    }
)
RETRY_PREVIOUS_RESPONSE_LIMIT = 4000

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


@dataclass(frozen=True)
class PromptContext:
    content: ContentScript
    template_version: PromptTemplateVersion
    positive_examples: list[str]
    negative_examples: list[str]
    scene: Scene
    age: int
    gender: Gender
    ethnicity: Ethnicity
    model: ModelName
    language: Language = Language.ZH


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
    negative_prompt: str
    language: Language = Language.ZH


@dataclass(frozen=True)
class PromptResult:
    policy_version: str
    system_input: str
    user_input: str
    raw_structured_response: str
    final_positive_prompt: str
    negative_prompt: str
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
    @property
    def configured(self) -> bool:
        return self.model.configured


    def prepare(self, context: PromptContext) -> PreparedPrompt:
        try:
            validate_scene_policy_fields(
                {
                    "sceneEn": context.scene.scene_en,
                    "ambientSoundEn": context.scene.ambient_sound_en,
                    "participantRelationshipEn": (
                        context.scene.participant_relationship_en
                    ),
                    "lightingEn": context.scene.lighting_en,
                    "framingEn": context.scene.framing_en,
                }
            )
        except PromptPolicyViolation as error:
            raise ServiceError(
                422,
                "validation_error",
                "The selected scene violates the prompt policy",
                {
                    "fields": [
                        {
                            "path": "scene",
                            "type": "prompt_policy",
                            "reason": str(error),
                        }
                    ]
                },
            ) from error

        policy = POLICIES[context.content.category]
        system_input = self.system_template.render(
            policy=policy,
            direction_rule=direction_rule(
                context.content.category, context.content.conflict_direction
            ),
            banned_certainty_modifiers=BANNED_CERTAINTY_MODIFIERS,
            component_word_limits=COMPONENT_WORD_LIMITS,
            spoken_language=LANGUAGE_DISPLAY[context.language],
            spoken_line_rule=SPOKEN_LINE_RULES[context.language],
        ).strip()
        user_input = self.user_template.render(
            policy=policy,
            content_instruction=(
                context.content.content_requirements_en
                or context.content.base_video_prompt
            ),
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
            organization_instruction=context.template_version.organization_instruction,
            style_instruction=context.template_version.style_instruction,
            positive_examples=context.positive_examples,
            negative_examples=context.negative_examples,
            shooting_scene={
                "scene": context.scene.scene_en,
                "ambient_audio": context.scene.ambient_sound_en,
                "relationship": context.scene.participant_relationship_en,
                "lighting": context.scene.lighting_en,
                "framing_supplement": context.scene.framing_en,
            },
            age=context.age,
            gender=context.gender.value,
            ethnicity=context.ethnicity.value,
            spoken_language=LANGUAGE_DISPLAY[context.language],
        ).strip()
        return PreparedPrompt(
            policy_version=POLICY_VERSION,
            category=context.content.category,
            true_emotion=context.content.true_emotion,
            apparent_emotion=context.content.apparent_emotion,
            age=context.age,
            gender=context.gender,
            ethnicity=context.ethnicity,
            language=context.language,
            system_input=system_input,
            user_input=user_input,
            negative_prompt=(
                context.template_version.h3_negative_prompt
                if context.model is ModelName.H3
                else context.template_version.ltx_negative_prompt
            ),
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
        user_input = prepared.user_input
        for attempt in range(1, MAX_PROMPT_ATTEMPTS + 1):
            try:
                response = await self.model.generate(
                    prepared.system_input, user_input
                )
            except PromptAdapterError as error:
                status = 503 if error.code == "external_configuration_missing" else 502
                raise PromptServiceError(
                    status,
                    error.code,
                    error.message,
                    PromptFailureDetails.model_validate(error.details)
                    if error.metadata is not None
                    else None,
                ) from error
            raw = response.content
            transport_details = response.metadata.as_details()
            try:
                return self._complete_attempt(
                    prepared, category, raw, transport_details
                )
            except ServiceError as error:
                if (
                    attempt == MAX_PROMPT_ATTEMPTS
                    or error.code not in RETRYABLE_PROMPT_FAILURE_CODES
                ):
                    raise
                user_input = _retry_user_input(
                    prepared.user_input, raw, _failure_reasons(error)
                )
        raise AssertionError("prompt completion loop must return or raise")

    def _complete_attempt(
        self,
        prepared: PreparedPrompt,
        category: Category,
        raw: str,
        transport_details: dict[str, int | str],
    ) -> PromptResult:
        try:
            payload = _load_unique_json(raw)
        except DuplicatePromptKeyError as error:
            raise PromptServiceError(
                502,
                "duplicate_prompt_key",
                "The prompt service returned JSON with a duplicate key",
                PromptFailureDetails.model_validate(transport_details),
            ) from error
        except json.JSONDecodeError as error:
            raise PromptServiceError(
                502,
                "invalid_prompt_json",
                "The prompt service returned invalid JSON",
                PromptFailureDetails.model_validate(transport_details),
            ) from error
        try:
            output = GeneratedPrompt.model_validate(payload)
        except ValidationError as error:
            raise PromptServiceError(
                502,
                "invalid_prompt_schema",
                "The prompt service returned JSON that does not match the required schema",
                PromptFailureDetails(
                    **transport_details,
                    fields=[
                        PromptSchemaFieldDetail.model_validate(field)
                        for field in _pydantic_error_fields(error)
                    ],
                ),
            ) from error
        return self._generated_result(prepared, category, output, raw)

    @classmethod
    def _generated_result(
        cls,
        prepared: PreparedPrompt,
        category: Category,
        output: GeneratedPrompt,
        raw: str,
    ) -> PromptResult:
        cls._validate_generated_output(output, prepared.language)
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
                language=prepared.language,
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
            negative_prompt=prepared.negative_prompt,
            dialogue=output.spoken_text if is_va else None,
            vt_text=None if is_va else output.spoken_text,
            true_emotion_description=output.true_emotion_description,
        )

    @staticmethod
    def _validate_generated_output(
        output: GeneratedPrompt, language: Language = Language.ZH
    ) -> None:
        try:
            _validate_spoken_text_component(output.spoken_text, language)
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


class DuplicatePromptKeyError(ValueError):
    pass


def _failure_reasons(error: ServiceError) -> list[str]:
    fields = error.details.get("fields") if isinstance(error.details, dict) else None
    if isinstance(fields, list) and fields:
        reasons: list[str] = []
        for field in fields:
            if isinstance(field, dict) and field.get("reason"):
                path = field.get("path")
                reason = str(field["reason"])
                reasons.append(f"{path}: {reason}" if path else reason)
        if reasons:
            return reasons
    return [error.message]


def _retry_user_input(
    base_user_input: str, previous_raw: str, reasons: list[str]
) -> str:
    previous = previous_raw.strip()
    if len(previous) > RETRY_PREVIOUS_RESPONSE_LIMIT:
        previous = previous[:RETRY_PREVIOUS_RESPONSE_LIMIT]
    listed = "\n".join(f"- {reason}" for reason in reasons)
    return (
        f"{base_user_input}\n\n"
        "Your previous JSON attempt was rejected by the application validator.\n"
        f"Previous attempt:\n{previous}\n\n"
        f"Validation errors:\n{listed}\n\n"
        "Return one corrected strict JSON object with the same keys. "
        "Fix every listed problem, keep the other field values unchanged, "
        "and count the words in each component to stay inside its word budget."
    )


def _load_unique_json(raw: str) -> object:
    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise DuplicatePromptKeyError(
                    "The prompt response contains a duplicate JSON key"
                )
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=reject_duplicate_keys)


def _pydantic_error_fields(error: ValidationError) -> list[dict[str, str]]:
    fields: list[dict[str, str]] = []
    for item in error.errors(
        include_url=False,
        include_context=False,
        include_input=False,
    ):
        fields.append(
            {
                "path": ".".join(str(part) for part in item["loc"]),
                "type": str(item["type"]),
                "reason": str(item["msg"]).removeprefix("Value error, "),
            }
        )
    return fields


def _validate_spoken_text_component(
    value: str, language: Language = Language.ZH
) -> str:
    if value != value.strip() or "\n" in value or "\r" in value:
        raise ValueError(
            "spokenText must not contain surrounding whitespace or line breaks"
        )
    if any(
        mark in value for mark in ('"', "'", "\u2018", "\u2019", "\u201c", "\u201d")
    ):
        raise ValueError("spokenText must not contain quote marks")
    if language is Language.EN:
        if not value.isascii():
            raise ValueError("spokenText must be plain ASCII English")
        words = len([word for word in re.split(r"[^A-Za-z]+", value) if word])
        if not 2 <= words <= 14:
            raise ValueError("spokenText must contain 2 to 14 English words")
        return value
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
