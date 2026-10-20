"""The laptop scripts with their Cloudflare calls faked: redaction, deploy-log reading, the
campaign's timing and refusals, collection and the teardown check. Synthetic values only."""

from __future__ import annotations

import io
import json
import os

import campaign
import collect
import deploylog
import pytest
import redact
import teardown_check

ACCOUNT = "c" * 32  # synthetic: 32 hex digits, like an account ID
CONFIG = {
    "accountId": ACCOUNT,
    "ownerEmail": "owner@example.test",
    "zone": "example.test",
    "identityProviderId": "11111111-2222-4333-8444-555555555555",
}


# ---------------------------------------------------------------------------------------------
# redact.py


def test_redact_replaces_every_kind():
    secrets = redact.secrets_from(CONFIG, "/home/someone")
    text = (
        f"registry.cloudflare.com/{ACCOUNT}/cfo-stg-x1-transport-server@sha256:{'d' * 64} "
        "https://cfo-stg-x1-ui.example.test owner@example.test other@elsewhere.test "
        f"{'A1' * 16} 0f0f0f0f-0000-4000-8000-000000000000 /home/someone/x {CONFIG['identityProviderId']}"
    )
    out = redact.redact_text(text, secrets)
    assert ACCOUNT not in out and "example.test" not in out and not redact.EMAIL.search(out)
    assert "<account>" in out and "<zone>" in out and "<owner-email>" in out and "<email>" in out
    assert "<hex32>" in out and "<uuid>" in out and "~/x" in out and "<idp>" in out
    assert f"sha256:{'d' * 64}" in out  # digests stay
    assert redact.leftovers(out, secrets) == []


def test_redact_tree_copies_and_verifies(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    (src / "probe").mkdir(parents=True)
    (src / "probe" / "batch-000001.jsonl").write_text(
        f'{{"host":"cfo-stg-x1-transport.example.test","a":"{ACCOUNT}"}}\n'
    )
    (src / f"{ACCOUNT}.json").write_text("{}")
    secrets = redact.secrets_from(CONFIG)
    assert redact.redact_tree(src, dst, secrets) == []
    assert (dst / "<account>.json").exists()
    assert "<zone>" in (dst / "probe" / "batch-000001.jsonl").read_text()


def test_redact_tree_fails_on_a_survivor(tmp_path, monkeypatch):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    (src / "a.txt").write_text("fine")
    monkeypatch.setattr(
        redact, "leftovers", lambda text, secrets: ["<owner-email>", "an email address"]
    )
    problems = redact.redact_tree(src, dst, redact.secrets_from(CONFIG))
    assert problems == ["a.txt: <owner-email>, an email address"]


def test_redact_command_line(tmp_path, monkeypatch, capsys):
    config = tmp_path / "config.json"
    config.write_text(json.dumps(CONFIG))
    monkeypatch.setattr("sys.stdin", io.StringIO(f"x {ACCOUNT} y\n"))
    assert redact.main([str(config), "-"]) == 0
    assert capsys.readouterr().out == "x <account> y\n"
    src = tmp_path / "src"
    src.mkdir()
    (src / "f").write_text("ok")
    assert redact.main([str(config), str(src), str(tmp_path / "dst")]) == 0
    assert redact.main([str(config)]) == 2


# ---------------------------------------------------------------------------------------------
# deploylog.py


def stamped(lines: list[str], start: int = 1_792_000_000_000) -> list[str]:
    return [f"{start + i * 100} {line}" for i, line in enumerate(lines)]


QUIET_TRANSPORT = [
    "Building image cfo-stg-x1-transport-server:wrangler-1",
    "Image already exists remotely, skipping push",
    "├ Preparing computer for Cloudflare Containers",
    "Total Upload: 36.34 KiB / gzip: 9.73 KiB",
    "Uploaded cfo-stg-x1-transport (7.46 sec)",
    "Image already exists remotely, skipping push",
    "╭ Deploy a container application deploy changes to your application",
    "│ Container application changes",
    "├ no changes cfo-stg-x1-transport-server",
    "╰ No changes to be made",
    "Deployed cfo-stg-x1-transport triggers (4.28 sec)",
]


def test_quiet_transport_deploy():
    parsed = deploylog.parse(stamped(QUIET_TRANSPORT), "transport")
    assert parsed == {
        "uploaded": 1_792_000_000_400,
        "rollout": False,
        "evidence": [],
        "imagesAlreadyPresent": 2,
    }


def test_rollout_by_application_change_or_push():
    changed = QUIET_TRANSPORT[:8] + [
        "├ EDIT cfo-stg-x1-transport-server",
        "│   image changed",
        "╰ Applied",
    ]
    parsed = deploylog.parse(stamped(changed), "transport")
    assert parsed["rollout"] and parsed["evidence"] == [
        "container application change: EDIT cfo-stg-x1-transport-server"
    ]
    pushed = [
        line.replace(
            "Image already exists remotely, skipping push", "The push refers to repository [x]"
        )
        for line in QUIET_TRANSPORT
    ]
    assert deploylog.parse(stamped(pushed), "transport")["rollout"]


def test_missing_image_report_is_rollout_evidence_and_ui_needs_none():
    silent = [line for line in QUIET_TRANSPORT if "skipping push" not in line]
    assert deploylog.parse(stamped(silent), "transport")["evidence"] == [
        "only 0 of 2 images reported as already present"
    ]
    ui = deploylog.parse(stamped(["Total Upload: 5 KiB", "Uploaded cfo-stg-x1-ui (1.2 sec)"]), "ui")
    assert ui["rollout"] is False and ui["uploaded"] == 1_792_000_000_100
    assert deploylog.parse(["not stamped", ""], "ui")["uploaded"] is None


def test_deploylog_command_line(tmp_path, capsys):
    log = tmp_path / "d.log"
    log.write_text("\n".join(stamped(QUIET_TRANSPORT)))
    assert deploylog.main([str(log), "transport"]) == 0
    assert json.loads(capsys.readouterr().out)["rollout"] is False
    assert deploylog.main([]) == 2


# ---------------------------------------------------------------------------------------------
# campaign.py

MIN = 60_000


class Clock:
    def __init__(self, now: int) -> None:
        self.now = now
        self.sleeps = 0

    def sleep(self, seconds: float) -> None:
        self.sleeps += 1
        self.now += int(seconds * 1000)


def fake_ports(
    clock: Clock,
    *,
    fingerprint=None,
    created="2027-01-15T07:00:00.000Z",
    rollout_on=(),
    run_after=60_000,
    end_after=0,
):
    started = clock.now
    t0 = started + run_after
    current = {
        "runId": "run-20270115T080000Z",
        "mode": "run",
        "status": "active",
        "t0": t0,
        "soakStart": t0 + 5 * MIN,
        "soakEnd": t0 + 125 * MIN,
    }
    calls: list[tuple[str, int]] = []
    said: list[str] = []
    last = {
        "target": "transport",
        "status": 0,
        "fingerprint": {"server": ["a"]},
        "recordCreatedAt": "2027-01-15T07:00:00.000Z",
    }

    def get_object(key: str):
        calls.append((key, clock.now))
        if key == "runs/current.json":
            if clock.now < t0:
                return {**current, "mode": "preflight", "t0": t0 - 30 * MIN, "status": "ended"}
            return current
        if key.endswith("end.json") and clock.now >= current["soakEnd"] + end_after:
            return {"reason": "end"}
        return None

    def deploy(target: str, label: str):
        calls.append((f"deploy:{target}", clock.now))
        start = clock.now
        clock.now += 40_000
        return {
            "target": target,
            "build": label,
            "start": start,
            "end": clock.now,
            "status": 0,
            "parsed": {
                "uploaded": start + 20_000,
                "rollout": target in rollout_on,
                "evidence": ["x"] if target in rollout_on else [],
            },
        }

    steps: list[tuple[str, dict]] = []
    ports = campaign.Ports(
        now_ms=lambda: clock.now,
        sleep=clock.sleep,
        get_object=get_object,
        deploy=deploy,
        fingerprint=lambda: fingerprint or {"server": ["a"]},
        record_created_at=lambda: created,
        last_transport=lambda: last,
        clock=lambda: {"at": clock.now, "synchronized": True, "skewMs": 120.0},
        save=lambda name, detail: steps.append((name, json.loads(json.dumps(detail)))),
        say=said.append,
    )
    ports.steps = steps  # type: ignore[attr-defined]
    return ports, current, calls, said


def test_campaign_deploys_at_s45_and_s75_and_waits_for_the_end():
    clock = Clock(1_800_000_000_000)
    ports, current, calls, said = fake_ports(clock)
    c = campaign.run_campaign(ports, clock.now, 60 * MIN)
    deploys = [(k, t) for k, t in calls if k.startswith("deploy:")]
    s = current["soakStart"]
    assert deploys == [("deploy:ui", s + 45 * MIN), ("deploy:transport", s + 75 * MIN)]
    assert [d["target"] for d in c.deploys] == ["ui", "transport"]
    assert c.deploys[0]["uploaded"] == s + 45 * MIN + 20_000 and c.deploys[0]["rollout"] is False
    assert c.end == {"reason": "end"} and c.refused == [] and c.notes == []
    record = c.record()
    assert record["runId"] == current["runId"] and record["t0"] == current["t0"]
    # Amendment 1, item 7: without a tailEnd in the pointer, the tail is 60 s past the soak.
    assert record["tailEnd"] == current["soakEnd"] + 60_000
    assert said[0].startswith("T0 ")


def test_campaign_ignores_an_old_preflight_pointer_then_times_out():
    clock = Clock(1_800_000_000_000)
    ports, *_ = fake_ports(clock, run_after=10 * 60 * MIN)
    with pytest.raises(TimeoutError):
        campaign.run_campaign(ports, clock.now, 60 * MIN)


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"fingerprint": {"server": ["b"]}}, "layers differ"),
        ({"created": "2027-01-16T00:00:00.000Z"}, "build epoch changed"),
    ],
)
def test_campaign_refuses_a_transport_deploy_that_would_roll_out(kwargs, reason):
    clock = Clock(1_800_000_000_000)
    ports, _, calls, said = fake_ports(clock, **kwargs)
    c = campaign.run_campaign(ports, clock.now, 60 * MIN)
    assert [k for k, _ in calls if k.startswith("deploy:")] == ["deploy:ui"]
    assert c.refused and reason in c.refused[0]["reasons"][0]
    assert any("REFUSED" in s for s in said)


def test_campaign_refuses_without_an_earlier_fingerprint_and_records_rollouts():
    clock = Clock(1_800_000_000_000)
    ports, *_ = fake_ports(clock, rollout_on=("ui",))
    ports.last_transport = lambda: None
    c = campaign.run_campaign(ports, clock.now, 60 * MIN)
    assert "no earlier transport deploy" in c.refused[0]["reasons"][0]
    assert c.deploys[0]["rollout"] is True


def test_campaign_notes_a_late_deploy_a_missing_record_and_a_missing_end():
    clock = Clock(1_800_000_000_000)
    ports, current, *_ = fake_ports(clock, end_after=10**9)
    real_sleep = clock.sleep

    def lagging(seconds: float) -> None:
        real_sleep(seconds)
        if current["soakStart"] + 45 * MIN - 30_000 <= clock.now < current["soakStart"] + 45 * MIN:
            clock.now += 2 * MIN  # the laptop slept through the planned time

    ports.sleep = lagging
    deploy = ports.deploy
    ports.deploy = lambda target, label: None if target == "transport" else deploy(target, label)
    c = campaign.run_campaign(ports, clock.now, 60 * MIN)
    assert any("ui deploy started" in n and "late" in n for n in c.notes)
    assert "the transport deploy left no record" in c.notes
    assert "no end.json within 15 minutes of the recovery tail's end" in c.notes


def test_campaign_helpers(tmp_path, monkeypatch):
    assert campaign.read_jsonl(tmp_path / "none.jsonl") == []
    (tmp_path / "d.jsonl").write_text('{"a":1}\n\n{"a":2}\n')
    assert campaign.read_jsonl(tmp_path / "d.jsonl") == [{"a": 1}, {"a": 2}]
    monkeypatch.setenv("CFO_STAGING_DIR", str(tmp_path))
    assert campaign.staging_dir() == tmp_path
    assert campaign.wrangler().endswith("worker/node_modules/.bin/wrangler")


# ---------------------------------------------------------------------------------------------
# collect.py


def test_collect_pages_and_writes_the_layout(tmp_path):
    prefix = "runs/run-20270115T080000Z/"
    keys = [f"{prefix}probe/g1-0a1b2c3d-00a1b2/batch-{n:06d}.jsonl" for n in range(1, 4)] + [
        f"{prefix}run.json"
    ]
    calls = []

    def run(args):
        calls.append(args)
        if args[:3] == ["r2", "objects", "list"]:
            after = args[args.index("--start-after") + 1] if "--start-after" in args else None
            rest = keys[keys.index(after) + 1 :] if after else keys
            return 0, json.dumps({"result": [{"key": k} for k in rest[:2]]}).encode(), ""
        return 0, f"body of {args[3]}".encode(), ""

    collect.PAGE = 2
    try:
        assert collect.collect(run, "run-20270115T080000Z", tmp_path) == 4
    finally:
        collect.PAGE = 1000
    assert (tmp_path / "run.json").read_text() == f"body of {prefix}run.json"
    assert (tmp_path / "probe" / "g1-0a1b2c3d-00a1b2" / "batch-000003.jsonl").exists()
    assert all(c[0] == "r2" and c[2] in ("list", "get") for c in calls)


def test_collect_refuses_bad_ids_keys_and_failures(tmp_path):
    with pytest.raises(ValueError):
        collect.collect(lambda a: (0, b"[]", ""), "../etc", tmp_path)
    with pytest.raises(ValueError):
        collect.local_path(tmp_path, "runs/x/", "runs/x/../../etc/passwd")
    with pytest.raises(ValueError):
        collect.local_path(tmp_path, "runs/x/", "runs/y/a")
    with pytest.raises(RuntimeError):
        collect.list_keys(lambda a: (1, b"", "denied"), "runs/x/")
    with pytest.raises(ValueError):
        collect.listing(b'{"result": "nope"}')
    assert collect.listing(b'{"result": {"objects": [{"key": "a"}, {"x": 1}]}}') == ["a"]
    assert collect.listing(b'[{"key": "b"}]') == ["b"]

    def failing_get(args):
        if args[2] == "list":
            return 0, json.dumps([{"key": "runs/run-20270115T080000Z/run.json"}]).encode(), ""
        return 1, b"", "boom"

    with pytest.raises(RuntimeError):
        collect.collect(failing_get, "run-20270115T080000Z", tmp_path)


# ---------------------------------------------------------------------------------------------
# teardown_check.py


def test_teardown_check_all_gone_and_something_left():
    def gone(args):
        if args[:2] in (["workers", "get"],):
            return 1, None, "[10007] 404 Not Found"
        if args[:3] == ["r2", "buckets", "get"]:
            return 1, None, "[10006] 404 Not Found"
        return 0, [], ""

    results = teardown_check.checks(gone, "example.test", [], lambda url: "URLError")
    assert results and all(ok for _, ok in results)

    def left(args):
        if args[:2] == ["tunnels", "list"]:
            return 0, [{"name": "cfo-stg-x1-transport"}], ""
        return gone(args)

    results = teardown_check.checks(left, "example.test", ["cfo-stg-x1-ui"], lambda url: "HTTP 200")
    failed = [what for what, ok in results if not ok]
    assert "no live Tunnel cfo-stg-x1-…" in failed
    assert "no staging registry record for cfo-stg-x1-ui" in failed
    assert any(f.startswith("https://") for f in failed)
    assert teardown_check.names("x") == []


def test_staging_dir_defaults(monkeypatch, tmp_path):
    monkeypatch.delenv("CFO_STAGING_DIR", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    for module in (campaign, collect, teardown_check):
        assert module.staging_dir() == tmp_path / "cloudflare-omnigent" / "staging"
    assert os.path.basename(str(campaign.X1)) == "x1"
