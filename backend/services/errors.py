from __future__ import annotations

from typing import Any


class ServiceError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or {}


def not_found(resource: str, identifier: int | str) -> ServiceError:
    return ServiceError(404, "not_found", "The requested record does not exist", {"resource": resource, "id": identifier})


def revision_conflict(resource: str, identifier: int, expected: int, actual: int) -> ServiceError:
    return ServiceError(
        409,
        "revision_conflict",
        "The record has been changed by another operation",
        {"resource": resource, "id": identifier, "expectedRevision": expected, "actualRevision": actual},
    )


def state_conflict(resource: str, identifier: int | str, message: str) -> ServiceError:
    return ServiceError(409, "state_conflict", message, {"resource": resource, "id": identifier})

