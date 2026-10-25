"""The launcher's wire protocol against 3.C's contract: the signing vectors, every request and
result fixture, the exported JSON Schemas, and the rule tables in ``contracts/src/launcher.ts``."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from pathlib import Path
from typing import Any

import pytest
from fake_platform import ERROR_SCHEMA, REQUEST_SCHEMA, RESULT_SCHEMA
from hypothesis import given, settings
from hypothesis import strategies as st

from cloudflare_omnigent.sandbox import protocol

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS = ROOT / "contracts"
FIXTURES = CONTRACTS / "fixtures"
LAUNCHER_TS = (CONTRACTS / "src" / "launcher.ts").read_text()
SIGNING = json.loads((CONTRACTS / "vectors" / "launcher-signing-v1.json").read_text())

OP_ID = "5f0c6e2a9b4d4c1e8a7f3b2d1c0e9f8a"
CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3"


def _fixtures(kind: str, *, invalid: bool = False) -> list[Path]:
    directory = FIXTURES / kind / ("invalid" if invalid else "")
    return sorted(p for p in directory.glob("*.json") if p.is_file())


# ── The HMAC envelope ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", SIGNING["cases"], ids=lambda c: c["operation"])
def test_signing_reproduces_the_contract_vectors(case: dict[str, Any]) -> None:
    body = case["body"].encode()
    assert protocol.encode_body(json.loads(case["body"])) == body
    assert (
        protocol.string_to_sign(
            operation=case["operation"],
            key_id=case["keyId"],
            timestamp=case["timestamp"],
            body=body,
        )
        == case["stringToSign"]
    )
    headers = protocol.sign_request(
        key=SIGNING["key"].encode(),
        key_id=case["keyId"],
        operation=case["operation"],
        timestamp=case["timestamp"],
        body=body,
    )
    assert headers == case["headers"]


def test_signing_refuses_a_short_key_and_a_bad_key_id() -> None:
    body = b"{}"
    with pytest.raises(protocol.ProtocolError):
        protocol.sign_request(
            key=b"x" * 31, key_id="k", operation="prepare", timestamp=1, body=body
        )
    with pytest.raises(protocol.ProtocolError):
        protocol.sign_request(
            key=b"x" * 32, key_id="bad id", operation="prepare", timestamp=1, body=body
        )


def test_the_first_line_never_verifies_as_a_key_service_call() -> None:
    """Core change 19's key service signs the same envelope under its own first line."""
    message = protocol.string_to_sign(operation="encrypt", key_id="k", timestamp=1, body=b"{}")
    assert message.splitlines()[0] == "cfo-launcher-v1" != "omnigent-key-service-v1"


# ── Requests ────────────────────────────────────────────────────────────────────────────


def _build(fixture: dict[str, Any]) -> dict[str, Any]:
    """Build the fixture's request through the launcher's own builder for its operation."""
    op = fixture["operation"]
    oid, cmp = fixture.get("operationId"), fixture.get("computerId")
    if op == "prepare":
        return protocol.prepare_request(oid)
    if op == "provision":
        return protocol.provision_request(oid, fixture["name"])
    if op == "start_host":
        return protocol.start_host_request(
            oid,
            cmp,
            start_attempt=fixture["startAttempt"],
            host_id=fixture["hostId"],
            host_name=fixture["hostName"],
            token=fixture["token"],
            host_config=fixture["hostConfig"],
        )
    if op == "checkpoint":
        return protocol.checkpoint_request(oid, cmp, fixture["reason"])
    builder = getattr(protocol, f"{op}_request")
    return builder(oid, cmp)


@pytest.mark.parametrize("path", _fixtures("LauncherRequest"), ids=lambda p: p.stem)
def test_each_request_fixture_is_what_the_launcher_builds(path: Path) -> None:
    fixture = json.loads(path.read_text())
    built = _build(fixture)
    assert built == fixture
    REQUEST_SCHEMA.validate(json.loads(protocol.encode_body(built)))


#: Invalid fixtures the builders cannot even express: the fields are fixed by construction.
UNEXPRESSIBLE = {
    "extra-field",
    "unknown-operation",
    "protocol-version-zero",
    "start-host-with-repos",
}


@pytest.mark.parametrize("path", _fixtures("LauncherRequest", invalid=True), ids=lambda p: p.stem)
def test_each_invalid_request_fixture_is_refused_or_unexpressible(path: Path) -> None:
    fixture = json.loads(path.read_text())
    if path.stem in UNEXPRESSIBLE:
        return
    with pytest.raises((protocol.ProtocolError, KeyError)):
        _build(fixture)


def test_request_bodies_are_compact_sorted_ascii() -> None:
    request = protocol.start_host_request(
        OP_ID,
        CMP,
        start_attempt=1,
        host_id="7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f",
        host_name="Café ☕ computer",
        token="t" * 43,
        host_config={"runner": {"idle_timeout_s": 600}},
    )
    body = protocol.encode_body(request)
    assert body.isascii()
    assert b" " not in body.replace(b"Caf\\u00e9 \\u2615 computer", b"")
    assert list(json.loads(body)) == sorted(json.loads(body))
    assert json.loads(body)["hostName"] == "Café ☕ computer"


@pytest.mark.parametrize(
    ("name", "ok"),
    [
        ("a", True),
        ("x" * 128, True),
        ("😀" * 64, True),  # 128 UTF-16 code units, as zod counts
        ("😀" * 65, False),
        ("", False),
        ("tab\there", False),
        ("del\x7f", False),
        ("lone\ud800", False),
    ],
)
def test_host_names_are_bounded_as_the_contract_counts_them(name: str, ok: bool) -> None:
    if ok:
        assert protocol.check_host_name(name) == name
    else:
        with pytest.raises(protocol.ProtocolError):
            protocol.check_host_name(name)


def test_host_config_is_json_and_at_most_64_kib() -> None:
    assert protocol.check_host_config({"a": [1, 2.5, None, True]}) == {"a": [1, 2.5, None, True]}
    with pytest.raises(protocol.ProtocolError):
        protocol.check_host_config({"a": "x" * (64 * 1024)})
    with pytest.raises(protocol.ProtocolError):
        protocol.check_host_config({"a": float("nan")})
    with pytest.raises(protocol.ProtocolError):
        protocol.check_host_config({"a": object()})
    with pytest.raises(protocol.ProtocolError):
        protocol.check_host_config({1: "x"})  # type: ignore[dict-item]


_json_leaf = st.none() | st.booleans() | st.integers(-(2**53), 2**53) | st.text(max_size=20)
_json = st.recursive(
    _json_leaf,
    lambda children: (
        st.lists(children, max_size=4) | st.dictionaries(st.text(max_size=8), children, max_size=4)
    ),
    max_leaves=12,
)
_host_name = st.text(
    alphabet=st.characters(blacklist_categories=("Cc", "Cs")), min_size=1, max_size=64
)


@settings(max_examples=150, deadline=None)
@given(
    op_id=st.from_regex(r"\A[0-9a-f]{32}\Z"),
    attempt=st.integers(1, 2**53 - 1),
    host_id=st.from_regex(r"\A[0-9a-f]{32}\Z"),
    host_name=_host_name,
    token=st.from_regex(r"\A[A-Za-z0-9_-]{32,64}\Z"),
    config=st.dictionaries(st.text(max_size=8), _json, max_size=4),
    timestamp=st.integers(0, 10**12),
)
def test_every_built_start_matches_the_schema_and_its_signature_verifies(
    op_id: str,
    attempt: int,
    host_id: str,
    host_name: str,
    token: str,
    config: dict[str, Any],
    timestamp: int,
) -> None:
    request = protocol.start_host_request(
        op_id,
        CMP,
        start_attempt=attempt,
        host_id=host_id,
        host_name=host_name,
        token=token,
        host_config=config,
    )
    body = protocol.encode_body(request)
    REQUEST_SCHEMA.validate(json.loads(body))
    key = b"k" * 32
    headers = protocol.sign_request(
        key=key, key_id="kid", operation="start_host", timestamp=timestamp, body=body
    )
    lines = [
        "cfo-launcher-v1",
        "start_host",
        "kid",
        str(timestamp),
        hashlib.sha256(body).hexdigest(),
    ]
    expected = hmac.new(key, "\n".join(lines).encode(), hashlib.sha256).hexdigest()
    assert headers[protocol.SIGNATURE_HEADER] == expected


# ── Results ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("path", _fixtures("LauncherResult"), ids=lambda p: p.stem)
def test_each_result_fixture_parses(path: Path) -> None:
    fixture = json.loads(path.read_text())
    protocol.parse_result(fixture["operation"], fixture)


@pytest.mark.parametrize("path", _fixtures("LauncherResult"), ids=lambda p: p.stem)
def test_a_result_with_an_unknown_field_or_for_another_operation_is_unreadable(path: Path) -> None:
    fixture = json.loads(path.read_text())
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_result(fixture["operation"], {**fixture, "surprise": 1})
    other = "terminate" if fixture["operation"] != "terminate" else "resume"
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_result(other, fixture)


@pytest.mark.parametrize("path", _fixtures("LauncherResult", invalid=True), ids=lambda p: p.stem)
def test_each_invalid_result_fixture_is_unreadable(path: Path) -> None:
    fixture = json.loads(path.read_text())
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_result(fixture["operation"], fixture)


def test_results_carry_the_contract_fields() -> None:
    admission = protocol.parse_result(
        "admission",
        json.loads((FIXTURES / "LauncherResult" / "admission-not-saved.json").read_text()),
    )
    assert admission == protocol.AdmissionResult(
        admitting=False,
        status="host_running",
        generation=7,
        reason="not_saved",
        message="The computer's files have not been saved for 35 minutes.",
    )
    claim = protocol.parse_result(
        "claim_start", {"operation": "claim_start", "granted": True, "startAttempt": 4}
    )
    assert claim == protocol.ClaimStartResult(granted=True, start_attempt=4)


@pytest.mark.parametrize(
    "payload",
    [
        {"operation": "status", "running": 1, "status": "stopped", "generation": 0},
        {"operation": "status", "running": True, "status": "stopped", "generation": True},
        {"operation": "status", "running": True, "status": "stopped", "generation": -1},
        {"operation": "status", "running": True, "status": "stopped", "generation": 2**53},
        {"operation": "status", "running": True, "status": "stopped", "generation": 1.5},
        {"operation": "status", "running": True, "status": "unknown", "generation": 0},
        {
            "operation": "admission",
            "admitting": False,
            "reason": "not_saved",
            "message": None,
            "status": "stopped",
            "generation": 0,
        },
        {
            "operation": "admission",
            "admitting": False,
            "reason": "not_saved",
            "message": "",
            "status": "stopped",
            "generation": 0,
        },
        {
            "operation": "admission",
            "admitting": False,
            "reason": "not_saved",
            "message": "x" * 301,
            "status": "stopped",
            "generation": 0,
        },
        {"operation": "start_host", "workspacePath": "/home/./work"},
        {"operation": "start_host", "workspacePath": "/home//work"},
        {"operation": "start_host", "workspacePath": "/home/\u0000"},
        {"operation": "start_host", "workspacePath": "/" + "a" * 4096},
        {"operation": "prepare", "supportedProtocolVersions": []},
        {"operation": "prepare", "supportedProtocolVersions": [0]},
        {"operation": "suspend", "outcome": "unknown"},
        {"operation": "suspend", "outcome": "refused"},
        {"operation": "checkpoint", "outcome": "accepted", "folded": "no"},
        {"operation": "terminate", "removal": "maybe"},
        ["not", "an", "object"],
    ],
)
def test_malformed_results_are_unreadable(payload: Any) -> None:
    operation = payload["operation"] if isinstance(payload, dict) else "status"
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_result(operation, payload)


_status = st.sampled_from(protocol.HOST_SANDBOX_STATUSES + ("unknown",))
_generation = st.one_of(
    st.integers(-2, 2**53 + 1), st.booleans(), st.floats(allow_nan=False), st.none()
)
_message = st.text(
    alphabet=st.characters(max_codepoint=0xFFFF, blacklist_categories=("Cs",)), max_size=310
)


@settings(max_examples=300, deadline=None)
@given(
    payload=st.fixed_dictionaries(
        {"operation": st.just("admission")},
        optional={
            "admitting": st.booleans() | st.none(),
            "reason": st.sampled_from(protocol.ADMISSION_REASONS + ("other",)),
            "message": _message | st.none(),
            "status": _status,
            "generation": _generation,
            "extra": st.integers(),
        },
    )
)
def test_the_parser_accepts_exactly_what_the_schema_accepts(payload: dict[str, Any]) -> None:
    """For admission replies (the richest shape) the parser and the contract agree."""
    schema_ok = RESULT_SCHEMA.is_valid(payload)
    try:
        protocol.parse_result("admission", payload)
        parser_ok = True
    except protocol.ProtocolError:
        parser_ok = False
    assert parser_ok == schema_ok


@settings(max_examples=200, deadline=None)
@given(path=st.text(alphabet=st.sampled_from("/a.é\x00"), max_size=12))
def test_workspace_paths_agree_with_the_schema(path: str) -> None:
    payload = {"operation": "start_host", "workspacePath": path}
    try:
        protocol.parse_result("start_host", payload)
        parser_ok = True
    except protocol.ProtocolError:
        parser_ok = False
    assert parser_ok == RESULT_SCHEMA.is_valid(payload)


# ── Error bodies ────────────────────────────────────────────────────────────────────────


def test_error_bodies_parse_and_classify() -> None:
    body = json.loads((FIXTURES / "ErrorBody" / "stale-generation.json").read_text())
    error = protocol.parse_error(body)
    assert (error.code, error.error_class) == ("stale_generation", "unknown_outcome")
    unknown = json.loads((FIXTURES / "ErrorBody" / "invalid" / "unknown-code.json").read_text())
    # errors.ts: codes are additive, and a receiver reads one it does not know as `internal`.
    assert protocol.parse_error(unknown).code == "internal"
    assert protocol.parse_error(unknown).error_class == "unknown_outcome"
    assert not ERROR_SCHEMA.is_valid(unknown)
    empty = json.loads((FIXTURES / "ErrorBody" / "invalid" / "empty-message.json").read_text())
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_error(empty)
    with pytest.raises(protocol.ProtocolError):
        protocol.parse_error({"error": {"code": "gone", "message": "x"}})


def test_readable_strips_control_characters_and_bounds_length() -> None:
    assert protocol.readable("line\nbreak\x1b[31m") == "line break [31m"
    assert protocol.readable("\n") == "no detail given"
    assert len(protocol.readable("x" * 1000)) == 300


def test_operation_ids_are_omnigents_form() -> None:
    ids = {protocol.new_operation_id() for _ in range(100)}
    assert len(ids) == 100
    assert all(protocol.is_operation_id(i) for i in ids)
    assert not protocol.is_operation_id("op_01hzy3m8k6q4t2v9w7x5r0s1n3")


# ── The rule tables match launcher.ts ───────────────────────────────────────────────────


def _ts_block(name: str) -> str:
    match = re.search(rf"export const {name}[^=]*= \{{(.*?)\n\}};", LAUNCHER_TS, re.S)
    assert match, name
    return match.group(1)


def test_constants_match_the_contract() -> None:
    def const(name: str) -> str:
        match = re.search(rf"export const {name} = ([^;]+);", LAUNCHER_TS)
        assert match, name
        return match.group(1).strip().strip('"')

    assert int(const("LAUNCHER_PROTOCOL_VERSION")) == protocol.PROTOCOL_VERSION
    assert const("LAUNCHER_SIGNING_PROTOCOL") == protocol.SIGNING_PROTOCOL
    assert const("SIGNING_KEY_ID_HEADER") == protocol.SIGNING_KEY_ID_HEADER
    assert const("TIMESTAMP_HEADER") == protocol.TIMESTAMP_HEADER
    assert const("SIGNATURE_HEADER") == protocol.SIGNATURE_HEADER
    assert int(const("MIN_SIGNING_KEY_BYTES")) == protocol.MIN_SIGNING_KEY_BYTES
    assert int(const("LAUNCHER_SIGNATURE_MAX_SKEW_S")) == protocol.SIGNATURE_MAX_SKEW_S
    assert const("MAX_LAUNCHER_BODY_BYTES") == "128 * 1024" == "128 * 1024"
    assert protocol.MAX_BODY_BYTES == 128 * 1024
    assert const("PLATFORM_INTERNAL_HOST") == protocol.PLATFORM_INTERNAL_HOST


def test_operation_rules_match_the_contract() -> None:
    block = _ts_block("LAUNCHER_OPERATIONS")
    rules = dict(
        re.findall(r"\n  (\w+): \{(.*?)\n  \}", block, re.S),
    )
    assert set(rules) == set(protocol.OPERATIONS)
    for operation, body in rules.items():
        fields = dict(re.findall(r"(\w+): \"?([\w]+)\"?,", body))
        rule = protocol.OPERATION_RULES[operation]  # type: ignore[index]
        assert fields["omnigentMethod"] == rule.omnigent_method
        assert fields["idempotency"] == rule.idempotency
        assert fields["operationIdFromOmnigent"] == str(rule.operation_id_from_omnigent).lower()
        assert fields["durabilityWait"] == str(rule.durability_wait).lower()
        assert fields["onComputer"] == str(rule.on_computer).lower()


def test_error_tables_match_the_contract() -> None:
    statuses = dict(re.findall(r"(\w+): (\d+),", _ts_block("LAUNCHER_ERROR_STATUS")))
    assert {k: int(v) for k, v in statuses.items()} == dict(protocol.ERROR_STATUS)
    classes = dict(re.findall(r'(\w+): "(\w+)",', _ts_block("LAUNCHER_ERROR_CLASS")))
    assert classes == dict(protocol.ERROR_CLASS)
    assert [code for code, cls in classes.items() if cls == "sandbox_gone"] == ["gone"]


def test_enums_match_the_contract() -> None:
    def enum(name: str) -> tuple[str, ...]:
        match = re.search(rf"export const {name} = z\.enum\(\[(.*?)\]\)", LAUNCHER_TS, re.S)
        assert match, name
        return tuple(re.findall(r'"(\w+)"', match.group(1)))

    assert enum("HostSandboxStatus") == protocol.HOST_SANDBOX_STATUSES
    assert enum("AdmissionReason") == protocol.ADMISSION_REASONS
    assert enum("CheckpointReason") == protocol.CHECKPOINT_REASONS
    assert enum("SuspendRefusal") == protocol.SUSPEND_REFUSALS
    assert enum("CheckpointRefusal") == protocol.CHECKPOINT_REFUSALS
