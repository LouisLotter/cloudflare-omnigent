"""Request logs never carry query strings: Omnigent puts credentials there."""

from __future__ import annotations

import logging

import pytest

from cfo_server import logfilter

SYNTHETIC = "synthetic-magic-token-0001"


def _record(msg: str, args: tuple) -> logging.LogRecord:
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, msg, args, None)


def test_access_line_loses_its_query_string() -> None:
    record = _record(
        '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:5000", "GET", f"/auth/magic/redeem?t={SYNTHETIC}", "1.1", 302),
    )
    assert logfilter.QueryStringFilter().filter(record)
    line = record.getMessage()
    assert SYNTHETIC not in line and "/auth/magic/redeem" in line


def test_websocket_handshake_line_loses_its_query_string() -> None:
    record = _record(
        '%s - "WebSocket %s" [accepted]', ("127.0.0.1:5000", f"/v1/x?token={SYNTHETIC}")
    )
    logfilter.QueryStringFilter().filter(record)
    assert SYNTHETIC not in record.getMessage()


def test_other_arguments_are_untouched() -> None:
    record = _record("%s %s %d", ("not/a/path?x=1", "?", 3))
    logfilter.QueryStringFilter().filter(record)
    assert record.getMessage() == "not/a/path?x=1 ? 3"


def test_install_attaches_once_to_uvicorns_request_loggers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    logfilter.install()
    logfilter.install()
    for name in logfilter.REQUEST_LOGGERS:
        filters = logging.getLogger(name).filters
        assert sum(isinstance(f, logfilter.QueryStringFilter) for f in filters) == 1
    with caplog.at_level(logging.INFO, logger="uvicorn.access"):
        logging.getLogger("uvicorn.access").info(
            '%s - "%s %s HTTP/%s" %d', "c", "GET", f"/x?t={SYNTHETIC}", "1.1", 200
        )
    assert SYNTHETIC not in caplog.text
