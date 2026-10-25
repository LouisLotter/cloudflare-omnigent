"""Receiver refinements use the wire contract's JavaScript length semantics."""

import copy
import json
from pathlib import Path

import pytest
from cfo_computer.contract import Contract, ContractError

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
LIMIT = 64 * 1024


@pytest.fixture
def contract():
    return Contract(CONTRACTS / "schema")


def start_command(config):
    value = json.loads((CONTRACTS / "fixtures/WorkspaceCommand/start-host.json").read_text())
    value["hostConfig"] = config
    return value


# These are JSON.stringify(value).length, not UTF-8 bytes or Python's JSON text length.
@pytest.mark.parametrize(
    "value,units",
    [
        ("a", 3),
        ("é", 3),
        ("😀", 4),
        ("\ud800", 8),
        ("\udc00", 8),
        ("\ud800\udc00", 4),
        ("\n", 4),
        ("\0", 8),
        ('"\\', 6),
        (None, 4),
        (True, 4),
        (False, 5),
        (1.0, 1),
        (-0.0, 1),
        (1e20, 21),
        (1e21, 5),
        (1e-6, 8),
        (1e-7, 4),
        (5e-324, 6),
        ([1.0, "😀", None], 13),
        ({"😀": 1.0}, 8),
    ],
)
@pytest.mark.parametrize("delta", [-1, 0, 1])
def test_serialized_host_config_boundary(contract, value, units, delta):
    # {"value":VALUE,"pad":""} contributes 19 units apart from VALUE.
    config = {"value": value, "pad": "a" * (LIMIT + delta - 19 - units)}
    command = start_command(config)
    before = copy.deepcopy(command)
    if delta <= 0:
        assert contract.parse_command(command)["hostConfig"] == config
    else:
        with pytest.raises(ContractError) as error:
            contract.parse_command(command)
        assert error.value.code == "bad_request"
    assert command == before


def test_nested_config_size_counts_contents(contract):
    with pytest.raises(ContractError):
        contract.parse_command(start_command({"runner": {"args": ["a" * LIMIT]}}))


def test_launcher_shaped_config_roundtrips(contract):
    config = {"runner": {"idle_timeout_s": 600}, "features": [True, None], "name": "é😀"}
    assert contract.parse_command(start_command(config))["hostConfig"] == config


def test_top_level_proto_is_stripped_before_limit_like_zod(contract):
    config = {"__proto__": "x" * LIMIT, "runner": {"idle_timeout_s": 600}}
    command = start_command(config)
    parsed = contract.parse_command(command)
    assert parsed["hostConfig"] == {"runner": {"idle_timeout_s": 600}}
    assert "__proto__" in command["hostConfig"]  # input is not mutated


def test_nested_proto_is_retained_and_counted(contract):
    config = {"nested": {"__proto__": "small"}}
    assert contract.parse_command(start_command(config))["hostConfig"] == config
    with pytest.raises(ContractError):
        contract.parse_command(start_command({"nested": {"__proto__": "x" * LIMIT}}))


@pytest.mark.parametrize("bad", [b"not-json", (1, 2), {1, 2}, object()])
def test_non_json_python_values_refused(contract, bad):
    with pytest.raises(ContractError) as error:
        contract.parse_command(start_command({"nested": [bad]}))
    assert error.value.code == "bad_request"


def test_excessive_nesting_is_a_contract_error(contract):
    config = {}
    for _ in range(1100):
        config = {"child": config}
    with pytest.raises(ContractError):
        contract.parse_command(start_command(config))
