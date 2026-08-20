from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .enums import Category, ConflictDirection


POLICY_VERSION = "2026-08-20.1"

COMPONENT_WORD_LIMITS: Mapping[str, int] = {
    "appearance": 18,
    "body_action": 36,
    "vocal_delivery": 18,
    "environmental_sound": 17,
    "setting": 22,
    "camera": 19,
    "lighting": 16,
}
ASSEMBLY_ENGLISH_WORD_OVERHEAD_MAX = 14
FINAL_POSITIVE_PROMPT_MAX_WORDS = 160

assert (
    sum(COMPONENT_WORD_LIMITS.values()) + ASSEMBLY_ENGLISH_WORD_OVERHEAD_MAX
    <= FINAL_POSITIVE_PROMPT_MAX_WORDS
)


@dataclass(frozen=True)
class CategoryPolicy:
    category: Category
    protocol_rule: str
    relation_rule: str
    output_rule: str


POLICIES = {
    Category.A_VA: CategoryPolicy(
        category=Category.A_VA,
        protocol_rule=(
            "The visible behavior, Mandarin words and vocal delivery all convey the true state."
        ),
        relation_rule="Keep the visible and audible evidence aligned.",
        output_rule=(
            "spokenText is the Mandarin dialogue. bodyAction and vocalDelivery both carry the true state."
        ),
    ),
    Category.A_VT: CategoryPolicy(
        category=Category.A_VT,
        protocol_rule=(
            "The visible behavior and independently stored Mandarin text both convey the true state. "
            "The source vocal delivery follows the visible behavior before the audio is removed."
        ),
        relation_rule="Keep the visible evidence and stored text aligned without rendering the text on screen.",
        output_rule=(
            "spokenText is the independently stored Mandarin vtText. bodyAction, vocalDelivery and spokenText "
            "all carry the true state in the audio-bearing source video; the application removes its audio later."
        ),
    ),
    Category.C_VA: CategoryPolicy(
        category=Category.C_VA,
        protocol_rule="The visible behavior intentionally disagrees with the Mandarin words and vocal delivery.",
        relation_rule="Follow the selected direction exactly and keep the disagreement readable throughout the clip.",
        output_rule=(
            "spokenText is the Mandarin dialogue. bodyAction carries the Vision assignment; vocalDelivery and "
            "spokenText carry the Audio assignment."
        ),
    ),
    Category.C_VT: CategoryPolicy(
        category=Category.C_VT,
        protocol_rule=(
            "The visible behavior intentionally disagrees with the independently stored Mandarin text. "
            "The source vocal delivery follows the visible behavior before the audio is removed."
        ),
        relation_rule="Follow the selected direction exactly and never render the stored text on screen.",
        output_rule=(
            "spokenText is the independently stored Mandarin vtText. bodyAction and vocalDelivery carry the "
            "Vision assignment in the audio-bearing source video; spokenText carries the Text assignment."
        ),
    ),
}


BANNED_EMOTION_LABELS: tuple[str, ...] = (
    "sad",
    "sadness",
    "happy",
    "happiness",
    "angry",
    "anger",
    "fearful",
    "fear",
    "disgusted",
    "disgust",
    "surprised",
    "surprise",
    "joyful",
    "joy",
    "depressed",
    "anxious",
    "melancholic",
)

BANNED_CERTAINTY_MODIFIERS: tuple[str, ...] = (
    "obviously",
    "definitely",
    "unmistakably",
    "undeniably",
    "evidently",
)

BANNED_CERTAINTY_CLAIM_PHRASES: tuple[str, ...] = (
    "clearly indicates",
    "clearly reveals",
    "clearly implies",
    "clearly proves",
    "clearly demonstrates",
)

FORBIDDEN_MULTI_SUBJECT_PHRASES: tuple[str, ...] = (
    "two people",
    "both characters",
    "a group of",
    "they both",
    "the pair",
    "both of them",
    "the couple",
    "several people",
    "the trio",
    "a crowd",
    "a friend",
    "the friend",
    "third adult",
)

FORBIDDEN_MUSIC_PHRASES: tuple[str, ...] = (
    "music",
    "soundtrack",
    "bgm",
    "background music",
    "score",
    "playlist",
    "song playing",
    "melody",
    "tune playing",
    "instrumental",
    "orchestra",
    "orchestral",
)

FORBIDDEN_INTERNAL_PHRASES: tuple[str, ...] = (
    "a-va",
    "a-vt",
    "c-va",
    "c-vt",
    "video_audio",
    "silent_video_text",
    "image_text",
    "visual channel",
    "audio channel",
    "acoustic channel",
    "text channel",
    "dialogue channel",
    "visual modality",
    "audio modality",
    "acoustic modality",
    "text modality",
    "dialogue modality",
    "true emotion",
    "apparent emotion",
    "surface emotion",
    "conflict direction",
    "internal plan",
    "protocol rule",
    "category name",
    "spokentext",
    "appearance field",
    "bodyaction",
    "vocaldelivery",
    "environmentalsound",
    "camera field",
    "lighting field",
    "trueemotiondescription",
    "ltx-2.3",
    "minimax h3",
)

FORBIDDEN_BACKGROUND_PROTOCOL_PHRASES: tuple[str, ...] = (
    "no speech",
    "no audible",
    "silently",
    "silent video",
    "mouths a silent",
    "no spoken",
    "muted",
    "mute audio",
    "subtitle",
    "caption",
    "rendered text",
    "text overlay",
    "words appear on screen",
)

FORBIDDEN_RENDERED_TEXT_PHRASES: tuple[str, ...] = (
    "subtitle",
    "caption",
    "rendered text",
    "text overlay",
    "words appear on screen",
)

FORBIDDEN_BACKGROUND_PERSON_PHRASES: tuple[str, ...] = (
    *FORBIDDEN_MULTI_SUBJECT_PHRASES,
    "one other person",
    "one other man",
    "one other woman",
    "one other adult",
    "another person",
    "another man",
    "another woman",
    "another adult",
    "second person",
    "second man",
    "second woman",
    "second adult",
    "off camera",
    "off-camera",
    "off frame",
    "off-frame",
    "offscreen person",
    "off-screen person",
    "offscreen voice",
    "off-screen voice",
    "a colleague",
    "the colleague",
    "a coworker",
    "the coworker",
    "an interviewer",
    "the interviewer",
    "a companion",
    "the companion",
    "a bystander",
    "the bystander",
    "other people",
    "background people",
)

_EXPLICIT_EMOTION_PREFIXES: tuple[str, ...] = (
    "emotion: ",
    "emotion = ",
    "emotion is ",
    "mood: ",
    "mood = ",
    "mood is ",
    "feels ",
    "seems ",
    "appears ",
    "looks ",
    "sounds ",
    "conveys ",
    "expresses ",
    "evokes ",
    "shows ",
    "indicates ",
    "signals ",
)

_EXPLICIT_EMOTION_SUFFIXES: tuple[str, ...] = (
    " emotion",
    " mood",
    " feeling",
    " affect",
    " emotional state",
    " atmosphere",
    " tone",
    " expression",
)

BACKGROUND_DATABASE_FORBIDDEN_PHRASES: tuple[str, ...] = tuple(
    dict.fromkeys(
        (
            *FORBIDDEN_BACKGROUND_PERSON_PHRASES,
            *FORBIDDEN_MUSIC_PHRASES,
            *FORBIDDEN_INTERNAL_PHRASES,
            *FORBIDDEN_BACKGROUND_PROTOCOL_PHRASES,
            *(
                f"{prefix}{label}"
                for prefix in _EXPLICIT_EMOTION_PREFIXES
                for label in BANNED_EMOTION_LABELS
            ),
            *(
                f"{label}{suffix}"
                for label in BANNED_EMOTION_LABELS
                for suffix in _EXPLICIT_EMOTION_SUFFIXES
            ),
        )
    )
)

_ENGLISH_WORD_RE = re.compile(r"\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_BULLET_RE = re.compile(r"(?:^|\s)(?:[-*\u2022]|\d+\.)\s")
def count_english_words(value: str) -> int:
    return len(_ENGLISH_WORD_RE.findall(value))


def validate_component_word_limit(value: str, field_name: str) -> str:
    max_words = COMPONENT_WORD_LIMITS[field_name]
    word_count = count_english_words(value)
    if word_count > max_words:
        raise PromptPolicyViolation(
            (
                f"{field_name} must contain no more than {max_words} English words; found {word_count}",
            )
        )
    return value


class PromptPolicyViolation(ValueError):
    def __init__(self, violations: Sequence[str]) -> None:
        self.violations = tuple(violations)
        super().__init__("; ".join(self.violations))


def direction_rule(category: Category, direction: ConflictDirection | None) -> str:
    if category in {Category.A_VA, Category.A_VT}:
        return "All retained channels carry the true state."
    if direction is None:
        raise ValueError("Conflict content requires a direction")
    if category is Category.C_VA and direction is ConflictDirection.VISION:
        return "Visible behavior carries the true state; the Mandarin words and vocal delivery carry the apparent state."
    if category is Category.C_VA and direction is ConflictDirection.AUDIO:
        return "The Mandarin words and vocal delivery carry the true state; visible behavior carries the apparent state."
    if category is Category.C_VT and direction is ConflictDirection.VISION:
        return "Visible behavior and source vocal delivery carry the true state; the stored Mandarin text carries the apparent state."
    if category is Category.C_VT and direction is ConflictDirection.TEXT:
        return "The stored Mandarin text carries the true state; visible behavior and source vocal delivery carry the apparent state."
    raise ValueError("Conflict direction does not match the category")


def validate_final_positive_prompt(
    prompt: str,
    *,
    spoken_text: str,
    true_emotion: str = "",
    apparent_emotion: str = "",
    expected_ethnicity: str | None = None,
    expected_gender: str | None = None,
    expected_age: int | None = None,
) -> None:
    """Validate a final video prompt without changing any supplied text."""

    violations: list[str] = []
    if not prompt.strip():
        raise PromptPolicyViolation(("positivePrompt must not be blank",))

    if "\n" in prompt or "\r" in prompt or _BULLET_RE.search(prompt):
        violations.append("positivePrompt must be one plain-text paragraph")
    if "```" in prompt:
        violations.append("positivePrompt must not contain a Markdown code fence")

    quoted_spoken_text = _validate_spoken_text(spoken_text, violations)
    if prompt.count(spoken_text) != 1 or quoted_spoken_text not in prompt:
        violations.append(
            "positivePrompt must contain the exact short spoken text once in single quotes"
        )

    narrative = (
        prompt.replace(quoted_spoken_text, "", 1) if quoted_spoken_text else prompt
    )
    word_count = count_english_words(narrative)
    if not 80 <= word_count <= FINAL_POSITIVE_PROMPT_MAX_WORDS:
        violations.append(
            f"positivePrompt must contain 80 to {FINAL_POSITIVE_PROMPT_MAX_WORDS} English words; found {word_count}"
        )
    if _CJK_RE.search(narrative):
        violations.append(
            "positivePrompt narrative must be English outside the quoted Mandarin speech"
        )

    banned_emotions = list(BANNED_EMOTION_LABELS)
    banned_emotions.extend(
        value for value in (true_emotion, apparent_emotion) if value.strip()
    )
    _append_phrase_violation(violations, prompt, banned_emotions, "emotion labels")
    _append_phrase_violation(
        violations, prompt, BANNED_CERTAINTY_MODIFIERS, "certainty claims"
    )
    _append_phrase_violation(
        violations, prompt, BANNED_CERTAINTY_CLAIM_PHRASES, "certainty claims"
    )
    _append_phrase_violation(
        violations, prompt, FORBIDDEN_MUSIC_PHRASES, "music or score terms"
    )
    _append_phrase_violation(
        violations,
        prompt,
        FORBIDDEN_INTERNAL_PHRASES,
        "internal category or protocol names",
    )
    _append_phrase_violation(
        violations,
        prompt,
        FORBIDDEN_RENDERED_TEXT_PHRASES,
        "subtitles, captions or rendered text",
    )

    _append_phrase_violation(
        violations,
        narrative,
        FORBIDDEN_MULTI_SUBJECT_PHRASES,
        "multiple on-screen people",
    )
    if re.search(
        r"\b(?:another|second)\s+(?:person|adult|man|woman|character)\b",
        narrative,
        re.IGNORECASE,
    ):
        violations.append("positivePrompt must contain exactly one on-screen person")
    if re.search(
        r"\b(?:three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:[a-z]+\s+){0,2}(?:adults|people|persons|men|women|characters)\b",
        narrative,
        re.IGNORECASE,
    ):
        violations.append("positivePrompt must contain exactly one on-screen person")
    if re.search(
        r"\b(?:man|woman|adult|person)\b[^.!?]{0,80}\band\b[^.!?]{0,80}\b(?:man|woman|adult|person)\b",
        narrative,
        re.IGNORECASE,
    ):
        violations.append("positivePrompt must contain exactly one on-screen person")
    _validate_expected_demographic(
        narrative, expected_ethnicity, expected_gender, violations
    )
    if expected_age is not None and not re.search(
        rf"\b{expected_age}-year-old\b", narrative, re.IGNORECASE
    ):
        violations.append("positivePrompt appearance must match the selected age")


    if violations:
        raise PromptPolicyViolation(violations)


def validate_generated_component(value: str, field_name: str) -> str:
    """Validate one schema component without guessing whether it fulfills another component's meaning."""

    violations: list[str] = []
    if not value.strip():
        violations.append(f"{field_name} must not be blank")
    if value != value.strip() or "\n" in value or "\r" in value:
        violations.append(f"{field_name} must be one trimmed line")
    if not value.endswith("."):
        violations.append(
            f"{field_name} must be a complete English sentence ending with a period"
        )
    if _CJK_RE.search(value):
        violations.append(f"{field_name} must use English only")
    try:
        validate_component_word_limit(value, field_name)
    except PromptPolicyViolation as error:
        violations.extend(error.violations)
    for phrases, label in (
        (BANNED_EMOTION_LABELS, "emotion labels"),
        (BANNED_CERTAINTY_MODIFIERS, "certainty claims"),
        (BANNED_CERTAINTY_CLAIM_PHRASES, "certainty claims"),
        (FORBIDDEN_MUSIC_PHRASES, "music or score terms"),
        (FORBIDDEN_INTERNAL_PHRASES, "internal category or protocol names"),
        (FORBIDDEN_RENDERED_TEXT_PHRASES, "subtitles, captions or rendered text"),
        (FORBIDDEN_MULTI_SUBJECT_PHRASES, "multiple people"),
    ):
        found = _find_phrases(value, phrases)
        if found:
            violations.append(
                f"{field_name} must not contain {label}: {', '.join(found)}"
            )
    if violations:
        raise PromptPolicyViolation(violations)
    return value


def validate_scene_policy_text(value: str, field_name: str = "scene") -> str:
    """Validate one shooting-scene text field and return it unchanged."""

    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    violations: list[str] = []
    _append_phrase_violation(
        violations, value, FORBIDDEN_BACKGROUND_PERSON_PHRASES, "another person"
    )
    _append_phrase_violation(
        violations, value, FORBIDDEN_MUSIC_PHRASES, "music or score terms"
    )
    emotion_labels = _find_explicit_emotion_label_uses(value, BANNED_EMOTION_LABELS)
    if emotion_labels:
        violations.append(
            f"positivePrompt must not contain emotion labels: {', '.join(emotion_labels)}"
        )
    _append_phrase_violation(
        violations,
        value,
        FORBIDDEN_INTERNAL_PHRASES,
        "internal category or protocol names",
    )
    _append_phrase_violation(
        violations, value, FORBIDDEN_BACKGROUND_PROTOCOL_PHRASES, "protocol conflicts"
    )
    if violations:
        raise PromptPolicyViolation(
            tuple(f"{field_name}: {violation}" for violation in violations)
        )
    return value


def validate_scene_policy_fields(values: Mapping[str, str]) -> None:
    for field_name, value in values.items():
        validate_scene_policy_text(value, field_name)


def _validate_spoken_text(spoken_text: str, violations: list[str]) -> str:
    if not spoken_text.strip():
        violations.append("spoken text must not be blank")
        return ""
    if spoken_text != spoken_text.strip() or "\n" in spoken_text or "\r" in spoken_text:
        violations.append(
            "spoken text must not contain surrounding whitespace or line breaks"
        )
    if any(
        mark in spoken_text
        for mark in ('"', "'", "\u2018", "\u2019", "\u201c", "\u201d")
    ):
        violations.append("spoken text must not contain quote marks")
    han_count = sum(1 for character in spoken_text if _CJK_RE.fullmatch(character))
    other_alphanumeric_count = sum(
        1
        for character in spoken_text
        if character.isalnum() and not _CJK_RE.fullmatch(character)
    )
    if han_count < 2 or han_count <= other_alphanumeric_count:
        violations.append(
            "spoken text must be predominantly Chinese and contain at least two Chinese characters"
        )
    if not 2 <= len(spoken_text) <= 40:
        violations.append("spoken text must contain 2 to 40 characters")
    return f"'{spoken_text}'"


def _append_phrase_violation(
    violations: list[str],
    text: str,
    phrases: Sequence[str],
    label: str,
) -> None:
    found = _find_phrases(text, phrases)
    if found:
        violations.append(
            f"positivePrompt must not contain {label}: {', '.join(found)}"
        )


def _find_phrases(text: str, phrases: Sequence[str]) -> list[str]:
    found: list[str] = []
    for phrase in phrases:
        clean = phrase.strip().casefold()
        if not clean:
            continue
        pattern = rf"(?<![A-Za-z0-9_]){re.escape(clean)}(?![A-Za-z0-9_])"
        if re.search(pattern, text.casefold()):
            found.append(clean)
    return list(dict.fromkeys(found))


def _find_explicit_emotion_label_uses(text: str, labels: Sequence[str]) -> list[str]:
    normalized = text.casefold()
    context_noun = (
        r"(?:emotion|mood|feeling|affect|emotional state|atmosphere|tone|expression)"
    )
    field_name = (
        rf"(?:(?:true|apparent|surface|target|expressed|displayed)\s+)?{context_noun}"
    )
    attribution = r"(?:feels?|seems?|appears?|looks?|sounds?|conveys?|expresses?|evokes?|shows?|indicates?|signals?)"
    found: list[str] = []

    for label in labels:
        clean = label.strip().casefold()
        if not clean:
            continue
        token = rf"(?<![A-Za-z0-9_]){re.escape(clean)}(?![A-Za-z0-9_])"
        patterns = (
            rf"^\s*{token}\s*$",
            rf"\b{field_name}\b\s*(?::|=|\bis\b)?\s*(?:an?\s+)?{token}",
            rf"{token}\s*(?:\bis\b\s*)?(?:the\s+)?\b{field_name}\b",
            rf"\b{attribution}\b\s+(?:clearly\s+|visibly\s+|strongly\s+)?{token}",
            rf"{token}\s+(?:emotional\s+)?\b{context_noun}\b",
        )
        if any(re.search(pattern, normalized) for pattern in patterns):
            found.append(clean)

    return list(dict.fromkeys(found))


def _validate_expected_demographic(
    text: str,
    expected_ethnicity: str | None,
    expected_gender: str | None,
    violations: list[str],
) -> None:
    normalized = text.casefold()
    ethnicities = ("east asian", "south asian", "white", "black", "latino")
    found_ethnicities = {
        value
        for value in ethnicities
        if re.search(
            rf"(?<![a-z]){re.escape(value)}(?![a-z])(?:\s+[a-z-]+){{0,2}}\s+(?:adult|man|woman|male|female|person)\b",
            normalized,
        )
    }
    if expected_ethnicity is not None:
        expected = expected_ethnicity.strip().casefold()
        if found_ethnicities != {expected}:
            violations.append(
                "positivePrompt appearance must match the selected ethnicity"
            )

    if expected_gender is not None:
        expected = expected_gender.strip().casefold()
        accepted = {"female": ("female", "woman"), "male": ("male", "man")}.get(
            expected, (expected,)
        )
        opposite = ("male", "man") if expected == "female" else ("female", "woman")
        has_expected = any(
            re.search(rf"(?<![a-z]){term}(?![a-z])", normalized) for term in accepted
        )
        has_opposite = any(
            re.search(rf"(?<![a-z]){term}(?![a-z])", normalized) for term in opposite
        )
        if not has_expected or has_opposite:
            violations.append(
                "positivePrompt appearance must match the selected gender"
            )
