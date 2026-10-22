"""3.C's cross-language test vectors, from Python: the launcher API's HMAC envelope, the tree
index's digest and the checkpoint policy's decisions. The TypeScript side checks the same files,
so the Cloudflare launcher (WP3.6) and the supervisor (WP3.4) are held to the same bytes."""

import hashlib
import hmac
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CONTRACTS = ROOT / "contracts"


def _load(path: str) -> dict:
    return json.loads((CONTRACTS / path).read_text())


SIGNING = _load("vectors/launcher-signing-v1.json")


@pytest.mark.parametrize("case", SIGNING["cases"], ids=lambda c: c["operation"])
def test_launcher_signature(case: dict) -> None:
    body = case["body"].encode()
    lines = [
        "cfo-launcher-v1",
        case["operation"],
        case["keyId"],
        str(case["timestamp"]),
        hashlib.sha256(body).hexdigest(),
    ]
    string_to_sign = "\n".join(lines)
    assert string_to_sign == case["stringToSign"]
    signature = hmac.new(
        SIGNING["key"].encode(), string_to_sign.encode(), hashlib.sha256
    ).hexdigest()
    assert case["headers"] == {
        "X-Omnigent-Signing-Key-Id": case["keyId"],
        "X-Omnigent-Timestamp": str(case["timestamp"]),
        "X-Omnigent-Signature": signature,
    }
    # The launcher sends compact JSON with sorted keys.
    parsed = json.loads(case["body"])
    assert json.dumps(parsed, sort_keys=True, separators=(",", ":")) == case["body"]


def _canonical(entries: list[dict]) -> bytes:
    out = []
    for e in sorted(entries, key=lambda e: e["path"].encode()):
        if e["type"] == "file":
            fields = [
                "F",
                e["path"],
                f"{e['mode']:04o}",
                e["uid"],
                e["gid"],
                e["size"],
                e["sha256"],
            ]
        elif e["type"] == "dir":
            fields = ["D", e["path"], f"{e['mode']:04o}", e["uid"], e["gid"]]
        else:
            fields = ["L", e["path"], e["uid"], e["gid"], e["target"]]
        out.append("".join(f"{f}\0" for f in fields))
    return "".join(out).encode()


@pytest.mark.parametrize(
    "case", _load("vectors/tree-digest-v1.json")["cases"], ids=lambda c: c["name"]
)
def test_tree_digest(case: dict) -> None:
    assert hashlib.sha256(_canonical(case["entries"])).hexdigest() == case["treeDigest"]


def test_base_layer_fixture_digest() -> None:
    base = _load("fixtures/LayerIndex/base.json")
    assert hashlib.sha256(_canonical(base["entries"])).hexdigest() == base["treeDigest"]


def _glob(pattern: str) -> re.Pattern[str]:
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z", re.S)


POLICY = _load("fixtures/CheckpointPolicy/v1.json")


def _decide(path: str, tmp_rel: str | None) -> tuple[str, str]:
    for rule in POLICY["rules"]:
        target = path
        if rule["root"] == "tmp":
            if tmp_rel is None or not (path == tmp_rel or path.startswith(tmp_rel + "/")):
                continue
            target = path[len(tmp_rel) + 1 :]
        if any(_glob(p).match(target) for p in rule["patterns"]):
            return rule["action"], rule["id"]
    return "unclassified", "none"


@pytest.mark.parametrize(
    "case", _load("vectors/checkpoint-policy-v1.json")["cases"], ids=lambda c: c["path"]
)
def test_checkpoint_policy_decision(case: dict) -> None:
    assert _decide(case["path"], case.get("tmpRel")) == (case["action"], case["rule"])
