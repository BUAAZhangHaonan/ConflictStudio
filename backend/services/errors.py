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


def review_revision_conflict(sample_id: int, expected: int, actual: int) -> ServiceError:
    return ServiceError(
        409,
        "review_revision_conflict",
        "The review history has been changed by another operation",
        {
            "resource": "sample",
            "id": sample_id,
            "expectedReviewRevision": expected,
            "actualReviewRevision": actual,
        },
    )


def reviewer_name_conflict(name: str) -> ServiceError:
    return ServiceError(
        409,
        "reviewer_name_conflict",
        "A reviewer with this name already exists",
        {"name": name},
    )


def archive_preview_stale(dataset_id: int) -> ServiceError:
    return ServiceError(
        409,
        "archive_preview_stale",
        "The archive contents changed after the preview was created",
        {"resource": "archive", "id": dataset_id},
    )


def invalid_request(message: str, details: dict[str, Any] | None = None) -> ServiceError:
    return ServiceError(422, "validation_error", message, details)


def state_conflict(resource: str, identifier: int | str, message: str) -> ServiceError:
    return ServiceError(409, "state_conflict", message, {"resource": resource, "id": identifier})
