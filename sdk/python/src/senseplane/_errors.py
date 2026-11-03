# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from typing import Any

from ._generated.api import ErrorCode as ErrorCode


class SenseplaneError(Exception):
    """Raised for any non-2xx API response. `code` is one of ErrorCode, or "unknown"."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        self.details = details

    def __repr__(self) -> str:
        return f"{type(self).__name__}(status={self.status}, code={self.code!r}, message={self.message!r})"


class AuthenticationError(SenseplaneError):
    """401: the key is missing, wrong or revoked."""


class PermissionDeniedError(SenseplaneError):
    """403: the key is valid but may not do this (a grant, sense or role is missing)."""


class NotFoundError(SenseplaneError):
    """404"""


class ConflictError(SenseplaneError):
    """409"""


class RateLimitError(SenseplaneError):
    """429: retried automatically first (honouring Retry-After)."""


class InternalServerError(SenseplaneError):
    """5xx"""


class APIConnectionError(SenseplaneError):
    """The request never got a response: the network failed or it timed out. `status` is 0."""

    def __init__(self, message: str, *, timeout: bool = False) -> None:
        super().__init__(0, "timeout" if timeout else "connection_error", message)
        self.timeout = timeout


class WebhookVerificationError(Exception):
    """A webhook delivery whose signature or timestamp doesn't check out."""


_BY_STATUS: dict[int, type[SenseplaneError]] = {
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    429: RateLimitError,
}


def error_class(status: int) -> type[SenseplaneError]:
    if status >= 500:
        return InternalServerError
    return _BY_STATUS.get(status, SenseplaneError)
