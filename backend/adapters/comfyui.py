from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
import websockets
from websockets.exceptions import WebSocketException


class AdapterError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _DuplicateJsonKey(ValueError):
    pass


class ComfyUIClient:
    def __init__(
        self,
        base_url: str,
        http_client: httpx.AsyncClient | None = None,
        *,
        websocket_connect: Callable[..., Any] | None = None,
        request_timeout_seconds: float = 30.0,
        cancel_timeout_seconds: float = 5.0,
        cancel_poll_seconds: float = 0.1,
    ) -> None:
        if request_timeout_seconds <= 0:
            raise ValueError("The request timeout must be positive")
        if cancel_timeout_seconds <= 0 or cancel_poll_seconds <= 0:
            raise ValueError("The cancellation timing must be positive")
        self._http_url, self._websocket_url = _service_urls(base_url)
        self._http = http_client or httpx.AsyncClient(timeout=request_timeout_seconds)
        self._owns_http = http_client is None
        self._websocket_connect = websocket_connect or websockets.connect
        self._request_timeout = request_timeout_seconds
        self._cancel_timeout = cancel_timeout_seconds
        self._cancel_poll = cancel_poll_seconds
        self._terminal_prompt_ids: set[str] = set()
        self._prompt_events: dict[str, asyncio.Event] = {}

    async def get_object_info(self) -> dict[str, Any]:
        response = await self._request("GET", "/object_info")
        payload = _decode_json(response)
        if not isinstance(payload, dict):
            raise _invalid_response()
        return payload

    async def submit_prompt(self, workflow: Mapping[str, Any], client_id: str) -> str:
        if not isinstance(workflow, Mapping):
            raise TypeError("workflow must be a mapping")
        _require_identifier(client_id, "client_id")
        response = await self._request(
            "POST",
            "/prompt",
            json_body={"prompt": dict(workflow), "client_id": client_id},
        )
        payload = _decode_json(response)
        if (
            not isinstance(payload, dict)
            or set(payload) != {"prompt_id"}
            or type(payload.get("prompt_id")) is not str
            or payload["prompt_id"] == ""
        ):
            raise _invalid_response()
        try:
            _require_identifier(payload["prompt_id"], "prompt_id")
        except (TypeError, ValueError) as error:
            raise _invalid_response() from error
        return payload["prompt_id"]

    async def websocket_messages(self, client_id: str) -> AsyncIterator[dict[str, Any]]:
        _require_identifier(client_id, "client_id")
        url = f"{self._websocket_url}/ws?{urlencode({'clientId': client_id})}"
        try:
            async with self._websocket_connect(
                url,
                open_timeout=self._request_timeout,
            ) as websocket:
                async for message in websocket:
                    if isinstance(message, bytes):
                        continue
                    if type(message) is not str:
                        raise _invalid_response()
                    payload = _decode_json_bytes(message.encode("utf-8"))
                    if not isinstance(payload, dict):
                        raise _invalid_response()
                    self._record_websocket_state(payload)
                    yield payload
        except AdapterError:
            raise
        except TimeoutError as error:
            raise AdapterError(
                "comfyui_timeout",
                "The ComfyUI websocket timed out",
            ) from error
        except (WebSocketException, OSError) as error:
            raise AdapterError(
                "comfyui_websocket_failed",
                "The ComfyUI websocket failed",
            ) from error
        except Exception as error:
            raise AdapterError(
                "comfyui_websocket_failed",
                "The ComfyUI websocket failed",
            ) from error

    async def get_queue(self) -> dict[str, Any]:
        response = await self._request("GET", "/queue")
        payload = _decode_json(response)
        _queue_prompt_ids(payload)
        return payload

    async def get_history(self, prompt_id: str | None = None) -> dict[str, Any]:
        path = "/history"
        if prompt_id is not None:
            _require_identifier(prompt_id, "prompt_id")
            path = f"{path}/{prompt_id}"
        response = await self._request("GET", path)
        payload = _decode_json(response)
        if not isinstance(payload, dict):
            raise _invalid_response()
        return payload

    async def cancel(self, prompt_id: str) -> None:
        _require_identifier(prompt_id, "prompt_id")
        queue = await self.get_queue()
        running, pending = _queue_prompt_ids(queue)
        if prompt_id in running and prompt_id in pending:
            raise _invalid_response()

        if prompt_id in pending:
            await self._request(
                "POST",
                "/queue",
                json_body={"delete": [prompt_id]},
            )
        elif prompt_id in running:
            await self._request(
                "POST",
                "/interrupt",
                json_body={"prompt_id": prompt_id},
            )
        else:
            history = await self.get_history(prompt_id)
            if self._is_terminal(prompt_id, history):
                return
            raise AdapterError(
                "comfyui_prompt_not_active",
                "The ComfyUI prompt is not active",
            )

        await self._confirm_cancelled(prompt_id)

    async def close(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        try:
            response = await self._http.request(
                method,
                f"{self._http_url}{path}",
                json=json_body,
                timeout=self._request_timeout,
            )
        except httpx.TimeoutException as error:
            raise AdapterError(
                "comfyui_timeout",
                "The ComfyUI HTTP request timed out",
            ) from error
        except httpx.HTTPError as error:
            raise AdapterError(
                "comfyui_request_failed",
                "The ComfyUI HTTP request failed",
            ) from error
        except TimeoutError as error:
            raise AdapterError(
                "comfyui_timeout",
                "The ComfyUI HTTP request timed out",
            ) from error
        except Exception as error:
            raise AdapterError(
                "comfyui_request_failed",
                "The ComfyUI HTTP request failed",
            ) from error
        if response.status_code != 200:
            raise AdapterError(
                "comfyui_request_failed",
                "The ComfyUI HTTP request failed",
            )
        return response

    async def _confirm_cancelled(self, prompt_id: str) -> None:
        deadline = time.monotonic() + self._cancel_timeout
        event = self._prompt_events.setdefault(prompt_id, asyncio.Event())
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterError(
                    "comfyui_cancel_unconfirmed",
                    "ComfyUI did not confirm cancellation before the deadline",
                )
            try:
                queue = await asyncio.wait_for(self.get_queue(), timeout=remaining)
            except TimeoutError as error:
                raise AdapterError(
                    "comfyui_cancel_unconfirmed",
                    "ComfyUI did not confirm cancellation before the deadline",
                ) from error
            running, pending = _queue_prompt_ids(queue)
            if prompt_id not in running and prompt_id not in pending:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterError(
                    "comfyui_cancel_unconfirmed",
                    "ComfyUI did not confirm cancellation before the deadline",
                )
            try:
                history = await asyncio.wait_for(
                    self.get_history(prompt_id),
                    timeout=remaining,
                )
            except TimeoutError as error:
                raise AdapterError(
                    "comfyui_cancel_unconfirmed",
                    "ComfyUI did not confirm cancellation before the deadline",
                ) from error
            if self._is_terminal(prompt_id, history):
                return

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AdapterError(
                    "comfyui_cancel_unconfirmed",
                    "ComfyUI did not confirm cancellation before the deadline",
                )
            try:
                await asyncio.wait_for(
                    event.wait(),
                    timeout=min(self._cancel_poll, remaining),
                )
            except TimeoutError:
                pass
            if prompt_id in self._terminal_prompt_ids:
                return

    def _record_websocket_state(self, payload: dict[str, Any]) -> None:
        event_type = payload.get("type")
        data = payload.get("data")
        if not isinstance(data, dict):
            return
        prompt_id = data.get("prompt_id")
        if type(prompt_id) is not str:
            return
        terminal = event_type in {
            "execution_success",
            "execution_error",
            "execution_interrupted",
        } or (event_type == "executing" and data.get("node") is None)
        if terminal:
            self._terminal_prompt_ids.add(prompt_id)
            self._prompt_events.setdefault(prompt_id, asyncio.Event()).set()

    def _is_terminal(self, prompt_id: str, history: dict[str, Any]) -> bool:
        if prompt_id in self._terminal_prompt_ids:
            return True
        record = history.get(prompt_id)
        if not isinstance(record, dict):
            return False
        status = record.get("status")
        if not isinstance(status, dict):
            return False
        if status.get("completed") is True:
            return True
        if status.get("status_str") in {"success", "error", "interrupted"}:
            return True
        messages = status.get("messages")
        if not isinstance(messages, list):
            return False
        return any(
            isinstance(message, list)
            and bool(message)
            and message[0] == "execution_interrupted"
            for message in messages
        )


def _service_urls(base_url: str) -> tuple[str, str]:
    if type(base_url) is not str:
        raise TypeError("base_url must be a string")
    parsed = urlsplit(base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("base_url must be an HTTP service origin")
    path = parsed.path.rstrip("/")
    http_url = urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
    websocket_scheme = "wss" if parsed.scheme == "https" else "ws"
    websocket_url = urlunsplit((websocket_scheme, parsed.netloc, path, "", ""))
    return http_url, websocket_url


def _decode_json(response: httpx.Response) -> Any:
    return _decode_json_bytes(response.content)


def _decode_json_bytes(content: bytes) -> Any:
    def pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise _DuplicateJsonKey
            result[key] = value
        return result

    try:
        text = content.decode("utf-8")
        return json.loads(text, object_pairs_hook=pairs_hook)
    except (UnicodeError, json.JSONDecodeError, _DuplicateJsonKey) as error:
        raise _invalid_response() from error


def _queue_prompt_ids(payload: Any) -> tuple[set[str], set[str]]:
    if not isinstance(payload, dict):
        raise _invalid_response()
    running = _entry_prompt_ids(payload.get("queue_running"))
    pending = _entry_prompt_ids(payload.get("queue_pending"))
    return running, pending


def _entry_prompt_ids(entries: Any) -> set[str]:
    if not isinstance(entries, list):
        raise _invalid_response()
    prompt_ids: set[str] = set()
    for entry in entries:
        if not isinstance(entry, list) or len(entry) < 2 or type(entry[1]) is not str:
            raise _invalid_response()
        if entry[1] in prompt_ids:
            raise _invalid_response()
        prompt_ids.add(entry[1])
    return prompt_ids


def _require_identifier(value: str, name: str) -> None:
    if type(value) is not str or not value or len(value) > 160:
        raise ValueError(f"{name} is not valid")
    if not all(character.isascii() and (character.isalnum() or character in "_-") for character in value):
        raise ValueError(f"{name} is not valid")


def _invalid_response() -> AdapterError:
    return AdapterError(
        "comfyui_invalid_response",
        "ComfyUI returned an invalid response",
    )
