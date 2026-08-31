from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.domain.enums import (
    Ethnicity,
    Gender,
    Language,
    default_language_for,
    validate_language,
)
from backend.domain.schemas import BatchDraftCreate, DemographicInput
from backend.services.prompts import _validate_spoken_text_component


def test_default_language_follows_ethnicity() -> None:
    assert DemographicInput(
        age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.EAST_ASIAN
    ).language is Language.ZH
    assert DemographicInput(
        age=45, gender=Gender.MALE, ethnicity=Ethnicity.WHITE
    ).language is Language.EN
    assert DemographicInput(
        age=60, gender=Gender.FEMALE, ethnicity=Ethnicity.LATINO
    ).language is Language.EN


def test_language_must_match_population() -> None:
    with pytest.raises(ValidationError, match="not enabled for this population"):
        DemographicInput(
            age=25,
            gender=Gender.MALE,
            ethnicity=Ethnicity.WHITE,
            language=Language.ZH,
        )
    with pytest.raises(ValidationError, match="not enabled for this population"):
        DemographicInput(
            age=25,
            gender=Gender.MALE,
            ethnicity=Ethnicity.EAST_ASIAN,
            language=Language.JA,
        )
    assert not validate_language(Ethnicity.BLACK, Language.DE)
    assert default_language_for(Ethnicity.SOUTH_ASIAN) is Language.EN


def _draft_payload(demographics: list[DemographicInput]) -> dict:
    return {
        "targetDatasetId": 1,
        "category": "A-VA",
        "conflictDirection": None,
        "model": "LTX-2.5",
        "precision": "BF16",
        "contentSelections": [{"contentScriptId": 1, "sceneIds": []}],
        "promptTemplateVersionId": 1,
        "demographics": [value.model_dump(by_alias=True) for value in demographics],
        "gpuSlots": ["GPU0"],
        "seeds": [1],
    }


def test_batch_draft_requires_a_single_language() -> None:
    mixed = [
        DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.EAST_ASIAN),
        DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.WHITE),
    ]
    with pytest.raises(ValidationError, match="single spoken language"):
        BatchDraftCreate.model_validate(_draft_payload(mixed))
    uniform = [
        DemographicInput(age=25, gender=Gender.FEMALE, ethnicity=Ethnicity.WHITE),
        DemographicInput(age=45, gender=Gender.MALE, ethnicity=Ethnicity.BLACK),
    ]
    draft = BatchDraftCreate.model_validate(_draft_payload(uniform))
    assert {value.language for value in draft.demographics} == {Language.EN}


def test_english_spoken_text_component_rules() -> None:
    line = "I got laid off today and I am fine"
    assert _validate_spoken_text_component(line, Language.EN) == line
    with pytest.raises(ValueError, match="quote marks"):
        _validate_spoken_text_component("I don't mind at all", Language.EN)
    with pytest.raises(ValueError, match="ASCII"):
        _validate_spoken_text_component("I am fine 真的", Language.EN)
    with pytest.raises(ValueError, match="2 to 14 English words"):
        _validate_spoken_text_component("fine", Language.EN)
    with pytest.raises(ValueError, match="natural Chinese"):
        _validate_spoken_text_component("I am fine today", Language.ZH)
