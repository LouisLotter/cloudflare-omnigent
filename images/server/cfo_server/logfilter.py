"""Keep query strings out of the server's request logs.

Uvicorn's access log and its WebSocket handshake lines carry the full request target, query
string included, and Omnigent puts credentials there: a magic-login link is
``/auth/magic/redeem?t=<token>``. The design logs request paths without their query strings.
This filter rewrites those records before any handler formats them.
"""

from __future__ import annotations

import logging

#: Uvicorn's loggers that carry request targets: HTTP access lines, and WebSocket handshake
#: lines (logged on ``uvicorn.error``).
REQUEST_LOGGERS = ("uvicorn.access", "uvicorn.error")


def _strip(value: object) -> object:
    if isinstance(value, str) and value.startswith("/") and "?" in value:
        return value.split("?", 1)[0]
    return value


class QueryStringFilter(logging.Filter):
    """Drop the query string from every request target in a record's arguments."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(_strip(arg) for arg in record.args)
        elif isinstance(record.args, dict):
            record.args = {key: _strip(arg) for key, arg in record.args.items()}
        if isinstance(record.msg, str) and record.msg.startswith("/") and not record.args:
            record.msg = _strip(record.msg)  # type: ignore[assignment]
        return True


def install() -> None:
    """Attach the filter to uvicorn's request loggers. Call after ``uvicorn.Config``, which
    configures logging."""
    query_filter = QueryStringFilter()
    for name in REQUEST_LOGGERS:
        logger = logging.getLogger(name)
        if not any(isinstance(f, QueryStringFilter) for f in logger.filters):
            logger.addFilter(query_filter)
