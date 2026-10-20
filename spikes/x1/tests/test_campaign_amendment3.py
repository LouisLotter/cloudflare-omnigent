"""campaign.py under Amendment 3: the laptop's clock at the start and end (item 2), and the
record written after every step (item 6)."""

from __future__ import annotations

import email.utils
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import campaign
import pytest
from test_scripts import MIN, Clock, fake_ports


def test_the_record_is_saved_after_every_step():
    clock = Clock(1_800_000_000_000)
    ports, current, _, _ = fake_ports(clock)
    c = campaign.run_campaign(ports, clock.now, 60 * MIN)
    names = [name for name, _ in ports.steps]
    assert names == [
        "clock-start",
        "t0",
        "deploy-start",
        "deploy",
        "deploy-start",
        "deploy",
        "end",
        "clock-end",
    ]
    by_name = dict(ports.steps)
    # Each saved record holds what was measured up to then, and no more.
    assert by_name["clock-start"]["record"]["runId"] is None
    assert by_name["t0"]["record"]["t0"] == current["t0"]
    first_deploy = [d for n, d in ports.steps if n == "deploy"][0]["record"]["deploys"]
    assert [d["target"] for d in first_deploy] == ["ui"]
    assert by_name["end"]["record"]["end"] == {"reason": "end"}
    assert "end" not in by_name["end"]["record"]["clock"]
    assert by_name["clock-end"]["record"]["clock"]["end"]["synchronized"] is True
    assert c.record()["clock"]["start"]["skewMs"] == 120.0


def test_refusals_and_a_missing_t0_are_saved_too():
    clock = Clock(1_800_000_000_000)
    ports, _, _, _ = fake_ports(clock, fingerprint={"server": ["b"]})
    campaign.run_campaign(ports, clock.now, 60 * MIN)
    assert "refused" in [name for name, _ in ports.steps]
    clock = Clock(1_800_000_000_000)
    ports, _, _, _ = fake_ports(clock, run_after=10 * 60 * MIN)
    with pytest.raises(TimeoutError):
        campaign.run_campaign(ports, clock.now, 60 * MIN)
    assert [name for name, _ in ports.steps] == ["clock-start", "no-t0"]
    assert ports.steps[-1][1]["record"]["notes"] == ["no run started within the wait for T0"]


def test_saver_writes_the_record_and_appends_the_step(tmp_path):
    save = campaign.saver(tmp_path)
    save("t0", {"at": 1, "record": {"runId": "r"}})
    save("deploy", {"at": 2, "target": "ui", "record": {"runId": "r", "deploys": [1]}})
    assert json.loads((tmp_path / "campaign.json").read_text()) == {"runId": "r", "deploys": [1]}
    steps = [
        json.loads(line) for line in (tmp_path / "campaign-steps.jsonl").read_text().splitlines()
    ]
    assert steps == [{"step": "t0", "at": 1}, {"step": "deploy", "at": 2, "target": "ui"}]
    assert not (tmp_path / "campaign.json.tmp").exists()


def test_skew_from_the_date_header():
    date = email.utils.formatdate(1_824_105_600, usegmt=True)
    server = 1_824_105_600_000 + 500  # the middle of that second
    assert campaign.skew_from_date(date, server - 100, server + 100) == 0.0
    assert campaign.skew_from_date(date, server - 3100, server - 2900) == 3000.0
    assert campaign.skew_from_date(None, 0, 0) is None
    assert campaign.skew_from_date("not a date", 0, 0) is None


def test_date_skew_against_a_local_server():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            self.send_response(200 if self.path == "/" else 404)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        for path in ("/", "/missing"):
            skew = campaign.date_skew_ms(base + path)
            assert skew is not None and -600 < skew < 600
    finally:
        server.shutdown()
    assert campaign.date_skew_ms("http://127.0.0.1:1/") is None


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (subprocess.CompletedProcess([], 0, "yes\n", ""), True),
        (subprocess.CompletedProcess([], 0, "no\n", ""), False),
        (subprocess.CompletedProcess([], 0, "maybe\n", ""), None),
        (subprocess.CompletedProcess([], 1, "", "no systemd"), None),
        (OSError("no timedatectl"), None),
    ],
)
def test_time_synchronisation_status(monkeypatch, result, expected):
    def run(*args, **kwargs):
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(campaign.subprocess, "run", run)
    assert campaign.synchronized() is expected


def test_laptop_clock_record(monkeypatch):
    monkeypatch.setattr(campaign, "synchronized", lambda: True)
    monkeypatch.setattr(campaign, "date_skew_ms", lambda url: 42.0)
    record = campaign.laptop_clock("https://example.test/")
    assert record["synchronized"] is True and record["skewMs"] == 42.0 and record["at"] > 0
