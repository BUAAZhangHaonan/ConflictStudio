from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .enums import Category, ConflictDirection


POLICY_VERSION = "2026-08-12.2"


@dataclass(frozen=True)
class CategoryPolicy:
    category: Category
    protocol_rule: str
    relation_rule: str
    output_rule: str


POLICIES = {
    Category.A_VA: CategoryPolicy(
        category=Category.A_VA,
        protocol_rule="The visible behavior and the Mandarin speech, including vocal delivery, convey the same underlying state.",
        relation_rule="Keep visual and audio evidence aligned without naming an emotion label in the video description.",
        output_rule=(
            "Return a short Mandarin dialogue value and no VT text. The positive prompt must include that exact "
            'dialogue once inside straight English double quotes.'
        ),
    ),
    Category.A_VT: CategoryPolicy(
        category=Category.A_VT,
        protocol_rule=(
            "The visible behavior and the independently stored Mandarin VT text convey the same underlying state. "
            "The source video carries audible speech before its audio is removed for the silent primary derivative."
        ),
        relation_rule="Do not render text or subtitles in the video and do not name an emotion label.",
        output_rule=(
            "Return a short Mandarin VT text value and no dialogue value. The positive prompt must include that exact "
            "VT text once as audible speech inside straight English double quotes."
        ),
    ),
    Category.C_VA: CategoryPolicy(
        category=Category.C_VA,
        protocol_rule="The visible behavior and Mandarin speech intentionally disagree.",
        relation_rule="One modality carries the underlying state and the other carries the surface state.",
        output_rule=(
            "Return a short Mandarin dialogue value and no VT text. The positive prompt must include that exact "
            'dialogue once inside straight English double quotes.'
        ),
    ),
    Category.C_VT: CategoryPolicy(
        category=Category.C_VT,
        protocol_rule=(
            "The visible behavior and the independently stored Mandarin VT text intentionally disagree. "
            "The source video carries audible speech before its audio is removed for the silent primary derivative."
        ),
        relation_rule="Do not render the text in the video and keep the conflict in the requested direction.",
        output_rule=(
            "Return a short Mandarin VT text value and no dialogue value. The positive prompt must include that exact "
            "VT text once as audible speech inside straight English double quotes."
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
        return "There is no conflict direction because both modalities are aligned."
    labels = {
        ConflictDirection.VISION: "Visible behavior carries the underlying state; the other modality carries the surface state.",
        ConflictDirection.AUDIO: "Vocal delivery and speech carry the underlying state; visible behavior carries the surface state.",
        ConflictDirection.TEXT: "The separate text carries the underlying state; visible behavior carries the surface state.",
    }
    if direction is None:
        raise ValueError("Conflict content requires a direction")
    return labels[direction]


def validate_final_positive_prompt(
    prompt: str,
    *,
    spoken_text: str,
    true_emotion: str = "",
    apparent_emotion: str = "",
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
    if not _CJK_RE.search(spoken_text):
        violations.append("spoken text must contain a natural Chinese phrase")
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
        clean = phrase.strip()
        if not clean:
            continue
        pattern = rf"(?<![A-Za-z0-9_]){re.escape(clean)}(?![A-Za-z0-9_])"
        if re.search(pattern, text, re.IGNORECASE):
            found.append(clean)
    return list(dict.fromkeys(found))


def _first_pattern_position(text: str, patterns: Sequence[str]) -> int | None:
    positions = [match.start() for pattern in patterns if (match := re.search(pattern, text, re.IGNORECASE))]
    return min(positions) if positions else None


def _mask_pattern_matches(text: str, patterns: Sequence[str]) -> str:
    characters = list(text)
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            characters[match.start() : match.end()] = " " * (match.end() - match.start())
    return "".join(characters)
