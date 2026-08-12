from __future__ import annotations

import os
from typing import Protocol

import httpx


PROMPT_MODEL = "deepseek-v4-flash"


class PromptAdapterError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class PromptModel(Protocol):
    configured: bool

    async def generate(self, system_input: str, user_input: str) -> str: ...

    async def close(self) -> None: ...


class UnconfiguredPromptModel:
    configured = False

    async def generate(self, system_input: str, user_input: str) -> str:
        raise PromptAdapterError(
            "external_configuration_missing",
            "Prompt generation requires CONFLICTSTUDIO_LLM_ENDPOINT and CONFLICTSTUDIO_LLM_API_KEY",
        )

    async def close(self) -> None:
        return None


class OpenAICompatiblePromptModel:
    configured = True

    def __init__(self, endpoint: str, api_key: str, client: httpx.AsyncClient | None = None) -> None:
        if not endpoint.strip() or not api_key.strip():
            raise ValueError("Prompt service endpoint and API key are required")
        self.endpoint = endpoint
        self.api_key = api_key
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(120.0))
        self._owns_client = client is None

    @classmethod
    def from_environment(cls) -> PromptModel:
        endpoint = os.environ.get("CONFLICTSTUDIO_LLM_ENDPOINT", "").strip()
        api_key = os.environ.get("CONFLICTSTUDIO_LLM_API_KEY", "").strip()
        if not endpoint or not api_key:
            return UnconfiguredPromptModel()
        return cls(endpoint, api_key)

    async def generate(self, system_input: str, user_input: str) -> str:
        try:
            response = await self.client.post(
                self.endpoint,
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": PROMPT_MODEL,
                    "messages": [
                        {"role": "system", "content": system_input},
                        {"role": "user", "content": user_input},
                    ],
                    "response_format": {"type": "json_object"},
                    "temperature": 0.2,
                },
            )
            response.raise_for_status()
            body = response.json()
            content = body["choices"][0]["message"]["content"]
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as error:
            raise PromptAdapterError("prompt_service_failed", "The prompt service request failed") from error
        if not isinstance(content, str) or not content.strip():
            raise PromptAdapterError("prompt_service_failed", "The prompt service returned an empty response")
        return content

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
