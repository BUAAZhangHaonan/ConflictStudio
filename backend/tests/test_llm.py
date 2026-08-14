from __future__ import annotations

import asyncio
from collections.abc import Callable

import httpx
import pytest

from backend.adapters.llm import OpenAICompatiblePromptModel, PromptAdapterError


SECRET_KEY = "prompt-test-secret-key"


def run(coroutine):  # type: ignore[no-untyped-def]
    return asyncio.run(coroutine)


def assert_safe(error: PromptAdapterError) -> None:
    rendered = f"{error.code} {error.message}".lower()
    assert SECRET_KEY.lower() not in rendered
    assert "authorization" not in rendered
    assert "response-secret" not in rendered


def capture_error(handler: Callable[[httpx.Request], httpx.Response]) -> PromptAdapterError:
    async def scenario() -> PromptAdapterError:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = OpenAICompatiblePromptModel(SECRET_KEY, client)
        try:
            with pytest.raises(PromptAdapterError) as captured:
                await model.generate("system", "user")
            return captured.value
        finally:
            await client.aclose()

    return run(scenario())


@pytest.mark.parametrize(
    ("status_code", "expected_code", "expected_message"),
    [
        (401, "prompt_authentication_failed", "The prompt service rejected the configured credentials"),
        (403, "prompt_authentication_failed", "The prompt service rejected the configured credentials"),
        (429, "prompt_rate_limited", "The prompt service rate limit was reached"),
        (500, "prompt_service_failed", "The prompt service returned an unsuccessful response (HTTP 500)"),
    ],
)
def test_http_failures_keep_safe_stable_reasons(
    status_code: int,
    expected_code: str,
    expected_message: str,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.headers["Authorization"] == f"Bearer {SECRET_KEY}"
        return httpx.Response(status_code, text=f"response-secret Authorization Bearer {SECRET_KEY}")

    error = capture_error(handler)

    assert calls == 1
    assert error.code == expected_code
    assert error.message == expected_message
    assert_safe(error)


@pytest.mark.parametrize(
    ("failure", "expected_code", "expected_message"),
    [
        (
            httpx.ReadTimeout(f"response-secret Authorization Bearer {SECRET_KEY}"),
            "prompt_service_timeout",
            "The prompt service request timed out",
        ),
        (
            httpx.ConnectError(f"response-secret Authorization Bearer {SECRET_KEY}"),
            "prompt_connection_failed",
            "The application could not connect to the prompt service",
        ),
    ],
)
def test_transport_failures_keep_safe_stable_reasons(
    failure: httpx.RequestError,
    expected_code: str,
    expected_message: str,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        failure.request = request
        raise failure

    error = capture_error(handler)

    assert calls == 1
    assert error.code == expected_code
    assert error.message == expected_message
    assert_safe(error)


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(200, json={"choices": [{"message": {"content": ""}}]}),
    ],
)
def test_invalid_response_schema_keeps_explicit_safe_error(response: httpx.Response) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return response

    error = capture_error(handler)

    assert error.code == "invalid_prompt_response"
    assert error.message == "The prompt service returned data that does not match the required structure"
    assert_safe(error)
