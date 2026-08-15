from __future__ import annotations

import os
from typing import Any, Protocol

import httpx


PROMPT_ENDPOINT = "https://api.deepseek.com/v1/chat/completions"
PROMPT_MODEL = "deepseek-v4-flash"


class PromptAdapterError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class PromptModel(Protocol):
    configured: bool

    async def generate(self, system_input: str, user_input: str) -> str: ...

    async def close(self) -> None: ...


class UnconfiguredPromptModel:
    configured = False

    async def generate(self, system_input: str, user_input: str) -> str:
        raise PromptAdapterError(
            "external_configuration_missing",
            "Prompt generation requires CONFLICTSTUDIO_LLM_API_KEY",
        )

    async def close(self) -> None:
        return None


class OpenAICompatiblePromptModel:
    configured = True

    def __init__(self, api_key: str, client: httpx.AsyncClient | None = None) -> None:
        if not api_key.strip():
            raise ValueError("Prompt service API key is required")
        self.api_key = api_key
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(120.0))
        self._owns_client = client is None

    @classmethod
    def from_environment(cls) -> PromptModel:
        api_key = os.environ.get("CONFLICTSTUDIO_LLM_API_KEY", "").strip()
        if not api_key:
            return UnconfiguredPromptModel()
        return cls(api_key)

    async def generate(self, system_input: str, user_input: str) -> str:
        try:
            response = await self.client.post(
                PROMPT_ENDPOINT,
                headers={"Authorization": f"Bearer {self.api_key}"},
                json={
                    "model": PROMPT_MODEL,
                    "messages": [
                        {"role": "system", "content": system_input},
                        {"role": "user", "content": user_input},
                    ],
                    "thinking": {"type": "disabled"},
                    "response_format": {"type": "json_object"},
                    "temperature": 0.2,
                    "max_tokens": 2048,
                },
            )
        except httpx.TimeoutException:
            raise PromptAdapterError(
                "prompt_service_timeout",
                "The prompt service request timed out",
            ) from None
        except httpx.NetworkError:
            raise PromptAdapterError(
                "prompt_connection_failed",
                "The application could not connect to the prompt service",
            ) from None
        except httpx.RequestError:
            raise PromptAdapterError(
                "prompt_service_failed",
                "The prompt service request failed",
            ) from None

        if response.status_code in {401, 403}:
            raise PromptAdapterError(
                "prompt_authentication_failed",
                "The prompt service rejected the configured credentials",
                self._response_diagnostics(response),
            )
        if response.status_code == 429:
            raise PromptAdapterError(
                "prompt_rate_limited",
                "The prompt service rate limit was reached",
                self._response_diagnostics(response),
            )
        if not response.is_success:
            raise PromptAdapterError(
                "prompt_service_failed",
                f"The prompt service returned an unsuccessful response (HTTP {response.status_code})",
                self._response_diagnostics(response),
            )

        try:
            body = response.json()
        except ValueError:
            raise PromptAdapterError(
                "invalid_prompt_envelope",
                "The prompt service returned an invalid response envelope",
                self._response_diagnostics(response),
            ) from None

        if not isinstance(body, dict):
            raise PromptAdapterError(
                "invalid_prompt_envelope",
                "The prompt service returned an invalid response envelope",
                self._response_diagnostics(response),
            )
        choices = body.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
            raise PromptAdapterError(
                "invalid_prompt_envelope",
                "The prompt service returned an invalid response envelope",
                self._response_diagnostics(response),
            )
        choice = choices[0]
        finish_reason = choice.get("finish_reason")
        diagnostics = self._response_diagnostics(
            response,
            finish_reason=finish_reason if isinstance(finish_reason, str) else None,
        )
        message = choice.get("message")
        if not isinstance(message, dict) or "content" not in message:
            raise PromptAdapterError(
                "invalid_prompt_envelope",
                "The prompt service returned an invalid response envelope",
                diagnostics,
            )
        content = message["content"]
        if content is None or (isinstance(content, str) and not content.strip()):
            raise PromptAdapterError(
                "empty_prompt_content",
                "The prompt service returned empty prompt content",
                diagnostics,
            )
        if not isinstance(content, str):
            raise PromptAdapterError(
                "invalid_prompt_envelope",
                "The prompt service returned an invalid response envelope",
                diagnostics,
            )
        return content

    @staticmethod
    def _response_diagnostics(
        response: httpx.Response,
        *,
        finish_reason: str | None = None,
    ) -> dict[str, Any]:
        diagnostics: dict[str, Any] = {"httpStatus": response.status_code}
        request_id = response.headers.get("x-request-id")
        if request_id:
            diagnostics["requestId"] = request_id
        if finish_reason:
            diagnostics["finishReason"] = finish_reason
        return diagnostics

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
