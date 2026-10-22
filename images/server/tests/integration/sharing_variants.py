"""Spike S7's request variants, ported, sent straight to the server with no Worker in front.

S7 found 87 ways to spell a request to ``/v1/sharing``. Against Omnigent's standard start,
29 of them reached the write handler and changed the sharing settings. The server image starts
Omnigent with authoritative sharing values, so Omnigent itself must refuse every one: each
variant that reaches the handler gets 403, no variant changes anything, and every read reports
the settings as not editable.
"""

from __future__ import annotations

import gzip
import socket
from dataclasses import dataclass, field

BODY = '{"public_sharing": true}'
JSON_CT = ("Content-Type", "application/json")

#: The variants that reached the write handler without a Worker in S7's control run
#: (``variants-control-standard``). With authoritative settings each must answer 403.
REACHED_THE_HANDLER = frozenset(
    {"P01", "P09", "P10", "P12", "P13", "P24", "P32", "P33", "P34", "P36"}
    | {f"D{n:02d}" for n in range(1, 26)} - {"D16", "D17", "D18", "D20", "D21", "D22"}
)


@dataclass(frozen=True)
class Variant:
    id: str
    line: str
    headers: tuple[tuple[str, str], ...] = ()
    body: bytes | None = None
    chunked: bool = False
    anonymous: bool = False
    #: A read: answered normally, with every editable flag false.
    read: bool = False
    extra: dict[str, str] = field(default_factory=dict)


def _put(vid: str, target: str) -> Variant:
    return Variant(vid, f"PUT {target} HTTP/1.1", (JSON_CT,), BODY.encode())


def _method(
    vid: str,
    verb: str,
    headers: tuple[tuple[str, str], ...] = (),
    *,
    body: bool = True,
    target: str = "/v1/sharing",
    read: bool = False,
) -> Variant:
    return Variant(
        vid,
        f"{verb} {target} HTTP/1.1",
        (JSON_CT, *headers),
        BODY.encode() if body else None,
        read=read,
    )


def _body(
    vid: str,
    payload: bytes | None,
    headers: tuple[tuple[str, str], ...] = (JSON_CT,),
    *,
    chunked: bool = False,
) -> Variant:
    return Variant(vid, "PUT /v1/sharing HTTP/1.1", headers, payload, chunked=chunked)


def variants(port: int) -> list[Variant]:
    paths = [
        ("P01", "/v1/sharing"),
        ("P02", "/v1/sharing/"),
        ("P03", "/v1/sharing//"),
        ("P04", "//v1/sharing"),
        ("P05", "/v1//sharing"),
        ("P06", "///v1///sharing///"),
        ("P07", "/V1/SHARING"),
        ("P08", "/v1/Sharing"),
        ("P09", "/v1/%73haring"),
        ("P10", "/v1/%73%68%61%72%69%6e%67"),
        ("P11", "/v1/%53HARING"),
        ("P12", "/v1%2Fsharing"),
        ("P13", "/v1%2fsharing"),
        ("P14", "/%2Fv1%2Fsharing"),
        ("P15", "/v1/%2573haring"),
        ("P16", "/v1%252Fsharing"),
        ("P17", "/v1/./sharing"),
        ("P18", "/v1/x/../sharing"),
        ("P19", "/./v1/sharing"),
        ("P20", "/v1/%2e/sharing"),
        ("P21", "/v1/x/%2e%2e/sharing"),
        ("P22", "/v1/x/..%2Fsharing"),
        ("P23", "/v1/x%2F..%2Fsharing"),
        ("P24", "/v1/sharing?x=1"),
        ("P25", "/v1/sharing;x=1"),
        ("P26", "/v1/sharing%3Bx=1"),
        ("P27", "/v1/sharing%00"),
        ("P28", "/v1/sharing%20"),
        ("P29", "/v1/sharing%2F"),
        ("P30", "/v1%5Csharing"),
        ("P31", "/v1\\sharing"),
        ("P32", "/v1/sharing#x"),
        ("P33", f"http://127.0.0.1:{port}/v1/sharing"),
        ("P34", "http://omnigent.internal/v1/sharing"),
        ("P35", "/v1/sharing."),
    ]
    out = [_put(vid, target) for vid, target in paths]
    out.append(Variant("P36", "PUT /v1/sharing HTTP/1.0", (JSON_CT,), BODY.encode()))
    out += [
        _method("M01", "POST"),
        _method("M02", "PATCH"),
        _method("M03", "DELETE"),
        _method("M04", "OPTIONS", body=False),
        _method("M05", "put"),
        _method("M06", "Put"),
        _method("M07", "PROPPATCH"),
        _method("M08", "FOO"),
        _method("M09", "TRACE", body=False),
        _method("O01", "GET", (("X-HTTP-Method-Override", "PUT"),), read=True),
        _method("O02", "GET", (("X-HTTP-Method", "PUT"),), read=True),
        _method("O03", "GET", (("X-Method-Override", "PUT"),), read=True),
        _method("O04", "POST", (("X-HTTP-Method-Override", "PUT"),)),
        _method("O05", "GET", target="/v1/sharing?_method=PUT", read=True),
        _method(
            "O06",
            "GET",
            (
                ("Upgrade", "websocket"),
                ("Connection", "Upgrade"),
                ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
                ("Sec-WebSocket-Version", "13"),
            ),
            body=False,
            read=True,
        ),
    ]
    bodies = [
        ("D01", '{"public_sharing": true}'),
        ("D02", '{"public_sharing": "true"}'),
        ("D03", '{"public_sharing": "yes"}'),
        ("D04", '{"public_sharing": "on"}'),
        ("D05", '{"public_sharing": 1}'),
        ("D06", '{"public_sharing": "1"}'),
        ("D07", '{"public_sharing": "t"}'),
        ("D08", '{"public_sharing": "YES"}'),
        ("D09", '{"sharing_mode": "ON"}'),
        ("D10", '{"sharing_mode": " on "}'),
        ("D11", '{"default_public_sessions": "all"}'),
        ("D12", '{"public_sharing_max_level": "edit"}'),
        ("D13", '{"public_sharing": false, "public_sharing": true}'),
        ("D14", '{"public\\u005fsharing": true}'),
        ("D15", '{"public_sharing": true, "unknown": 1}'),
    ]
    out += [_body(vid, text.encode()) for vid, text in bodies]
    out += [
        _body("D16", BODY.encode(), ()),
        _body("D17", BODY.encode(), (("Content-Type", "text/plain"),)),
        _body(
            "D18", b"public_sharing=true", (("Content-Type", "application/x-www-form-urlencoded"),)
        ),
        _body("D19", BODY.encode(), chunked=True),
        _body("D20", gzip.compress(BODY.encode()), (JSON_CT, ("Content-Encoding", "gzip"))),
        _body("D21", None),
        _body("D22", b"{}"),
        _body("D23", ("﻿" + BODY).encode()),
        _body("D24", b'{"public_sharing": false}'),
        _body("D25", BODY.encode(), (("Content-Type", "application/merge-patch+json"),)),
        Variant("G01", "GET /v1/sharing HTTP/1.1", read=True),
        Variant("G02", "HEAD /v1/sharing HTTP/1.1", read=True),
        Variant("G03", "GET /v1/%73haring HTTP/1.1", read=True),
        Variant("G04", "GET /v1/sharing HTTP/1.1", (("Accept-Encoding", "gzip"),), read=True),
        Variant("G05", "GET /v1/sharing HTTP/1.1", anonymous=True, read=True),
        Variant("G06", "GET /v1/info HTTP/1.1", read=True),
        _put("N01", "/v1/sharingx"),
        _put("N02", "/v1/sharing-x"),
        _put("N03", "/x/v1/sharing"),
        _put("N04", "/v1/%EF%BD%93haring"),
        _put("N05", "/v1/sessions/abc/sharing"),
    ]
    return out


@dataclass(frozen=True)
class RawResponse:
    status: int
    headers: dict[str, str]
    body: bytes


def send(port: int, variant: Variant, bearer: str, *, timeout: float = 15) -> RawResponse:
    """Send one variant byte for byte, the way S7's ``rawRequest`` did."""
    lines = [variant.line, f"Host: 127.0.0.1:{port}"]
    if not variant.anonymous:
        lines.append(f"Authorization: Bearer {bearer}")
    lines += [f"{k}: {v}" for k, v in variant.headers]
    payload = b""
    if variant.body is not None:
        if variant.chunked:
            lines.append("Transfer-Encoding: chunked")
            payload = f"{len(variant.body):x}\r\n".encode() + variant.body + b"\r\n0\r\n\r\n"
        else:
            lines.append(f"Content-Length: {len(variant.body)}")
            payload = variant.body
    lines += ["Connection: close", "", ""]
    raw = "\r\n".join(lines).encode("latin-1") + payload
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(raw)
        chunks = []
        while True:
            try:
                chunk = sock.recv(65536)
            except TimeoutError:
                break
            if not chunk:
                break
            chunks.append(chunk)
            if variant.line.startswith("GET") and dict(variant.headers).get("Upgrade"):
                break
    data = b"".join(chunks)
    head, _, body = data.partition(b"\r\n\r\n")
    status_line, *header_lines = head.decode("latin-1").split("\r\n")
    status = int(status_line.split(" ")[1]) if status_line.startswith("HTTP/") else 0
    headers = {}
    for line in header_lines:
        key, _, value = line.partition(":")
        headers[key.strip().lower()] = value.strip()
    return RawResponse(status, headers, body)
