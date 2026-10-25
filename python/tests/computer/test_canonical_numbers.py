"""All accepted integer spellings produce the same canonical tree bytes."""

import copy
import json
import stat
from pathlib import Path

import pytest
from cfo_computer.contract import Contract, ContractError
from cfo_computer.tree import canonical_tree_bytes, tree_digest

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


@pytest.mark.parametrize(
    "case", json.loads((CONTRACTS / "vectors/tree-digest-v1.json").read_text())["cases"]
)
def test_real_canonicalizer_matches_fixed_golden_vectors(case):
    assert tree_digest(case["entries"]) == case["treeDigest"]


@pytest.fixture
def index():
    return json.loads((CONTRACTS / "fixtures/LayerIndex/base.json").read_text())


@pytest.mark.parametrize("field", ["mode", "uid", "gid", "size"])
@pytest.mark.parametrize("spelling", ["0.0", "-0.0", "1.0", "1e0", "1E+3", "1.000e2"])
def test_equivalent_integer_spellings(index, field, spelling):
    value = json.loads(spelling)
    expected = copy.deepcopy(index)
    index["entries"][1][field] = value
    expected["entries"][1][field] = int(value)
    parsed = Contract(CONTRACTS / "schema").parse_layer_index(index)
    actual = canonical_tree_bytes(parsed["entries"])
    assert actual == canonical_tree_bytes(expected["entries"])
    assert tree_digest(parsed["entries"]) == tree_digest(expected["entries"])


@pytest.mark.parametrize("kind", ["dir", "symlink"])
def test_non_file_integer_fields(kind):
    e = {"path": "work/a", "type": kind, "uid": 1.0, "gid": -0.0}
    if kind == "dir":
        e["mode"] = 493.0
    else:
        e["target"] = "../b"
    # Explicit fields avoid deriving the oracle from the implementation.
    fields = (
        ["D", "work/a", "0755", "1", "0"] if kind == "dir" else ["L", "work/a", "1", "0", "../b"]
    )
    expected = ("\0".join(fields) + "\0").encode()
    assert canonical_tree_bytes([e]) == expected


@pytest.mark.parametrize(
    "field,maximum", [("mode", 4095), ("uid", 2**32 - 1), ("gid", 2**32 - 1), ("size", 2**53 - 1)]
)
def test_exact_maximum(index, field, maximum):
    index["entries"][1][field] = float(maximum)
    parsed = Contract(CONTRACTS / "schema").parse_layer_index(index)
    expected = copy.deepcopy(parsed)
    expected["entries"][1][field] = maximum
    assert canonical_tree_bytes(parsed["entries"]) == canonical_tree_bytes(expected["entries"])


def test_parser_normalizes_for_filesystem_consumers_without_mutation(index, tmp_path):
    for entry in index["entries"]:
        for key in ("mode", "uid", "gid", "size"):
            if key in entry:
                entry[key] = float(entry[key])
    index["generation"] = float(index["generation"])
    index["formatVersion"] = float(index["formatVersion"])
    before = copy.deepcopy(index)
    parsed = Contract(CONTRACTS / "schema").parse_layer_index(index)
    for entry in parsed["entries"]:
        for key in ("mode", "uid", "gid", "size"):
            if key in entry:
                assert type(entry[key]) is int
    assert type(parsed["generation"]) is int
    assert type(parsed["formatVersion"]) is int
    source = tmp_path / "file"
    source.touch()
    source.chmod(parsed["entries"][1]["mode"])
    assert stat.S_IMODE(source.stat().st_mode) == 0o644
    assert index == before
    assert type(index["entries"][1]["mode"]) is float


@pytest.mark.parametrize(
    "field,maximum", [("mode", 4095), ("uid", 2**32 - 1), ("gid", 2**32 - 1), ("size", 2**53 - 1)]
)
@pytest.mark.parametrize(
    "bad", [True, False, 1.5, -1, float("nan"), float("inf"), "1", None, "over"]
)
def test_invalid_numbers_refused_before_canonical_output(index, field, maximum, bad):
    index["entries"][1][field] = maximum + 1 if bad == "over" else bad
    with pytest.raises(ContractError):
        Contract(CONTRACTS / "schema").parse_layer_index(index)
    with pytest.raises(ValueError):
        canonical_tree_bytes(index["entries"])
