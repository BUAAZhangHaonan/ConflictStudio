from __future__ import annotations

import re
from typing import Annotated

from pydantic import AfterValidator
from pydantic_core import PydanticCustomError


DISPLAY_NAME_ERROR_CODE = "invalid_display_name"
DISPLAY_NAME_ERROR_MESSAGE = (
    "Enter an English display name of 1 to 60 characters using words, spaces, and common punctuation. "
    "Do not use internal import labels, slugs, statuses, or version tags."
)

_ALLOWED_DISPLAY_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 .,&'\u2019()+:/#!?\-–—]*")
_IMPORT_LABEL_RE = re.compile(r"(?:scenario|yaml|prototype)-", re.IGNORECASE)
_BACKGROUND_LABEL_RE = re.compile(r"background-\d+(?:$|\s)", re.IGNORECASE)
_VERSION_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])v\d+(?:\.\d+)*(?![A-Za-z0-9])", re.IGNORECASE)
_INTERNAL_ENUM_NAMES = frozenset(
    {
        "accepted",
        "active",
        "cancelled",
        "completed",
        "disabled",
        "draft",
        "failed",
        "inactive",
        "pending",
        "queued",
        "rejected",
        "running",
        "submitted",
    }
)


def validate_display_name(value: str) -> str:
    invalid = (
        not 1 <= len(value) <= 60
        or value != value.strip()
        or _ALLOWED_DISPLAY_NAME_RE.fullmatch(value) is None
        or _IMPORT_LABEL_RE.match(value) is not None
        or _BACKGROUND_LABEL_RE.match(value) is not None
        or _VERSION_TOKEN_RE.search(value) is not None
        or value.casefold() in _INTERNAL_ENUM_NAMES
    )
    if invalid:
        raise PydanticCustomError(DISPLAY_NAME_ERROR_CODE, DISPLAY_NAME_ERROR_MESSAGE)
    return value


EnglishDisplayName = Annotated[str, AfterValidator(validate_display_name)]
