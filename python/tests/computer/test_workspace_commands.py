"""Every command WorkspaceDO sends is accepted by the supervisor's actual receiver.

The corpus is recorded from the real controller (WP3.1) by
``worker/test/unit/computer-receivers.test.ts``, which fails if it drifts; this test runs each
command through ``Contract.parse_command``, the parser the supervisor uses, schema and refinements.
"""

import json
from pathlib import Path

import pytest
from cfo_computer.contract import Contract, ContractError

ROOT = Path(__file__).resolve().parents[3]
CORPUS = json.loads((ROOT / "worker/test/fixtures/workspace-commands.json").read_text())
SENT = {
    "capture",
    "computer_status",
    "credential_snapshot",
    "finish_capture",
    "install_credentials",
    "job_status",
    "restore_workspace",
    "sign_in_cancel",
    "sign_in_input",
    "sign_in_start",
    "sign_in_status",
    "sign_out",
    "staging_check",
    "start_host",
    "status",
}


@pytest.fixture(scope="module")
def contract():
    return Contract(ROOT / "contracts" / "schema")


def test_the_corpus_covers_every_command_workspacedo_sends():
    assert {command["type"] for command in CORPUS} == SENT


@pytest.mark.parametrize(
    "command",
    CORPUS,
    ids=[f"{c['type']}-{c.get('kind') or c.get('outcome') or i}" for i, c in enumerate(CORPUS)],
)
def test_the_supervisor_accepts_each_command(contract, command):
    parsed = contract.parse_command(command)
    assert parsed["type"] == command["type"]


def test_the_supervisor_refuses_a_command_for_another_computers_bundle(contract):
    install = next(c for c in CORPUS if c["type"] == "install_credentials" and c["bundle"])
    other = json.loads(json.dumps(install))
    other["bundle"]["computerId"] = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4"
    with pytest.raises(ContractError):
        contract.parse_command(other)
