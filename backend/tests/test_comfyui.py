from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from backend.adapters.comfyui import AdapterError, ComfyUIClient


def run(coroutine):  # type: ignore[no-untyped-def]
    return asyncio.run(coroutine)


def make_client(
    handler,  # type: ignore[no-untyped-def]
    **kwargs: Any,
) -> tuple[ComfyUIClient, httpx.AsyncClient]:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ComfyUIClient("http://comfy.test", http, **kwargs), http


def test_object_info_queue_and_history_use_exact_get_endpoints() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payloads = {
            "/object_info": {"SaveVideo": {"input": {}}},
            "/queue": {"queue_running": [], "queue_pending": []},
            "/history/prompt-1": {"prompt-1": {"status": {"completed": True}}},
        }
        return httpx.Response(200, json=payloads[request.url.path])

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            assert await client.get_object_info() == {"SaveVideo": {"input": {}}}
            assert await client.get_queue() == {"queue_running": [], "queue_pending": []}
            assert await client.get_history("prompt-1") == {
                "prompt-1": {"status": {"completed": True}}
            }
        finally:
            await http.aclose()

    run(scenario())
    assert [(request.method, request.url.path) for request in requests] == [
        ("GET", "/object_info"),
        ("GET", "/queue"),
        ("GET", "/history/prompt-1"),
    ]


@pytest.mark.parametrize(
    "number",
    [
        0,
        1.25,
    ],
)
def test_submit_prompt_sends_exact_payload_and_accepts_real_contract(
    number: int | float,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        payload = {
            "prompt_id": "prompt-7",
            "number": number,
            "node_errors": {},
        }
        return httpx.Response(
            200,
            json=payload,
        )

    async def scenario() -> str:
        client, http = make_client(handler)
        try:
            return await client.submit_prompt(
                {"node": {"class_type": "Example", "inputs": {}}},
                "client-9",
            )
        finally:
            await http.aclose()

    assert run(scenario()) == "prompt-7"
    assert len(requests) == 1
    assert requests[0].method == "POST"
    assert requests[0].url.path == "/prompt"
    assert json.loads(requests[0].content) == {
        "prompt": {"node": {"class_type": "Example", "inputs": {}}},
        "client_id": "client-9",
    }


def test_submit_prompt_rejects_prompt_rejected_payload() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "prompt_id": "prompt-7",
                "number": 0,
                "node_errors": {
                    "3": {
                        "errors": [
                            {
                                "type": "value_not_in_list",
                                "message": "Value not in list",
                            }
                        ]
                    }
                },
            },
        )

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            with pytest.raises(AdapterError) as error:
                await client.submit_prompt({}, "client")
            assert error.value.code == "comfyui_prompt_rejected"
            assert "Value not in list" in error.value.message
        finally:
            await http.aclose()

    run(scenario())


@pytest.mark.parametrize(
    "response_body",
    [
        b"{}",
        b'{"number":0,"node_errors":{}}',
        b'{"prompt_id":"one","node_errors":{}}',
        b'{"prompt_id":"one","number":0}',
        b'{"prompt_id":7,"number":0,"node_errors":{}}',
        b'{"prompt_id":"","number":0,"node_errors":{}}',
        b'{"prompt_id":"one","number":"0","node_errors":{}}',
        b'{"prompt_id":"one","number":true,"node_errors":{}}',
        b'{"prompt_id":"one","number":0,"node_errors":[]}',
        b'{"prompt_id":"one","number":0,"node_errors":{},"extra":true}',
        b'{"prompt_id":"one","prompt_id":"two","number":0,"node_errors":{}}',
        b"[]",
        b"not-json",
    ],
)
def test_submit_prompt_rejects_missing_extra_wrong_duplicate_and_invalid_fields(
    response_body: bytes,
) -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=response_body)

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            with pytest.raises(AdapterError) as error:
                await client.submit_prompt({}, "client")
            assert error.value.code == "comfyui_invalid_response"
            assert error.value.message == "ComfyUI returned an invalid response"
        finally:
            await http.aclose()

    run(scenario())


class FakeWebSocket:
    def __init__(self, messages: list[str | bytes]) -> None:
        self._messages = messages

    async def __aenter__(self) -> FakeWebSocket:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[str | bytes]:
        async def messages() -> AsyncIterator[str | bytes]:
            for message in self._messages:
                yield message

        return messages()


def test_websocket_is_async_uses_client_id_ignores_binary_and_yields_json() -> None:
    calls: list[tuple[str, float]] = []

    def connect(url: str, *, open_timeout: float) -> FakeWebSocket:
        calls.append((url, open_timeout))
        return FakeWebSocket(
            [
                b"binary-preview",
                '{"type":"progress","data":{"value":1}}',
                '{"type":"execution_success","data":{"prompt_id":"prompt-1"}}',
            ]
        )

    async def scenario() -> list[dict[str, Any]]:
        client, http = make_client(
            lambda _: httpx.Response(500),
            websocket_connect=connect,
            request_timeout_seconds=4.0,
        )
        try:
            return [message async for message in client.websocket_messages("client-1")]
        finally:
            await http.aclose()

    messages = run(scenario())
    assert calls == [("ws://comfy.test/ws?clientId=client-1", 4.0)]
    assert [message["type"] for message in messages] == ["progress", "execution_success"]


def test_queued_cancel_deletes_only_exact_prompt_and_confirms_queue_exit() -> None:
    requests: list[tuple[str, str, Any]] = []
    queue_reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal queue_reads
        body = json.loads(request.content) if request.content else None
        requests.append((request.method, request.url.path, body))
        if request.method == "GET" and request.url.path == "/queue":
            queue_reads += 1
            pending = [[9, "queued-1", {}, {}, []]] if queue_reads == 1 else []
            return httpx.Response(200, json={"queue_running": [], "queue_pending": pending})
        if request.method == "POST" and request.url.path == "/queue":
            return httpx.Response(200, json={})
        if request.method == "GET" and request.url.path == "/history/queued-1":
            return httpx.Response(
                200,
                json={
                    "queued-1": {
                        "status": {
                            "completed": False,
                            "status_str": "cancelled",
                            "messages": [],
                        }
                    }
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            await client.cancel("queued-1")
        finally:
            await http.aclose()

    run(scenario())
    assert requests == [
        ("GET", "/queue", None),
        ("POST", "/queue", {"delete": ["queued-1"]}),
        ("GET", "/queue", None),
        ("GET", "/history/queued-1", None),
    ]


def test_running_cancel_interrupts_only_exact_prompt_and_accepts_interrupted_history() -> None:
    requests: list[tuple[str, str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        requests.append((request.method, request.url.path, body))
        if request.method == "GET" and request.url.path == "/queue":
            return httpx.Response(
                200,
                json={"queue_running": [[1, "running-1", {}, {}, []]], "queue_pending": []},
            )
        if request.method == "POST" and request.url.path == "/interrupt":
            return httpx.Response(200, json={})
        if request.method == "GET" and request.url.path == "/history/running-1":
            return httpx.Response(
                200,
                json={
                    "running-1": {
                        "status": {
                            "completed": False,
                            "status_str": "running",
                            "messages": [["execution_interrupted", {"prompt_id": "running-1"}]],
                        }
                    }
                },
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url.path}")

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            await client.cancel("running-1")
        finally:
            await http.aclose()

    run(scenario())
    assert ("POST", "/interrupt", {"prompt_id": "running-1"}) in requests
    assert not any(
        method == "POST" and (body is None or body == {} or "clear" in body)
        for method, _, body in requests
    )


def test_cancel_confirmation_uses_websocket_terminal_state() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/queue":
            return httpx.Response(
                200,
                json={"queue_running": [[1, "running-2", {}, {}, []]], "queue_pending": []},
            )
        if request.url.path == "/interrupt":
            return httpx.Response(200, json={})
        if request.url.path == "/history/running-2":
            return httpx.Response(200, json={})
        raise AssertionError(request.url.path)

    def connect(_: str, *, open_timeout: float) -> FakeWebSocket:
        assert open_timeout == 30.0
        return FakeWebSocket(
            ['{"type":"execution_interrupted","data":{"prompt_id":"running-2"}}']
        )

    async def scenario() -> None:
        client, http = make_client(handler, websocket_connect=connect)
        try:
            async with client.observe_prompt("running-2"):
                assert [message async for message in client.websocket_messages("client")] != []
                await client.cancel("running-2")
            assert client._prompt_states == {}
        finally:
            await http.aclose()

    run(scenario())


def test_queue_exit_with_normal_history_returns_stable_already_completed() -> None:
    queue_reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal queue_reads
        if request.url.path == "/queue" and request.method == "GET":
            queue_reads += 1
            running = [[1, "race", {}, {}, []]] if queue_reads == 1 else []
            return httpx.Response(200, json={"queue_running": running, "queue_pending": []})
        if request.url.path == "/interrupt":
            return httpx.Response(200, json={})
        if request.url.path == "/history/race":
            return httpx.Response(
                200,
                json={
                    "race": {
                        "status": {
                            "completed": True,
                            "status_str": "success",
                            "messages": [],
                        }
                    }
                },
            )
        raise AssertionError(request.url.path)

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            with pytest.raises(AdapterError) as error:
                await client.cancel("race")
            assert error.value.code == "already_completed"
            assert client._prompt_states == {}
        finally:
            await http.aclose()

    run(scenario())


def test_prompt_state_cleanup_keeps_other_subscribers_until_their_finally() -> None:
    async def scenario() -> None:
        client, http = make_client(lambda _: httpx.Response(500))
        try:
            async with client.observe_prompt("shared"):
                assert client._prompt_states["shared"].subscribers == 1
                async with client.observe_prompt("shared"):
                    assert client._prompt_states["shared"].subscribers == 2
                assert client._prompt_states["shared"].subscribers == 1
            assert client._prompt_states == {}
        finally:
            await http.aclose()

    run(scenario())


def test_http_200_without_cancel_confirmation_fails_at_bounded_deadline() -> None:
    posts: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/queue" and request.method == "GET":
            return httpx.Response(
                200,
                json={"queue_running": [[1, "stuck", {}, {}, []]], "queue_pending": []},
            )
        if request.url.path == "/interrupt":
            posts.append(json.loads(request.content))
            return httpx.Response(200, json={})
        if request.url.path == "/history/stuck":
            return httpx.Response(200, json={})
        raise AssertionError(request.url.path)

    async def scenario() -> None:
        client, http = make_client(
            handler,
            cancel_timeout_seconds=0.004,
            cancel_poll_seconds=0.001,
        )
        try:
            with pytest.raises(AdapterError) as error:
                await client.cancel("stuck")
            assert error.value.code == "comfyui_cancel_unconfirmed"
            assert error.value.message == "ComfyUI did not confirm cancellation before the deadline"
            assert client._prompt_states == {}
        finally:
            await http.aclose()

    run(scenario())
    assert posts == [{"prompt_id": "stuck"}]


@pytest.mark.parametrize(
    ("failure", "expected_code"),
    [
        (httpx.ConnectError("secret payload/path"), "comfyui_request_failed"),
        (httpx.ReadTimeout("secret payload/path"), "comfyui_timeout"),
    ],
)
def test_http_transport_and_timeout_errors_are_safe_adapter_errors(
    failure: httpx.HTTPError,
    expected_code: str,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        failure.request = request
        raise failure

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            with pytest.raises(AdapterError) as error:
                await client.get_object_info()
            assert error.value.code == expected_code
            assert "secret" not in error.value.message
            assert "path" not in error.value.message.lower()
        finally:
            await http.aclose()

    run(scenario())
    assert calls == 1


def test_http_status_and_protocol_errors_do_not_leak_response_body() -> None:
    responses = iter(
        [
            httpx.Response(500, text="secret payload /private/workflow.json"),
            httpx.Response(200, json={"queue_running": "wrong", "queue_pending": []}),
        ]
    )

    def handler(_: httpx.Request) -> httpx.Response:
        return next(responses)

    async def scenario() -> None:
        client, http = make_client(handler)
        try:
            with pytest.raises(AdapterError) as status_error:
                await client.get_object_info()
            assert status_error.value.code == "comfyui_request_failed"
            assert "secret" not in status_error.value.message
            with pytest.raises(AdapterError) as protocol_error:
                await client.get_queue()
            assert protocol_error.value.code == "comfyui_invalid_response"
        finally:
            await http.aclose()

    run(scenario())


def test_websocket_json_and_transport_failures_convert_to_safe_adapter_errors() -> None:
    def invalid_json_connect(_: str, *, open_timeout: float) -> FakeWebSocket:
        return FakeWebSocket(["secret-not-json"])

    class BrokenConnection:
        async def __aenter__(self):  # type: ignore[no-untyped-def]
            raise OSError("secret host path")

        async def __aexit__(self, *args: object) -> None:
            return None

    def broken_connect(_: str, *, open_timeout: float) -> BrokenConnection:
        return BrokenConnection()

    async def consume(connect) -> AdapterError:  # type: ignore[no-untyped-def]
        client, http = make_client(
            lambda _: httpx.Response(500),
            websocket_connect=connect,
        )
        try:
            with pytest.raises(AdapterError) as error:
                _ = [message async for message in client.websocket_messages("client")]
            return error.value
        finally:
            await http.aclose()

    json_error = run(consume(invalid_json_connect))
    transport_error = run(consume(broken_connect))
    assert json_error.code == "comfyui_invalid_response"
    assert transport_error.code == "comfyui_websocket_failed"
    assert "secret" not in json_error.message
    assert "secret" not in transport_error.message
