from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .enums import Category, ConflictDirection


POLICY_VERSION = "2026-08-12.3"


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
            "Write the short Mandarin dialogue in spokenText. The application stores it as VA dialogue and "
            "inserts it once in the render prompt."
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
            "Write the short Mandarin text in spokenText. The application stores it as independent VT text and "
            "uses the same words as source-video speech before removing the audio."
        ),
    ),
    Category.C_VA: CategoryPolicy(
        category=Category.C_VA,
        protocol_rule="The visible behavior intentionally disagrees with the Mandarin words and vocal delivery.",
        relation_rule="Follow the selected direction exactly and keep the disagreement readable throughout the clip.",
        output_rule=(
            "Write the short Mandarin dialogue in spokenText. The application stores it as VA dialogue and "
            "inserts it once in the render prompt."
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
            "Write the short Mandarin text in spokenText. The application stores it as independent VT text and "
            "uses the same words as source-video speech before removing the audio."
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
    "clearly",
    "obviously",
    "definitely",
    "unmistakably",
    "undeniably",
    "evidently",
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

BACKGROUND_DATABASE_FORBIDDEN_PHRASES: tuple[str, ...] = tuple(
    dict.fromkeys(
        (
            *FORBIDDEN_BACKGROUND_PERSON_PHRASES,
            *FORBIDDEN_MUSIC_PHRASES,
            *BANNED_EMOTION_LABELS,
            *FORBIDDEN_INTERNAL_PHRASES,
            *FORBIDDEN_BACKGROUND_PROTOCOL_PHRASES,
        )
    )
)

_PAST_TENSE_MARKERS: tuple[str, ...] = (
    "was",
    "were",
    "had",
    "did",
    "went",
    "said",
    "told",
    "spoke",
    "came",
    "gave",
    "took",
    "made",
    "got",
    "saw",
    "knew",
    "felt",
    "sat",
    "stood",
    "turned",
    "smiled",
    "cried",
    "laughed",
    "walked",
    "talked",
    "looked",
    "started",
    "began",
    "stopped",
    "ran",
    "fell",
    "arranged",
)

_ENGLISH_WORD_RE = re.compile(r"\b[A-Za-z]+(?:[-'][A-Za-z]+)*\b")
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_BULLET_RE = re.compile(r"(?:^|\s)(?:[-*\u2022]|\d+\.)\s")
_QUOTED_TEXT_RE = re.compile(r'"([^"\r\n]+)"')

_APPEARANCE_PATTERNS: tuple[str, ...] = (
    r"\b(?:adult|man|woman|male|female|person|subject)\b",
    r"\b\d{2}-year-old\b",
    r"\b(?:east asian|south asian|white|black|latino)\b",
    r"\b(?:hair|skin|face|eyes|jacket|shirt|blouse|dress|sweater|coat|clothing|wears|wearing)\b",
)
_ACTION_PATTERNS: tuple[str, ...] = (
    r"\b(?:sits|stands|walks|turns|raises|lowers|holds|rests|leans|folds|grips|moves|glances|blinks|nods)\b",
    r"\b(?:presses|tightens|shifts|lifts|keeps|places|taps|reaches|draws|tilts|straightens|clasps)\b",
)
_SPEECH_PATTERNS: tuple[str, ...] = (
    r"\b(?:says|speaks|whispers|murmurs|utters|asks|replies|answers)\b",
    r"\b(?:voice|speech|spoken phrase|spoken line)\b",
)
_ENVIRONMENTAL_SOUND_PATTERNS: tuple[str, ...] = (
    r"\bambient (?:sound|noise)\b",
    r"\broom tone\b",
    r"\bventilation\b",
    r"\b(?:hum|hums|humming|buzz|buzzes|buzzing|rustle|rustles|rustling)\b",
    r"\b(?:rain|wind|traffic|airflow|thunder|waves|birds|insects)\b",
    r"\b(?:fan|clock|printer|machine|engine|air conditioner)\b.*\b(?:ticks|hums|buzzes|runs|whirs|rattles)\b",
    r"\b(?:ticking|clatter|whir|whirring|creak|creaking|drip|dripping)\b",
)
_SETTING_PATTERNS: tuple[str, ...] = (
    r"\b(?:room|office|kitchen|hallway|cafe|caf\u00e9|station|interior|exterior|street|studio|lobby)\b",
    r"\b(?:apartment|house|library|classroom|workshop|platform|corridor|restaurant|bedroom)\b",
    r"\b(?:walls|window|doorway|background|surroundings|location|setting)\b",
)
_CAMERA_PATTERNS: tuple[str, ...] = (
    r"\b(?:camera|shot|frame|framed|framing|lens|close-up|push-in|dolly|handheld)\b",
    r"\b(?:medium|wide|static|eye-level|tracking) shot\b",
)
_LIGHTING_PATTERNS: tuple[str, ...] = (
    r"\b(?:light|lights|lighting|daylight|sunlight|shadow|shadows|glow|illumination|highlight|highlights)\b",
    r"\b(?:lit|backlit|side-lit)\b",
)


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
    quoted_values = _QUOTED_TEXT_RE.findall(prompt)
    if prompt.count('"') != 2 or quoted_values != [spoken_text]:
        violations.append("positivePrompt must contain the exact short spoken text once in straight double quotes")

    narrative = prompt.replace(quoted_spoken_text, "", 1) if quoted_spoken_text else prompt
    structural_text = (
        prompt.replace(quoted_spoken_text, " " * len(quoted_spoken_text), 1)
        if quoted_spoken_text
        else prompt
    )
    word_count = len(_ENGLISH_WORD_RE.findall(narrative))
    if not 80 <= word_count <= 150:
        violations.append(f"positivePrompt must contain 80 to 150 English words; found {word_count}")
    if _CJK_RE.search(narrative):
        violations.append("positivePrompt narrative must be English outside the quoted Mandarin speech")

    banned_emotions = list(BANNED_EMOTION_LABELS)
    banned_emotions.extend(value for value in (true_emotion, apparent_emotion) if value.strip())
    _append_phrase_violation(violations, prompt, banned_emotions, "emotion labels")
    _append_phrase_violation(violations, prompt, BANNED_CERTAINTY_MODIFIERS, "certainty claims")
    _append_phrase_violation(violations, prompt, FORBIDDEN_MUSIC_PHRASES, "music or score terms")
    _append_phrase_violation(violations, prompt, FORBIDDEN_INTERNAL_PHRASES, "internal category or protocol names")
    _append_phrase_violation(
        violations,
        prompt,
        FORBIDDEN_RENDERED_TEXT_PHRASES,
        "subtitles, captions or rendered text",
    )

    first_sentence = re.split(r"(?<=[.!?])\s+", narrative, maxsplit=1)[0]
    appearance_position = _first_pattern_position(structural_text, _APPEARANCE_PATTERNS)
    if appearance_position is None or _first_pattern_position(first_sentence, _APPEARANCE_PATTERNS) is None:
        violations.append("positivePrompt must open with one person's appearance")
    _append_phrase_violation(
        violations,
        narrative,
        FORBIDDEN_MULTI_SUBJECT_PHRASES,
        "multiple on-screen people",
    )
    if re.search(r"\b(?:another|second)\s+(?:person|adult|man|woman|character)\b", narrative, re.IGNORECASE):
        violations.append("positivePrompt must contain exactly one on-screen person")
    if re.search(r"\b(?:three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:[a-z]+\s+){0,2}(?:adults|people|persons|men|women|characters)\b", narrative, re.IGNORECASE):
        violations.append("positivePrompt must contain exactly one on-screen person")
    if re.search(r"\b(?:man|woman|adult|person)\b[^.!?]{0,80}\band\b[^.!?]{0,80}\b(?:man|woman|adult|person)\b", narrative, re.IGNORECASE):
        violations.append("positivePrompt must contain exactly one on-screen person")
    _validate_expected_demographic(narrative, expected_ethnicity, expected_gender, violations)
    if expected_age is not None and not re.search(rf"\b{expected_age}-year-old\b", narrative, re.IGNORECASE):
        violations.append("positivePrompt appearance must match the selected age")

    action_position = _first_pattern_position(structural_text, _ACTION_PATTERNS)
    speech_position = _first_pattern_position(prompt, _SPEECH_PATTERNS)
    sound_position = _first_pattern_position(prompt, _ENVIRONMENTAL_SOUND_PATTERNS)
    quote_position = prompt.find(quoted_spoken_text) if quoted_spoken_text else -1
    setting_text = _mask_pattern_matches(structural_text, _ENVIRONMENTAL_SOUND_PATTERNS)
    setting_position = _first_pattern_position(setting_text, _SETTING_PATTERNS)
    camera_position = _first_pattern_position(structural_text, _CAMERA_PATTERNS)
    lighting_position = _first_pattern_position(structural_text, _LIGHTING_PATTERNS)

    required_positions = {
        "appearance": appearance_position,
        "body action": action_position,
        "speech cue": speech_position,
        "environmental sound": sound_position,
        "setting": setting_position,
        "camera": camera_position,
        "lighting": lighting_position,
    }
    for label, position in required_positions.items():
        if position is None:
            violations.append(f"positivePrompt must include concrete {label} substance")

    if quote_position < 0:
        audio_position = None
    else:
        audio_values = [position for position in (speech_position, sound_position, quote_position) if position is not None]
        audio_position = max(audio_values) if len(audio_values) == 3 else None
    ordered_positions = (
        appearance_position,
        action_position,
        audio_position,
        setting_position,
        camera_position,
        lighting_position,
    )
    if all(position is not None for position in ordered_positions):
        numeric_positions = tuple(int(position) for position in ordered_positions if position is not None)
        if any(left >= right for left, right in zip(numeric_positions, numeric_positions[1:])):
            violations.append(
                "positivePrompt substance must follow appearance, body action, audio, setting, camera, lighting order"
            )

    prompt_without_quote = prompt.replace(quoted_spoken_text, "", 1) if quoted_spoken_text else prompt
    past_markers = _find_phrases(prompt_without_quote, _PAST_TENSE_MARKERS)
    if past_markers:
        violations.append(f"positivePrompt must use present tense; found: {', '.join(past_markers)}")

    if violations:
        raise PromptPolicyViolation(violations)


def validate_background_policy_text(value: str, field_name: str = "background") -> str:
    """Validate one background-preset text field and return it unchanged."""

    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    violations: list[str] = []
    _append_phrase_violation(violations, value, FORBIDDEN_BACKGROUND_PERSON_PHRASES, "another person")
    _append_phrase_violation(violations, value, FORBIDDEN_MUSIC_PHRASES, "music or score terms")
    _append_phrase_violation(violations, value, BANNED_EMOTION_LABELS, "emotion labels")
    _append_phrase_violation(violations, value, FORBIDDEN_INTERNAL_PHRASES, "internal category or protocol names")
    _append_phrase_violation(violations, value, FORBIDDEN_BACKGROUND_PROTOCOL_PHRASES, "protocol conflicts")
    if violations:
        raise PromptPolicyViolation(tuple(f"{field_name}: {violation}" for violation in violations))
    return value


def validate_background_policy_fields(values: Mapping[str, str]) -> None:
    for field_name, value in values.items():
        validate_background_policy_text(value, field_name)


def _validate_spoken_text(spoken_text: str, violations: list[str]) -> str:
    if not spoken_text.strip():
        violations.append("spoken text must not be blank")
        return ""
    if spoken_text != spoken_text.strip() or "\n" in spoken_text or "\r" in spoken_text:
        violations.append("spoken text must not contain surrounding whitespace or line breaks")
    if any(mark in spoken_text for mark in ('"', "\u201c", "\u201d")):
        violations.append("spoken text must not contain quote marks")
    han_count = sum(1 for character in spoken_text if _CJK_RE.fullmatch(character))
    other_alphanumeric_count = sum(
        1
        for character in spoken_text
        if character.isalnum() and not _CJK_RE.fullmatch(character)
    )
    if han_count < 2 or han_count <= other_alphanumeric_count:
        violations.append("spoken text must be predominantly Chinese and contain at least two Chinese characters")
    if not 2 <= len(spoken_text) <= 40:
        violations.append("spoken text must contain 2 to 40 characters")
    return f'"{spoken_text}"'


def _append_phrase_violation(
    violations: list[str],
    text: str,
    phrases: Sequence[str],
    label: str,
) -> None:
    found = _find_phrases(text, phrases)
    if found:
        violations.append(f"positivePrompt must not contain {label}: {', '.join(found)}")


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
            violations.append("positivePrompt appearance must match the selected ethnicity")

    if expected_gender is not None:
        expected = expected_gender.strip().casefold()
        accepted = {"female": ("female", "woman"), "male": ("male", "man")}.get(expected, (expected,))
        opposite = ("male", "man") if expected == "female" else ("female", "woman")
        has_expected = any(re.search(rf"(?<![a-z]){term}(?![a-z])", normalized) for term in accepted)
        has_opposite = any(re.search(rf"(?<![a-z]){term}(?![a-z])", normalized) for term in opposite)
        if not has_expected or has_opposite:
            violations.append("positivePrompt appearance must match the selected gender")


def _first_pattern_position(text: str, patterns: Sequence[str]) -> int | None:
    positions = [match.start() for pattern in patterns if (match := re.search(pattern, text, re.IGNORECASE))]
    return min(positions) if positions else None


def _mask_pattern_matches(text: str, patterns: Sequence[str]) -> str:
    characters = list(text)
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            characters[match.start() : match.end()] = " " * (match.end() - match.start())
    return "".join(characters)
