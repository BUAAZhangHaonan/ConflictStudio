from __future__ import annotations

import json
import re
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from pydantic import ValidationError

from backend.adapters.database import Database
from backend.adapters.llm import PromptAdapterError, PromptModel
from backend.domain.enums import Category
from backend.domain.schemas import (
    ContentScriptCreate,
    PromptTemplateRead,
    PromptTemplateVersionCreate,
    ResourceAssistantApply,
    ResourceAssistantApplyRead,
    ResourceAssistantBundle,
    ResourceAssistantProposalRead,
    ResourceAssistantPropose,
    SceneCreate,
)

from .catalog import CatalogService
from .errors import ServiceError, invalid_request, revision_conflict
from .prompts import DuplicatePromptKeyError, _load_unique_json


URI_SCHEME_PATTERN = re.compile(
    r"(?i)(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9+.-]{0,31}):\S"
)
WWW_ADDRESS_PATTERN = re.compile(r"(?i)(?<![A-Za-z0-9])www\.")
INTERPRETER_COMMAND_PATTERN = re.compile(
    r"(?i)(?:^|[\s;&|])"
    r"(?:python(?:\d+(?:\.\d+)?)?|py|sh|bash|dash|zsh|ksh|fish|"
    r"pwsh|powershell|cmd(?:\.exe)?|node|deno|bun|perl|ruby|php|lua)"
    r"\s+(?:-[A-Za-z]*[ce]\b|/c\b)"
)
COMMAND_CONTROL_PATTERN = re.compile(
    r"&&|\|\||;|\$\(|\x60|(?<!\w)\d*>>?(?!\w)|(?<!\w)<<?(?!\w)|\|"
)
REQUEST_PATH_PATTERN = re.compile(
    r"(?i)(?:\b(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/|"
    r"(?:^|\s)/(?:[A-Za-z0-9._~-]+/)+[A-Za-z0-9._~/?=&%-]*)"
)


class ResourceAssistantService:
    def __init__(
        self,
        database: Database,
        model: PromptModel,
        catalog: CatalogService,
    ) -> None:
        self.database = database
        self.model = model
        self.catalog = catalog
        template_root = Path(__file__).with_name("templates")
        environment = Environment(
            loader=FileSystemLoader(template_root),
            undefined=StrictUndefined,
            autoescape=False,
            keep_trailing_newline=False,
        )
        self.system_template = environment.get_template(
            "resource_assistant_system.j2"
        )
        self.user_template = environment.get_template(
            "resource_assistant_user.j2"
        )

    async def propose(
        self,
        payload: ResourceAssistantPropose,
    ) -> ResourceAssistantProposalRead:
        target = self._read_target(
            payload.prompt_template.id,
            payload.prompt_template.expected_revision,
        )
        try:
            response = await self.model.generate(
                self.system_template.render().strip(),
                self.user_template.render(
                    user_requirement=payload.user_requirement,
                    prompt_template_json=target.model_dump_json(by_alias=True),
                ).strip(),
            )
        except PromptAdapterError as error:
            status_code = (
                503
                if error.code == "external_configuration_missing"
                else 502
            )
            raise ServiceError(
                status_code,
                error.code,
                error.message,
                error.details,
            ) from error

        bundle = self._parse_bundle(response.content)
        self._validate_safe_bundle(bundle)
        current_target = self._read_target(
            payload.prompt_template.id,
            payload.prompt_template.expected_revision,
        )
        if bundle.content_script.category is not current_target.category:
            raise ServiceError(
                502,
                "invalid_prompt_schema",
                "The resource assistant content category does not match the prompt template",
            )
        return ResourceAssistantProposalRead(
            prompt_template=current_target,
            bundle=bundle,
        )

    def apply(
        self,
        payload: ResourceAssistantApply,
    ) -> ResourceAssistantApplyRead:
        with self.database.immediate_session() as session:
            target = self.catalog.get_prompt_template_in_session(
                session,
                payload.prompt_template.id,
                payload.prompt_template.expected_revision,
            )
            self._validate_bundle_target(payload.bundle, target.category)
            scenes = [
                self.catalog.create_draft_scene_in_session(
                    session,
                    SceneCreate.model_validate(scene.model_dump()),
                )
                for scene in payload.bundle.scenes
            ]
            content = self.catalog.create_draft_content_in_session(
                session,
                ContentScriptCreate.model_validate(
                    {
                        **payload.bundle.content_script.model_dump(),
                        "scene_ids": [scene.id for scene in scenes],
                    }
                ),
            )
            version = self.catalog.create_prompt_template_version_in_session(
                session,
                payload.prompt_template.id,
                PromptTemplateVersionCreate.model_validate(
                    {
                        **payload.bundle.prompt_template_version.model_dump(),
                        "expected_template_revision": (
                            payload.prompt_template.expected_revision
                        ),
                    }
                ),
            )
            return ResourceAssistantApplyRead(
                content_script=content,
                scenes=scenes,
                prompt_template_version=version,
            )

    def _read_target(
        self,
        template_id: int,
        expected_revision: int,
    ) -> PromptTemplateRead:
        target = self.catalog.get_prompt_template(template_id)
        if target.revision != expected_revision:
            raise revision_conflict(
                "promptTemplate",
                template_id,
                expected_revision,
                target.revision,
            )
        return target

    @staticmethod
    def _validate_bundle_target(
        bundle: ResourceAssistantBundle,
        category: Category,
    ) -> None:
        if bundle.content_script.category is not category:
            raise invalid_request(
                "The proposed content category must match the prompt template"
            )

    @staticmethod
    def _parse_bundle(raw: str) -> ResourceAssistantBundle:
        try:
            payload = _load_unique_json(raw)
        except DuplicatePromptKeyError as error:
            raise ServiceError(
                502,
                "duplicate_prompt_key",
                "The resource assistant returned JSON with a duplicate key",
            ) from error
        except json.JSONDecodeError as error:
            raise ServiceError(
                502,
                "invalid_prompt_json",
                "The resource assistant returned invalid JSON",
            ) from error
        try:
            return ResourceAssistantBundle.model_validate(payload)
        except ValidationError as error:
            fields = [
                {
                    "path": ".".join(str(part) for part in item["loc"]),
                    "type": str(item["type"]),
                    "reason": item["msg"],
                }
                for item in error.errors()
            ]
            raise ServiceError(
                502,
                "invalid_prompt_schema",
                "The resource assistant response does not match the required structure",
                {"fields": fields},
            ) from error

    @staticmethod
    def _validate_safe_bundle(bundle: ResourceAssistantBundle) -> None:
        payload = bundle.model_dump(mode="json", by_alias=True)
        for value in ResourceAssistantService._text_values(payload):
            if any(
                pattern.search(value)
                for pattern in (
                    URI_SCHEME_PATTERN,
                    WWW_ADDRESS_PATTERN,
                    INTERPRETER_COMMAND_PATTERN,
                    COMMAND_CONTROL_PATTERN,
                    REQUEST_PATH_PATTERN,
                )
            ):
                raise ServiceError(
                    502,
                    "invalid_prompt_schema",
                    "The resource assistant returned executable or linked text",
                )

    @staticmethod
    def _text_values(value: object):  # type: ignore[no-untyped-def]
        if isinstance(value, str):
            yield value
        elif isinstance(value, dict):
            for nested in value.values():
                yield from ResourceAssistantService._text_values(nested)
        elif isinstance(value, list):
            for nested in value:
                yield from ResourceAssistantService._text_values(nested)
