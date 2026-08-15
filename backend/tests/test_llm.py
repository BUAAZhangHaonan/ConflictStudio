from __future__ import annotations

import asyncio
import json
from collections.abc import Callable

import httpx
import pytest

from backend.adapters.llm import OpenAICompatiblePromptModel, PromptAdapterError


SECRET_KEY = "prompt-test-secret-key"
SYSTEM_INPUT = "system-prompt-secret"
USER_INPUT = "user-prompt-secret"


def run(coroutine):  # type: ignore[no-untyped-def]
    return asyncio.run(coroutine)


def assert_safe(error: PromptAdapterError) -> None:
    rendered = f"{error.code} {error.message} {json.dumps(error.details)}".lower()
    assert SECRET_KEY.lower() not in rendered
    assert "authorization" not in rendered
    assert "response-secret" not in rendered
    assert SYSTEM_INPUT not in rendered
    assert USER_INPUT not in rendered


def capture_error(handler: Callable[[httpx.Request], httpx.Response]) -> PromptAdapterError:
    async def scenario() -> PromptAdapterError:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = OpenAICompatiblePromptModel(SECRET_KEY, client)
        try:
            with pytest.raises(PromptAdapterError) as captured:
                await model.generate(SYSTEM_INPUT, USER_INPUT)
            return captured.value
        finally:
            await client.aclose()

    return run(scenario())


def test_request_sets_fixed_structured_output_budget() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload == {
            "model": "deepseek-v4-flash",
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "user"},
            ],
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
            "max_tokens": 2048,
        }
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": '{"spokenText":"测试"}'},
                    }
                ]
            },
        )

    async def scenario() -> str:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        model = OpenAICompatiblePromptModel(SECRET_KEY, client)
        try:
            return await model.generate("system", "user")
        finally:
            await client.aclose()

    assert run(scenario()) == '{"spokenText":"测试"}'


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
        return httpx.Response(
            status_code,
            text=f"response-secret Authorization Bearer {SECRET_KEY}",
            headers={"x-request-id": "request-safe-123"},
        )

    error = capture_error(handler)

    assert calls == 1
    assert error.code == expected_code
    assert error.message == expected_message
    assert error.details == {
        "httpStatus": status_code,
        "requestId": "request-safe-123",
    }
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
        httpx.Response(200, text=f"not-json response-secret {SECRET_KEY}"),
        httpx.Response(200, json=[]),
        httpx.Response(200, json={"choices": []}),
        httpx.Response(
            200,
            json={
                "choices": [
                    {"finish_reason": "stop", "message": {"content": 42}}
                ]
            },
        ),
    ],
)
def test_invalid_envelope_keeps_only_safe_diagnostics(
    response: httpx.Response,
) -> None:
    response.headers["x-request-id"] = "request-envelope-456"

    def handler(_: httpx.Request) -> httpx.Response:
        return response

    error = capture_error(handler)

    assert error.code == "invalid_prompt_envelope"
    assert error.message == "The prompt service returned an invalid response envelope"
    assert error.details["httpStatus"] == 200
    assert error.details["requestId"] == "request-envelope-456"
    assert set(error.details) <= {"httpStatus", "finishReason", "requestId"}
    assert_safe(error)


@pytest.mark.parametrize("content", [None, "", "   "])
def test_empty_content_keeps_finish_reason_and_safe_request_id(
    content: str | None,
) -> None:
    response = httpx.Response(
        200,
        json={
            "choices": [
                {"finish_reason": "length", "message": {"content": content}}
            ]
        },
        headers={"x-request-id": "request-empty-789"},
    )

    def handler(_: httpx.Request) -> httpx.Response:
        return response

    error = capture_error(handler)

    assert error.code == "empty_prompt_content"
    assert error.message == "The prompt service returned empty prompt content"
    assert error.details == {
        "httpStatus": 200,
        "requestId": "request-empty-789",
        "finishReason": "length",
    }
    assert_safe(error)
