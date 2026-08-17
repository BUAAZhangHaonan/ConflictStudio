from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func
from sqlmodel import Session, select

from backend.adapters.database import Database
from backend.domain.enums import (
    Category,
    ContentMode,
    ContentStatus,
    ResourceStatus,
    TemplateVersionStatus,
)
from backend.domain.models import (
    ContentScript,
    ContentScriptScene,
    PromptTemplate,
    PromptTemplateExample,
    PromptTemplateVersion,
    Scene,
    utc_now,
)
from backend.domain.schemas import (
    ContentScriptFields,
    PromptTemplateCreate,
    PromptTemplateVersionFields,
    SceneFields,
)


DEFAULT_CATALOG_SEED = (
    Path(__file__).resolve().parents[1] / "resources" / "catalog" / "default.json"
)
EXPECTED_COUNTS = {
    "contentScripts": 104,
    "scenes": 75,
    "contentScriptScenes": 75,
    "promptTemplates": 4,
    "promptTemplateVersions": 4,
    "promptTemplateExamples": 0,
}
EXPECTED_CONTENT_STATUSES = {
    ContentStatus.ACTIVE: 8,
    ContentStatus.DRAFT: 94,
    ContentStatus.DISABLED: 2,
}


class CatalogSeedError(RuntimeError):
    pass


class SeedModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class EvidenceReference(SeedModel):
    source_id: str | None = Field(default=None, alias="sourceId")
    file: str
    line: int | None = Field(default=None, ge=1)
    line_end: int | None = Field(default=None, alias="lineEnd", ge=1)
    json_path: str | None = Field(default=None, alias="jsonPath")

    @field_validator("file")
    @classmethod
    def require_relative_evidence_path(cls, value: str) -> str:
        path = Path(value)
        if path.is_absolute() or ".." in path.parts or not value.strip():
            raise ValueError("Evidence paths must be nonempty relative paths")
        return value


class ContentScriptSeed(SeedModel):
    key: str = Field(min_length=1)
    source: EvidenceReference
    record: ContentScriptFields

    @model_validator(mode="after")
    def require_source_identity(self) -> Self:
        if self.source.source_id != self.key:
            raise ValueError("Content source identity must match its seed key")
        return self


class SceneSeed(SeedModel):
    key: str = Field(min_length=1)
    source_references: list[EvidenceReference] = Field(
        alias="sourceReferences",
        min_length=1,
    )
    record: SceneFields


class ContentScriptSceneSeed(SeedModel):
    content_script_key: str = Field(alias="contentScriptKey", min_length=1)
    scene_key: str = Field(alias="sceneKey", min_length=1)
    position: int = Field(ge=0)


class PromptTemplateSeed(SeedModel):
    key: str = Field(min_length=1)
    source: EvidenceReference
    record: PromptTemplateCreate


class ModelNegativeEvidence(SeedModel):
    ltx: EvidenceReference
    h3: EvidenceReference


class PromptTemplateVersionSeed(SeedModel):
    template_key: str = Field(alias="templateKey", min_length=1)
    version: int = Field(ge=1)
    verification_status: TemplateVersionStatus = Field(alias="verificationStatus")
    record: PromptTemplateVersionFields
    negative_prompt_evidence: ModelNegativeEvidence = Field(
        alias="negativePromptEvidence"
    )


class CatalogSeed(SeedModel):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    evidence: dict[str, str]
    content_scripts: list[ContentScriptSeed] = Field(alias="contentScripts")
    scenes: list[SceneSeed]
    content_script_scenes: list[ContentScriptSceneSeed] = Field(
        alias="contentScriptScenes"
    )
    prompt_templates: list[PromptTemplateSeed] = Field(alias="promptTemplates")
    prompt_template_versions: list[PromptTemplateVersionSeed] = Field(
        alias="promptTemplateVersions"
    )
    prompt_template_examples: list[dict[str, object]] = Field(
        alias="promptTemplateExamples"
    )

    @model_validator(mode="after")
    def validate_approved_catalog(self) -> Self:
        actual_counts = {
            "contentScripts": len(self.content_scripts),
            "scenes": len(self.scenes),
            "contentScriptScenes": len(self.content_script_scenes),
            "promptTemplates": len(self.prompt_templates),
            "promptTemplateVersions": len(self.prompt_template_versions),
            "promptTemplateExamples": len(self.prompt_template_examples),
        }
        if actual_counts != EXPECTED_COUNTS:
            raise ValueError(f"Catalog seed counts do not match approval: {actual_counts}")

        content_keys = [row.key for row in self.content_scripts]
        scene_keys = [row.key for row in self.scenes]
        template_keys = [row.key for row in self.prompt_templates]
        for label, keys in (
            ("content", content_keys),
            ("scene", scene_keys),
            ("template", template_keys),
        ):
            if len(keys) != len(set(keys)):
                raise ValueError(f"Duplicate {label} seed key")

        if Counter(row.record.status for row in self.content_scripts) != Counter(
            EXPECTED_CONTENT_STATUSES
        ):
            raise ValueError("Content status distribution does not match approval")
        if any(row.record.status is not ResourceStatus.ACTIVE for row in self.scenes):
            raise ValueError("Every approved scene must start active")
        if {row.record.category for row in self.prompt_templates} != set(Category):
            raise ValueError("The seed requires one prompt template per category")
        if len({row.record.category for row in self.prompt_templates}) != 4:
            raise ValueError("Prompt template categories must be unique")

        content_key_set = set(content_keys)
        scene_key_set = set(scene_keys)
        template_key_set = set(template_keys)
        expected_links = {
            (reference.source_id, scene.key, 0)
            for scene in self.scenes
            for reference in scene.source_references
        }
        actual_links = {
            (link.content_script_key, link.scene_key, link.position)
            for link in self.content_script_scenes
        }
        if actual_links != expected_links:
            raise ValueError("Content and scene links must match source evidence")
        if any(
            link.content_script_key not in content_key_set
            or link.scene_key not in scene_key_set
            for link in self.content_script_scenes
        ):
            raise ValueError("Content and scene links must reference seed records")

        link_counts = Counter(
            link.content_script_key for link in self.content_script_scenes
        )
        for content in self.content_scripts:
            count = link_counts[content.key]
            if content.record.mode is ContentMode.FIXED and count != 1:
                raise ValueError("Every fixed content script requires exactly one scene")
            if (
                content.record.mode is ContentMode.GENERATIVE
                and content.record.status is ContentStatus.ACTIVE
                and count < 1
            ):
                raise ValueError("Every active generated script requires a scene")

        if len(self.prompt_template_versions) != len(template_key_set):
            raise ValueError("Each prompt template requires one initial version")
        if {
            version.template_key for version in self.prompt_template_versions
        } != template_key_set:
            raise ValueError("Prompt template versions must cover every template")
        if any(
            version.version != 1
            or version.verification_status is not TemplateVersionStatus.VERIFIED
            or version.record.positive_examples
            or version.record.negative_examples
            for version in self.prompt_template_versions
        ):
            raise ValueError("Initial template versions must be verified without examples")
        return self


def load_default_catalog_seed() -> CatalogSeed:
    return CatalogSeed.model_validate_json(DEFAULT_CATALOG_SEED.read_text())


class CatalogSeedInitializer:
    _catalog_models = (
        ContentScript,
        Scene,
        ContentScriptScene,
        PromptTemplate,
        PromptTemplateVersion,
        PromptTemplateExample,
    )

    def __init__(self, database: Database) -> None:
        self.database = database

    def initialize(self, seed: CatalogSeed | None = None) -> dict[str, int]:
        resolved_seed = seed or load_default_catalog_seed()
        with self.database.immediate_session() as session:
            self._require_empty_catalog(session)
            self._insert_catalog(session, resolved_seed)
        return dict(EXPECTED_COUNTS)

    def _require_empty_catalog(self, session: Session) -> None:
        occupied = {
            model.__tablename__: session.exec(
                select(func.count()).select_from(model)
            ).one()
            for model in self._catalog_models
        }
        occupied = {name: count for name, count in occupied.items() if count}
        if occupied:
            raise CatalogSeedError(
                f"Catalog initialization requires empty catalog tables: {occupied}"
            )

    @staticmethod
    def _insert_catalog(session: Session, seed: CatalogSeed) -> None:
        timestamp = utc_now()
        scenes: dict[str, Scene] = {}
        for item in seed.scenes:
            values = item.record.model_dump()
            row = Scene(
                **values,
                name_zh_key=_name_key(item.record.name_zh),
                name_en_key=_name_key(item.record.name_en),
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(row)
            scenes[item.key] = row
        session.flush()

        contents: dict[str, ContentScript] = {}
        desired_statuses: dict[str, ContentStatus] = {}
        for item in seed.content_scripts:
            values = item.record.model_dump()
            desired_statuses[item.key] = values.pop("status")
            row = ContentScript(
                **values,
                status=ContentStatus.DRAFT,
                name_zh_key=_name_key(item.record.name_zh),
                name_en_key=_name_key(item.record.name_en),
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(row)
            contents[item.key] = row
        session.flush()

        for item in seed.content_script_scenes:
            content = contents[item.content_script_key]
            scene = scenes[item.scene_key]
            session.add(
                ContentScriptScene(
                    content_script_id=_required_id(content),
                    scene_id=_required_id(scene),
                    position=item.position,
                )
            )
        session.flush()
        for key, row in contents.items():
            row.status = desired_statuses[key]
            row.updated_at = timestamp
        session.flush()

        templates: dict[str, PromptTemplate] = {}
        for item in seed.prompt_templates:
            row = PromptTemplate(
                name=item.record.name,
                name_key=_name_key(item.record.name),
                category=item.record.category,
                created_at=timestamp,
                updated_at=timestamp,
            )
            session.add(row)
            templates[item.key] = row
        session.flush()

        for item in seed.prompt_template_versions:
            template = templates[item.template_key]
            session.add(
                PromptTemplateVersion(
                    template_id=_required_id(template),
                    version=item.version,
                    organization_instruction=item.record.organization_instruction,
                    style_instruction=item.record.style_instruction,
                    ltx_negative_prompt=item.record.ltx_negative_prompt,
                    h3_negative_prompt=item.record.h3_negative_prompt,
                    verification_status=item.verification_status,
                    created_at=timestamp,
                    verified_at=timestamp,
                )
            )
        session.flush()


def _name_key(value: str) -> str:
    return value.strip().casefold()


def _required_id(row: ContentScript | Scene | PromptTemplate) -> int:
    if row.id is None:
        raise CatalogSeedError("Catalog row did not receive an identifier")
    return row.id
