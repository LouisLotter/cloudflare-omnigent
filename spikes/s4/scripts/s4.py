"""S4 spike driver: Litestream and the durability barrier, on real Omnigent routes.

Run from the repository root (needs Docker and uv):

    uv run --no-project --with httpx==0.28.1 --with boto3==1.40.0 \
        spikes/s4/scripts/s4.py <command> [options]

Commands are listed by ``--help``. Every command writes its raw results to
``spikes/s4/results/``. Secrets are generated at run time into
``spikes/s4/.run/s4.env`` (git-ignored) and are never written to results.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from typing import Any

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

import s4lib  # noqa: E402
from s4lib import Omni, Stack, barrier_events, load_env, ms, now, pct, save_result  # noqa: E402


def stamp() -> str:
    return time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())


def build(_args: argparse.Namespace) -> None:
    st = Stack()
    r = st.compose("build", "server", timeout=1800)
    print(r.stdout[-2000:], r.stderr[-2000:])
    digest = st.docker("image", "inspect", "cfo-s4/server:dev", "--format", "{{.Id}}").stdout.strip()
    base = st.docker("image", "inspect", "cfo-s4/omnigent-server:90a9bed9a", "--format", "{{.Id}}").stdout.strip()
    ver = st.docker("run", "--rm", "--entrypoint", "litestream", "cfo-s4/server:dev", "version").stdout.strip()
    save_result("images.json", {"server_image": digest, "omnigent_base_image": base,
                                "omnigent_commit": "90a9bed9a5e25b1cab8d06a7e361c86cd5460918",
                                "litestream": ver})
    print(digest, base, ver)


def down(_args: argparse.Namespace) -> None:
    st = Stack()
    print(st.compose("down", "-v", "--remove-orphans", check=False).stderr[-500:])


# ── a session with the server: credentials and current password ─────────


class Session:
    def __init__(self, st: Stack) -> None:
        self.st = st
        env = load_env()
        self.user = env["S4_ADMIN_USER"]
        self.password = env["S4_ADMIN_PASSWORD"]
        self.omni = Omni()

    def fresh_login(self) -> tuple[str, str]:
        """Return (refresh_token, access_token) after a settled login."""
        rep = self.omni.login(self.user, self.password)
        assert rep.status == 200 and rep.body.get("refresh_token"), rep.summary()
        rt = rep.body["refresh_token"]
        at = self.omni.access(rt)
        assert at, "refresh after login failed"
        return rt, at

    def bearer(self, rt: str | None) -> str:
        if rt:
            at = self.omni.access(rt)
            if at:
                return at
        rep = self.omni.login(self.user, self.password, refresh=False)
        assert rep.status == 200, rep.summary()
        return rep.body["token"]


def smoke(_args: argparse.Namespace) -> None:
    st = Stack({"S4_REPLICA_PATH": f"smoke-{stamp()}"})
    st.up_infra()
    st.server_rm()
    print("start", st.server_start())
    s = Session(st)
    rt, at = s.fresh_login()
    aid = s.omni.agent_id(at)
    rep = s.omni.create_schedule(at, "s4-smoke", aid)
    print("create", rep.summary(), rep.body.get("id") if isinstance(rep.body, dict) else rep.body)
    sid = rep.body["id"]
    print("patch", s.omni.patch_schedule(at, sid, name="s4-smoke-2", state="paused").summary())
    print("get", s.omni.schedule(at, sid).body)
    print("lspos", st.lspos(5))
    ev = barrier_events(st.server_logs())
    print(json.dumps(ev, indent=1)[:3000])


# ── helpers for fault runs ────────────────────────────────────────────────


def restart_info(info: dict[str, Any]) -> dict[str, Any]:
    """Summarise a replacement: health time, Litestream restore time, barrier events."""
    logs = info.pop("previous_logs", "")
    out = {k: v for k, v in info.items()}
    out["killed_container_barrier"] = [e for e in barrier_events(logs) if e.get("event") == "barrier"][-1:]
    return out


def restore_window(st: Stack) -> dict[str, Any]:
    """Litestream's own restore timestamps in the current container."""
    logs = st.server_logs()
    t = {}
    for line in logs.splitlines():
        for key, needle in (("attempt", "attempting restore before replication"),
                            ("done", "restore completed"), ("fresh", "no backup found"),
                            ("failed", "restore failed")):
            if needle in line and key not in t:
                i = line.find("time=")
                if i >= 0:
                    t[key] = line[i + 5:i + 5 + 24]
    out: dict[str, Any] = {"events": sorted(t)}
    if "attempt" in t and "done" in t:
        from datetime import datetime

        f = "%Y-%m-%dT%H:%M:%S.%f"
        a = datetime.strptime(t["attempt"].rstrip("Z")[:26], f)
        d = datetime.strptime(t["done"].rstrip("Z")[:26], f)
        out["restore_s"] = round((d - a).total_seconds(), 3)
    return out


def kill_replace(st: Stack, t_ack: float | None = None, cid: str | None = None) -> dict[str, Any]:
    """SIGKILL the server, then start a fresh container that restores from the replica."""
    out: dict[str, Any] = {}
    out["kill_cmd_ms"] = ms(st.server_kill(cid=cid))
    if t_ack is not None:
        out["kill_done_after_ack_ms"] = ms(now() - t_ack)
    out.update(restart_info(st.server_replace()))
    out["restore"] = restore_window(st)
    return out


def settle(st: Stack) -> dict[str, Any]:
    return st.lspos(wait_caught_up=30)


# ── criteria 1 and 2: the four routes, each acknowledged then killed ──────


def routes(args: argparse.Namespace) -> None:
    mode = args.mode
    tag = f"routes-{mode}-{stamp()}"
    st = Stack({"S4_REPLICA_PATH": tag, "S4_BARRIER_MODE": mode,
                "S4_SYNC_INTERVAL": args.sync_interval})
    st.up_infra()
    st.server_rm()
    boot = st.server_start()
    s = Session(st)
    rounds = []
    for i in range(args.rounds):
        rec: dict[str, Any] = {"round": i}
        rt0, at0 = s.fresh_login()
        aid = s.omni.agent_id(at0)
        settle(st)

        def step(name: str, act, verify) -> None:  # noqa: ANN001
            cid = st.server_id()
            rep = act()
            t_ack = now()
            acked = rep.status in (200, 204)
            k = kill_replace(st, t_ack, cid)
            ok, details = verify()
            rec[name] = {"ack": rep.summary(), "acked": acked, "survived": ok,
                         "verify": details, "restart": k}

        # 1. login with refresh issuance
        holder: dict[str, Any] = {}

        def act_login():  # noqa: ANN202
            rep = s.omni.login(s.user, s.password)
            holder["rt1"] = rep.body.get("refresh_token") if isinstance(rep.body, dict) else None
            return rep

        def verify_login():  # noqa: ANN202
            rt1 = holder.get("rt1")
            rep = s.omni.refresh(rt1) if rt1 else None
            return bool(rep and rep.status == 200), {"refresh": rep.summary() if rep else None}

        step("login_refresh", act_login, verify_login)

        # 2. schedule create
        at = s.bearer(rt0)
        name = f"s4-task-{i}-{secrets.token_hex(3)}"

        def act_create():  # noqa: ANN202
            rep = s.omni.create_schedule(at, name, aid)
            holder["sid"] = rep.body.get("id") if isinstance(rep.body, dict) else None
            return rep

        def verify_create():  # noqa: ANN202
            sid = holder.get("sid")
            rep = s.omni.schedule(s.bearer(rt0), sid) if sid else None
            ok = bool(rep and rep.status == 200 and rep.body.get("name") == name)
            return ok, {"get": rep.summary() if rep else None}

        step("schedule_create", act_create, verify_create)

        # 3. schedule edit (on a settled task)
        at = s.bearer(rt0)
        if not holder.get("sid") or s.omni.schedule(at, holder["sid"]).status != 200:
            holder["sid"] = s.omni.create_schedule(at, name, aid).body["id"]
        settle(st)
        new_name, new_rrule = f"{name}-edited", "FREQ=DAILY;BYHOUR=5"

        def act_edit():  # noqa: ANN202
            return s.omni.patch_schedule(s.bearer(rt0), holder["sid"], name=new_name, rrule=new_rrule)

        def verify_edit():  # noqa: ANN202
            rep = s.omni.schedule(s.bearer(rt0), holder["sid"])
            b = rep.body if isinstance(rep.body, dict) else {}
            return (rep.status == 200 and b.get("name") == new_name and b.get("rrule") == new_rrule), \
                {"get": rep.summary(), "name_matches": b.get("name") == new_name,
                 "rrule_matches": b.get("rrule") == new_rrule}

        step("schedule_edit", act_edit, verify_edit)

        # 4. grant revocation (of a settled, working grant)
        rt_rev, _ = s.fresh_login()
        settle(st)

        def act_revoke():  # noqa: ANN202
            return s.omni.revoke(rt_rev)

        def verify_revoke():  # noqa: ANN202
            rep = s.omni.refresh(rt_rev)
            return rep.status != 200, {"refresh_after": rep.summary()}

        step("grant_revoke", act_revoke, verify_revoke)

        # 5. password change, which also rotates the account generation
        rt_pc, at_pc = s.fresh_login()
        settle(st)
        old, new = s.password, secrets.token_urlsafe(18)
        s4lib.remember_secret(new)

        def act_pw():  # noqa: ANN202
            return s.omni.change_password(at_pc, old, new)

        def verify_pw():  # noqa: ANN202
            new_ok = s.omni.login(s.user, new, refresh=False)
            old_ok = s.omni.login(s.user, old, refresh=False)
            grant = s.omni.refresh(rt_pc)
            ok = new_ok.status == 200 and old_ok.status == 401 and grant.status != 200
            s.password = new if new_ok.status == 200 else old
            return ok, {"login_new": new_ok.status, "login_old": old_ok.status,
                        "old_grant_refresh": grant.status}

        step("password_change", act_pw, verify_pw)
        rounds.append(rec)
        print(json.dumps({k: (v.get("acked"), v.get("survived")) if isinstance(v, dict) else v
                          for k, v in rec.items()}))
    steps = ["login_refresh", "schedule_create", "schedule_edit", "grant_revoke", "password_change"]
    summary = {st_: {"acked": sum(1 for r in rounds if r[st_]["acked"]),
                     "survived_of_acked": sum(1 for r in rounds if r[st_]["acked"] and r[st_]["survived"]),
                     "ack_ms_p50": pct([r[st_]["ack"]["ms"] for r in rounds], 0.5),
                     "ack_ms_max": pct([r[st_]["ack"]["ms"] for r in rounds], 1.0)}
               for st_ in steps}
    health = [r[x]["restart"]["health_s"] for r in rounds for x in steps if r[x]["restart"].get("health_s")]
    summary["replace_to_health_s"] = {"p50": pct(health, 0.5), "max": pct(health, 1.0), "n": len(health)}
    out = {"scenario": "routes", "mode": mode, "sync_interval": args.sync_interval,
           "replica_path": tag, "first_boot": boot, "summary": summary, "rounds": rounds}
    p = save_result(f"{tag}.json", out)
    print(json.dumps(summary, indent=1))
    print("saved", p)


# ── the loss window without the barrier ──────────────────────────────────


def window(args: argparse.Namespace) -> None:
    """Without the barrier: ack a schedule create, wait d, SIGKILL, restore.
    Survival against d gives the healthy loss window for ordinary writes."""
    tag = f"window-{stamp()}"
    st = Stack({"S4_REPLICA_PATH": tag, "S4_BARRIER_MODE": "off", "S4_SYNC_INTERVAL": args.sync_interval})
    st.up_infra()
    st.server_rm()
    st.server_start()
    s = Session(st)
    rt0, at0 = s.fresh_login()
    aid = s.omni.agent_id(at0)
    settle(st)
    runs = []
    for rep_i in range(args.reps):
        for d in args.delays:
            name = f"s4-window-{rep_i}-{d}-{secrets.token_hex(2)}"
            cid = st.server_id()
            at = s.bearer(rt0)
            time.sleep(0.3)
            rep = s.omni.create_schedule(at, name, aid)
            t_ack = now()
            time.sleep(d)
            st.server_kill(cid=cid)
            kill_s = now() - t_ack
            st.server_rm()
            st.server_start()
            g = s.omni.get(s.bearer(rt0), "/v1/scheduled-tasks").body
            ok = name in {t.get("name") for t in g.get("scheduled_tasks", [])}
            runs.append({"delay_s": d, "kill_returned_after_ack_ms": ms(kill_s), "ack": rep.status,
                         "survived": ok})
            print(json.dumps(runs[-1]))
    by: dict[str, list[int]] = {}
    for r in runs:
        by.setdefault(str(r["delay_s"]), []).append(int(r["survived"]))
    out = {"scenario": "window", "sync_interval": args.sync_interval, "replica_path": tag,
           "survival_by_delay_s": {k: f"{sum(v)}/{len(v)}" for k, v in by.items()}, "runs": runs}
    print(json.dumps(out["survival_by_delay_s"]))
    print("saved", save_result(f"{tag}.json", out))


# ── criterion 3: the replica is blocked ──────────────────────────────────


def dbcounts(st: Stack) -> dict[str, Any]:
    r = st.server_exec("python", "/opt/s4/tools/dbcheck.py")
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])["counts"]
    except (IndexError, KeyError, json.JSONDecodeError):
        return {"error": (r.stdout + r.stderr)[-300:]}


def blocked(args: argparse.Namespace) -> None:
    """Block the replica link, run each security route, then unblock or kill.

    Records, per route: status and error code, whether the change was in fact
    applied locally, and /health latency while the request was in flight
    (event-loop stalls). Then either unblocks and measures catch-up, or kills
    the server while still blocked and shows which applied changes are lost.
    """
    mode, how = args.mode, args.block
    tag = f"blocked-{mode}-{how}-{args.after}-{stamp()}"
    st = Stack({"S4_REPLICA_PATH": tag, "S4_BARRIER_MODE": mode,
                "S4_BARRIER_TIMEOUT_S": str(args.timeout), "S4_SYNC_INTERVAL": args.sync_interval})
    st.up_infra()
    st.server_rm()
    boot = st.server_start()
    s = Session(st)
    rt0, at0 = s.fresh_login()
    aid = s.omni.agent_id(at0)
    sid = s.omni.create_schedule(at0, "s4-blocked-edit", aid).body["id"]
    rt_rev, _ = s.fresh_login()
    rt_pc, at_pc = s.fresh_login()
    settle(st)
    before = dbcounts(st)
    out: dict[str, Any] = {"scenario": "blocked", "mode": mode, "block": how, "after": args.after,
                           "barrier_timeout_s": args.timeout, "replica_path": tag, "first_boot": boot,
                           "counts_before": before, "routes": {}}
    old, new = s.password, secrets.token_urlsafe(18)
    s4lib.remember_secret(new)
    created_name = f"s4-blocked-{secrets.token_hex(3)}"
    with s4lib.HealthProbe() as hp:
        time.sleep(1.0)
        out["health_before_block"] = hp.window(now() - 1.0, now())
        t_block = now()
        st.block(how)
        out["pos_after_block"] = st.lspos()

        def run(name: str, fn) -> Any:  # noqa: ANN001
            t0 = now()
            rep = fn()
            t1 = now()
            time.sleep(0.5)  # let an in-flight probe finish and be recorded
            rec = {**rep.summary(), "health_during": hp.window(t0, t1)}
            if isinstance(rep.body, dict):
                rec["body_keys"] = sorted(rep.body)
                if rep.code == "durability_unconfirmed":
                    rec["message"] = rep.body["error"] if isinstance(rep.body["error"], str) \
                        else rep.body["error"]["message"]
            out["routes"][name] = rec
            return rep

        rep = run("login_refresh", lambda: s.omni.login(s.user, s.password))
        out["routes"]["login_refresh"]["refresh_token_returned"] = bool(
            isinstance(rep.body, dict) and rep.body.get("refresh_token"))
        run("login_browser_no_refresh", lambda: s.omni.login(s.user, s.password, refresh=False))
        rep = run("schedule_create", lambda: s.omni.create_schedule(s.bearer(rt0), created_name, aid))
        run("schedule_edit", lambda: s.omni.patch_schedule(s.bearer(rt0), sid, name="s4-blocked-edited"))
        run("grant_revoke", lambda: s.omni.revoke(rt_rev))
        run("read_only_list", lambda: s.omni.get(s.bearer(rt0), "/v1/scheduled-tasks"))
        run("password_change", lambda: s.omni.change_password(at_pc, old, new))
        out["block_phase_s"] = round(now() - t_block, 2)

        # Was each change applied locally, despite the error?
        new_login = s.omni.login(s.user, new, refresh=False).status
        if new_login == 200:
            s.password = new
        at = s.bearer(rt0)
        tasks = s.omni.get(at, "/v1/scheduled-tasks").body
        names = {t.get("name") for t in (tasks.get("scheduled_tasks") or [])} \
            if isinstance(tasks, dict) else set()
        applied = {
            "login_refresh_grant_rows_delta": None,
            "schedule_create": created_name in names,
            "schedule_edit": s.omni.schedule(at, sid).body.get("name") == "s4-blocked-edited",
            "grant_revoke": s.omni.refresh(rt_rev).status != 200,
            "password_change": new_login == 200,
            "old_access_token_after_password_change": s.omni.get(at_pc, "/v1/scheduled-tasks").status,
        }
        after_counts = dbcounts(st)
        if "device_grants" in before and "device_grants" in after_counts:
            applied["login_refresh_grant_rows_delta"] = after_counts["device_grants"] - before["device_grants"]
        out["applied_locally"] = applied
        out["counts_during_block"] = after_counts
        out["pos_during_block"] = st.lspos()
        if args.hold > 0:
            time.sleep(max(0.0, args.hold - (now() - t_block)))
        out["blocked_for_s"] = round(now() - t_block, 1)

        if args.after == "unblock":
            st.unblock()
            t_un = now()
            caught = None
            while now() - t_un < 600:
                p = st.lspos()
                if p.get("caught_up"):
                    caught = now() - t_un
                    break
                time.sleep(0.5)
            out["catch_up_after_unblock_s"] = round(caught, 2) if caught is not None else None
            rep = s.omni.patch_schedule(s.bearer(rt0), sid, name="s4-after-unblock")
            out["first_barrier_after_catch_up"] = rep.summary()
            logs = st.server_logs()
            k = kill_replace(st)
            out["restart"] = {x: k.get(x) for x in ("health_s", "restore")}
        else:  # kill while still blocked, then restore with the link back
            cid = st.server_id()
            logs = st.server_logs()
            st.server_kill(cid=cid)
            st.unblock()
            k = restart_info(st.server_replace())
            out["restart"] = {x: k.get(x) for x in ("health_s",)}
            out["restart"]["restore"] = restore_window(st)
        out["health_overall"] = hp.window(t_block, now())

    # After the restore: which applied changes survived?
    login_new = s.omni.login(s.user, new, refresh=False).status
    login_old = s.omni.login(s.user, old, refresh=False).status
    s.password = new if login_new == 200 else old
    at = s.bearer(rt0)
    tasks = s.omni.get(at, "/v1/scheduled-tasks").body
    names = {t.get("name") for t in (tasks.get("scheduled_tasks") or [])} \
        if isinstance(tasks, dict) else set()
    out["after_restore"] = {
        "schedule_create_present": created_name in names,
        "schedule_edit_name": s.omni.schedule(at, sid).body.get("name"),
        "revoked_grant_refresh_status": s.omni.refresh(rt_rev).status,
        "login_new_password": login_new,
        "login_old_password": login_old,
        "counts": dbcounts(st),
    }
    out["barrier_events"] = [e for e in barrier_events(logs) if e.get("event") != "entrypoint_start"]
    out["litestream_errors_sample"] = s4lib.litestream_lines(logs, "level=ERROR", "level=WARN")[:6]
    p = save_result(f"{tag}.json", out)
    print(json.dumps({x: out[x] for x in ("routes", "applied_locally", "after_restore")}, indent=1)[:6000])
    print("catch_up_after_unblock_s", out.get("catch_up_after_unblock_s"))
    print("saved", p)


# ── healthy barrier latency and object-store writes ──────────────────────


def latency(args: argparse.Namespace) -> None:
    """Barrier cost while healthy: acknowledgement latency of a schedule edit,
    the barrier's own wait, and object-store PUTs, per replica sync interval
    and emulated link latency. Also PUTs while the server idles."""
    disk = "tmpfs" if args.tmpfs else "overlay"
    tag = f"latency-si{args.sync_interval}-rtt{args.rtt}-{disk}-{stamp()}"
    st = Stack({"S4_REPLICA_PATH": tag, "S4_BARRIER_MODE": "response",
                "S4_SYNC_INTERVAL": args.sync_interval, "S4_BARRIER_TIMEOUT_S": "15"},
               tmpfs=args.tmpfs)
    st.up_infra()
    st.server_rm()
    st.server_start()
    if args.rtt:
        st.latency(args.rtt)
    s = Session(st)
    rt0, at0 = s.fresh_login()
    aid = s.omni.agent_id(at0)
    sid = s.omni.create_schedule(at0, "s4-latency", aid).body["id"]
    settle(st)
    # MinIO's cluster metrics are cached for a short while; read them only
    # after quiet periods well longer than that.
    time.sleep(30)
    p0 = st.minio_requests()
    time.sleep(args.idle)
    p1 = st.minio_requests()
    cid = st.server_id()
    acks = []
    rng = __import__("random").Random(7)
    probe: dict[str, Any] = {}
    est = args.n * 2.2 + 10

    def run_probe() -> None:
        r = st.server_exec("python", "/opt/s4/tools/syncprobe.py", "--status-only",
                           "--seconds", str(est), timeout=est + 60)
        try:
            probe.update(json.loads(r.stdout.strip().splitlines()[-1]))
        except (IndexError, json.JSONDecodeError):
            probe["error"] = (r.stdout + r.stderr)[-300:]

    import threading

    th = threading.Thread(target=run_probe)
    th.start()
    time.sleep(2)
    t_w0 = now()
    for i in range(args.n):
        time.sleep(rng.uniform(0.2, 2.0))
        rep = s.omni.patch_schedule(s.bearer(rt0) if i % 10 == 0 else at0, sid, name=f"s4-latency-{i}")
        if rep.status == 401:
            at0 = s.bearer(rt0)
            rep = s.omni.patch_schedule(at0, sid, name=f"s4-latency-{i}")
        acks.append(rep.summary())
    time.sleep(30)
    p2 = st.minio_requests()
    tail_s = now() - t_w0  # the whole write phase, including the 30 s tail
    th.join()
    logs = st.docker("logs", cid, check=False).stderr
    waits = [e["wait_ms"] for e in barrier_events(logs)
             if e.get("event") == "barrier" and e.get("method") == "PATCH" and e.get("ok")]
    ack_ms = [a["ms"] for a in acks if a["status"] == 200]
    out = {"scenario": "latency", "sync_interval": args.sync_interval, "rtt_ms": args.rtt, "disk": disk,
           "barrier_timeout_s": 15, "litestream_sync_probe": probe,
           "n": args.n, "ok": len(ack_ms), "failed": [a for a in acks if a["status"] != 200],
           "ack_ms": {"p50": pct(ack_ms, 0.5), "p95": pct(ack_ms, 0.95), "max": pct(ack_ms, 1.0)},
           "barrier_wait_ms": {"p50": pct(waits, 0.5), "p95": pct(waits, 0.95), "max": pct(waits, 1.0),
                               "n": len(waits)},
           "idle_s": args.idle, "idle_requests": s4lib.request_delta(p0, p1),
           "write_phase_requests": s4lib.request_delta(p1, p2),
           "note": "MinIO counts every S3 call on the server, including the driver's own few; "
                   "only Litestream talks to it during the idle and write phases."}
    ia = out["idle_requests"]["class_a"]
    out["idle_class_a_per_month_est"] = round(ia / args.idle * 86400 * 30)
    # Subtract the idle background over the write phase before attributing to writes.
    wa = out["write_phase_requests"]["class_a"] - ia / args.idle * tail_s
    out["class_a_per_ack_est"] = round(wa / max(1, args.n), 2)
    print(json.dumps(out))
    print("saved", save_result(f"{tag}.json", out))


# ── SIGTERM: does Litestream flush on a graceful stop? ───────────────────


def sigterm(args: argparse.Namespace) -> None:
    """Without the barrier, ack a write, send SIGTERM to PID 1 (Litestream), let
    it exit on its own, restore into a fresh container and look for the write.
    With ``--block`` the replica link is blocked during the stop."""
    tag = f"sigterm-{args.signal.lower()}-{args.block}-{stamp()}"
    # A long replica sync interval, so only a shutdown flush can upload the
    # write before the process is gone. SIGKILL is the control.
    st = Stack({"S4_REPLICA_PATH": tag, "S4_BARRIER_MODE": "off",
                "S4_SYNC_INTERVAL": args.sync_interval,
                "S4_SHUTDOWN_SYNC_TIMEOUT": args.shutdown_sync_timeout})
    st.up_infra()
    st.server_rm()
    boot = st.server_start()
    s = Session(st)
    rt0, at0 = s.fresh_login()
    aid = s.omni.agent_id(at0)
    settle(st)
    runs = []
    for i in range(args.runs):
        name = f"s4-sigterm-{i}-{secrets.token_hex(3)}"
        cid = st.server_id()
        if args.block != "none":
            st.block(args.block)
        at = s.bearer(rt0)
        time.sleep(args.delay)
        rep = s.omni.create_schedule(at, name, aid)
        t_ack = now()
        st.server_kill(args.signal, cid=cid)
        t_sig = now()
        state = st.server_wait_exit(cid, timeout=180)
        stop_s = now() - t_sig
        logs = st.server_logs()
        if args.block != "none":
            st.unblock()
        st.server_rm()
        start = st.server_start()
        g = s.omni.get(s.bearer(rt0), "/v1/scheduled-tasks").body
        present = name in {t.get("name") for t in g.get("scheduled_tasks", [])}
        lines = s4lib.litestream_lines(logs, "signal received", "sending signal", "waiting for exec",
                                       "litestream shut down", "shutdown", "level=ERROR", "level=WARN",
                                       "Shutting down", "Finished server process")
        run = {"ack": rep.summary(), "signal_done_after_ack_ms": ms(t_sig - t_ack),
               "stop_s": round(stop_s, 2), "exit": state.get("StatusCode"),
               "write_present_after_restore": present, "restart_health_s": start.get("health_s"),
               "shutdown_log": [ln[:240] for ln in lines][:14]}
        runs.append(run)
        print(json.dumps({k: run[k] for k in ("stop_s", "exit", "write_present_after_restore",
                                              "signal_done_after_ack_ms")}))
    out = {"scenario": "sigterm", "signal": args.signal, "block": args.block,
           "sync_interval": args.sync_interval, "shutdown_sync_timeout": args.shutdown_sync_timeout,
           "replica_path": tag, "first_boot": boot, "runs": runs,
           "summary": {"present": sum(r["write_present_after_restore"] for r in runs), "runs": len(runs),
                       "stop_s_max": max(r["stop_s"] for r in runs)}}
    print("saved", save_result(f"{tag}.json", out))


# ── restore time for realistic sizes ─────────────────────────────────────


def restore(args: argparse.Namespace) -> None:
    results = []
    for size in args.sizes:
        tag = f"restore-{size}mb-{stamp()}"
        st = Stack({"S4_REPLICA_PATH": tag, "S4_BARRIER_MODE": "response"})
        st.up_infra()
        st.server_rm()
        st.server_start()
        s = Session(st)
        rt0, at0 = s.fresh_login()
        aid = s.omni.agent_id(at0)
        marker = f"s4-restore-marker-{secrets.token_hex(3)}"
        mk = s.omni.create_schedule(at0, marker, aid)
        rec: dict[str, Any] = {"size_mb": size, "replica_path": tag, "marker_ack": mk.summary()}
        t0 = now()
        r = st.server_exec("python", "/opt/s4/tools/seed.py", "--target-mb", str(size), timeout=7200)
        rec["seed"] = json.loads(r.stdout.strip().splitlines()[-1])
        rec["seed_wall_s"] = round(now() - t0, 1)
        t0 = now()
        rec["catch_up"] = st.lspos(wait_caught_up=900)
        rec["catch_up_wall_s"] = round(now() - t0, 1)
        live = st.server_exec("python", "/opt/s4/tools/dbcheck.py")
        rec["live_check"] = json.loads(live.stdout.strip().splitlines()[-1])
        objs = st.replica_objects(tag)
        levels: dict[str, dict[str, int]] = {}
        for o in objs:
            lvl = o["key"].split("/")[0] if "/" in o["key"] else "root"
            d = levels.setdefault(lvl, {"files": 0, "bytes": 0})
            d["files"] += 1
            d["bytes"] += o["size"]
        rec["replica_layout"] = levels
        rec["replica_bytes"] = sum(o["size"] for o in objs)

        def timed_restore(label: str) -> None:
            rr = st.compose("run", "--rm", "--no-deps", "-T", "server", "python",
                            "/opt/s4/tools/timed_restore.py", timeout=3600, check=False)
            try:
                rec[label] = json.loads(rr.stdout.strip().splitlines()[-1])
            except (IndexError, json.JSONDecodeError):
                rec[label] = {"error": (rr.stdout + rr.stderr)[-500:]}

        timed_restore("plain_restore_local")
        # Abrupt loss of the server. With no server running, the link is idle,
        # so Toxiproxy can take the WAN toxics cleanly.
        st.server_kill()
        if args.wan:
            # A rough WAN profile through Toxiproxy (see report): RTT and bandwidth.
            lat, rate = args.wan
            st.latency(int(lat), rate_kbps=int(rate))
            timed_restore("plain_restore_wan")
            rec["wan_profile"] = {"rtt_ms": int(lat), "rate_kBps": int(rate)}
            st.unblock()
        # Server replacement: fresh container, restore, migrations, /health.
        k = restart_info(st.server_replace())
        rec["replace"] = {"health_s": k.get("health_s"), "litestream_restore": restore_window(st)}
        chk = st.server_exec("python", "/opt/s4/tools/dbcheck.py")
        rec["after_replace_check"] = json.loads(chk.stdout.strip().splitlines()[-1])
        g = s.omni.get(s.bearer(rt0), "/v1/scheduled-tasks").body
        rec["marker_present"] = marker in {t.get("name") for t in g.get("scheduled_tasks", [])}
        rec["filler_matches"] = rec["after_replace_check"].get("filler", {}).get("rows") == rec["seed"]["rows"]
        # What the new server uploads right after a restore (a fresh snapshot?).
        time.sleep(20)
        objs2 = st.replica_objects(tag)
        rec["replica_bytes_20s_after_replace"] = sum(o["size"] for o in objs2)
        results.append(rec)
        print(json.dumps({k: rec.get(k) for k in ("size_mb", "replica_bytes", "replica_layout")}))
        print(json.dumps({"plain": rec["plain_restore_local"].get("restore_s"),
                          "replace": rec["replace"], "wan": rec.get("plain_restore_wan", {}).get("restore_s"),
                          "marker": rec["marker_present"], "filler": rec["filler_matches"]}))
        save_result(f"{tag}.json", rec)
    print("done", len(results))


# ── start-up with a missing or unreachable replica ───────────────────────


def startup(args: argparse.Namespace) -> None:
    """What a replacement server does when the replica is empty or unreachable.

    empty:     a replica path with no backup (lost or wrong bucket prefix).
    refuse:    the replica link refuses connections during the restore.
    blackhole: the replica link accepts connections and never answers.
    """
    out: dict[str, Any] = {"scenario": "startup", "cases": {}}
    # One populated replica to point the failing cases at.
    tag = f"startup-{stamp()}"
    st = Stack({"S4_REPLICA_PATH": tag})
    st.up_infra()
    st.server_rm()
    st.server_start()
    s = Session(st)
    rt0, at0 = s.fresh_login()
    s.omni.create_schedule(at0, "s4-startup-marker", s.omni.agent_id(at0))
    settle(st)
    for case in args.cases:
        st.server_kill()
        st.server_rm()
        path = f"{tag}-empty" if case == "empty" else tag
        st2 = Stack({"S4_REPLICA_PATH": path})
        if case in ("refuse", "blackhole"):
            st2.block(case)
        t0 = now()
        st2.compose("up", "-d", "--no-build", "--no-deps", "server")
        rec: dict[str, Any] = {"replica_path_used": "empty prefix" if case == "empty" else "populated"}
        deadline = t0 + args.wait
        state: dict[str, Any] = {}
        health = None
        while now() < deadline:
            state = st2.server_state()
            if not state.get("Running"):
                break
            try:
                if __import__("httpx").get(f"{s4lib.BASE}/health", timeout=1).status_code == 200:
                    health = round(now() - t0, 2)
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.25)
        rec["healthy_after_s"] = health
        rec["exited"] = not state.get("Running", False)
        rec["exit_code"] = state.get("ExitCode")
        rec["observed_s"] = round(now() - t0, 1)
        logs = st2.server_logs()
        rec["log"] = [ln[:220] for ln in s4lib.litestream_lines(
            logs, "restore", "no backup", "level=ERROR", "Error:", "created", "already exists",
            "No admin", "bootstrap")][:10]
        if health:
            # Who can log in: the original owner with the current password?
            rec["login_with_env_password"] = s.omni.login(s.user, load_env()["S4_ADMIN_PASSWORD"],
                                                          refresh=False).status
            at = s.bearer(None) if rec["login_with_env_password"] == 200 else None
            if at:
                g = s.omni.get(at, "/v1/scheduled-tasks").body
                rec["marker_present"] = "s4-startup-marker" in {
                    t.get("name") for t in g.get("scheduled_tasks", [])}
        st2.unblock()
        out["cases"][case] = rec
        print(case, json.dumps({k: v for k, v in rec.items() if k != "log"}))
    st.server_kill()
    st.server_rm()
    print("saved", save_result(f"{tag}.json", out))


# ── the first security write after a restore ─────────────────────────────


def postrestore(args: argparse.Namespace) -> None:
    """After a restore, Litestream uploads a new full snapshot. Does the first
    security write after the replacement wait for it?"""
    tag = f"postrestore-{args.size}mb-{'wan' if args.wan else 'local'}-{stamp()}"
    st = Stack({"S4_REPLICA_PATH": tag, "S4_BARRIER_MODE": "response",
                "S4_BARRIER_TIMEOUT_S": str(args.timeout)})
    st.up_infra()
    st.server_rm()
    st.server_start()
    s = Session(st)
    rt0, at0 = s.fresh_login()
    sid = s.omni.create_schedule(at0, "s4-postrestore", s.omni.agent_id(at0)).body["id"]
    r = st.server_exec("python", "/opt/s4/tools/seed.py", "--target-mb", str(args.size), timeout=7200)
    rec: dict[str, Any] = {"scenario": "postrestore", "size_mb": args.size, "replica_path": tag,
                           "barrier_timeout_s": args.timeout,
                           "seed": json.loads(r.stdout.strip().splitlines()[-1])}
    rec["catch_up"] = st.lspos(wait_caught_up=900)
    before = sum(o["size"] for o in st.replica_objects(tag))
    st.server_kill()
    if args.wan:
        lat, rate = args.wan
        st.latency(int(lat), rate_kbps=int(rate))
        rec["wan_profile"] = {"rtt_ms": int(lat), "rate_kBps": int(rate)}
    k = restart_info(st.server_replace(timeout=900))
    rec["health_s"] = k.get("health_s")
    rec["litestream_restore"] = restore_window(st)
    t_h = now()
    writes = []
    for i in range(args.writes):
        rep = s.omni.patch_schedule(s.bearer(rt0), sid, name=f"s4-postrestore-{i}")
        writes.append({"t_after_health_s": round(now() - t_h, 2), **rep.summary()})
        if rep.status == 200:
            break
        time.sleep(1)
    rec["writes_after_health"] = writes
    # t_after_health_s is taken when the reply arrived, so it already includes the wait.
    rec["first_confirmed_after_health_s"] = next(
        (w["t_after_health_s"] for w in writes if w["status"] == 200), None)
    st.unblock()
    time.sleep(5)
    rec["replica_bytes_before_replace"] = before
    rec["replica_bytes_after"] = sum(o["size"] for o in st.replica_objects(tag))
    print(json.dumps({k: v for k, v in rec.items() if k not in ("seed", "catch_up")}))
    print("saved", save_result(f"{tag}.json", rec))


# ── issue #1540 / #1552 against the pinned binary ────────────────────────


def issue1540(args: argparse.Namespace) -> None:
    st = Stack()
    runs = []
    plan: list[list[str]] = []
    for _ in range(args.repeat):
        plan += [["repro", "--guard", "held"], ["repro", "--guard", "dropped"],
                 ["repro", "--guard", "dropped", "--monitor-interval", "1s"]]
    plan += [["soak", "--barrier", "nowait", "--seconds", str(args.soak_seconds)],
             ["soak", "--barrier", "wait", "--seconds", str(args.soak_seconds)],
             ["soak", "--barrier", "nowait", "--seconds", str(args.soak_seconds), "--app-checkpoint", "3"],
             ["soak", "--barrier", "wait", "--seconds", str(args.soak_seconds), "--app-checkpoint", "3"]]
    for argv in plan:
        r = st.docker("run", "--rm", "--entrypoint", "python", "cfo-s4/server:dev",
                      "/opt/s4/tools/issue1540.py", *argv, check=False, timeout=900)
        try:
            res = json.loads(r.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            res = {"error": (r.stdout + r.stderr)[-800:]}
        res["argv"] = argv
        runs.append(res)
        brief = {k: res.get(k) for k in ("mode", "guard", "barrier", "app_checkpoint_every_s",
                                          "checkpoint_truncate", "local_rows", "lost_rows",
                                          "acked_max_id", "acked_rows_missing", "error")}
        brief["restore"] = {k: res.get("restore", {}).get(k) for k in ("integrity", "data_rows", "exit")}
        print(json.dumps(brief))
    p = save_result(f"issue1540-{stamp()}.json", {"scenario": "issue1540", "litestream": "0.5.17", "runs": runs})
    print("saved", p)


# ── the whole matrix, as recorded in the evidence ────────────────────────

MATRIX: list[list[str]] = [
    ["issue1540", "--repeat", "3", "--soak-seconds", "120"],
    ["routes", "--mode", "response", "--rounds", "5"],
    ["routes", "--mode", "off", "--rounds", "5"],
    ["routes", "--mode", "commit_hook", "--rounds", "2"],
    ["blocked", "--mode", "response", "--block", "refuse", "--after", "unblock"],
    ["blocked", "--mode", "response", "--block", "blackhole", "--after", "unblock"],
    ["blocked", "--mode", "response", "--block", "refuse", "--after", "kill"],
    ["blocked", "--mode", "response", "--block", "blackhole", "--after", "kill"],
    ["blocked", "--mode", "commit_hook", "--block", "refuse", "--after", "unblock"],
    ["blocked", "--mode", "response", "--block", "refuse", "--after", "unblock", "--hold", "330"],
    ["sigterm", "--signal", "TERM", "--runs", "5"],
    ["sigterm", "--signal", "KILL", "--runs", "3"],
    ["sigterm", "--signal", "TERM", "--block", "refuse", "--runs", "2"],
    ["sigterm", "--signal", "TERM", "--block", "blackhole", "--runs", "1"],
    ["latency", "--n", "40", "--idle", "120"],
    ["latency", "--n", "40", "--idle", "120", "--tmpfs"],
    ["latency", "--n", "40", "--idle", "120", "--tmpfs", "--sync-interval", "200ms"],
    ["latency", "--n", "40", "--idle", "120", "--tmpfs", "--rtt", "40"],
    ["startup"],
    ["restore", "--sizes", "10", "100", "1000", "--wan", "40", "50000"],
    ["window"],
    ["postrestore", "--size", "1000"],
    ["postrestore", "--size", "1000", "--wan", "40", "50000"],
]


def run_all(args: argparse.Namespace) -> None:
    import subprocess

    started = stamp()
    log: list[str] = []
    steps = []
    only = set(args.only or [])
    for i, argv in enumerate(MATRIX):
        if only and str(i) not in only:
            continue
        t0 = now()
        p = subprocess.run([sys.executable, __file__, *argv], capture_output=True, text=True, check=False)
        dur = round(now() - t0, 1)
        steps.append({"step": i, "argv": argv, "exit": p.returncode, "seconds": dur})
        log.append(f"### step {i}: {' '.join(argv)} (exit {p.returncode}, {dur}s)\n{p.stdout[-6000:]}"
                   + (f"\n[stderr tail]\n{p.stderr[-3000:]}" if p.returncode else ""))
        print(f"step {i} {' '.join(argv)} exit={p.returncode} {dur}s", flush=True)
    text = "\n\n".join(log)
    # Keep evidence free of local absolute paths.
    root = str(__import__("pathlib").Path(__file__).resolve().parents[3])
    text = text.replace(root, "<repo>").replace(str(__import__("pathlib").Path.home()), "~")
    save_result(f"run-all-{started}.log", text)
    save_result(f"run-all-{started}.json", {"started": started, "steps": steps})


def scan(args: argparse.Namespace) -> None:
    """Run the repository's canary scanner over the given paths, with this run's
    generated secrets (MinIO keys, owner password, cookie secret) as canaries."""
    import subprocess

    from s4lib import S4, secret_values

    root = S4.parents[1]
    env = {**__import__("os").environ, "CFO_CANARY_VALUES": ",".join(secret_values())}
    p = subprocess.run(["node", str(root / "scripts" / "canary-scan.ts"), *args.paths],
                       cwd=root, env=env, capture_output=True, text=True, check=False)
    print(p.stdout[-3000:], p.stderr[-2000:])
    print("exit", p.returncode)
    sys.exit(p.returncode)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build").set_defaults(fn=build)
    sub.add_parser("down").set_defaults(fn=down)
    sub.add_parser("smoke").set_defaults(fn=smoke)
    p = sub.add_parser("routes", help="criteria 1-2: ack each security change, SIGKILL, restore, verify")
    p.add_argument("--mode", default="response", choices=["response", "off", "commit_hook"])
    p.add_argument("--rounds", type=int, default=4)
    p.add_argument("--sync-interval", default="1s")
    p.set_defaults(fn=routes)
    p = sub.add_parser("window", help="loss window without the barrier: survival vs kill delay")
    p.add_argument("--delays", type=float, nargs="+", default=[0.0, 0.25, 0.5, 1.0, 1.5, 2.5])
    p.add_argument("--reps", type=int, default=3)
    p.add_argument("--sync-interval", default="1s")
    p.set_defaults(fn=window)
    p = sub.add_parser("blocked", help="criterion 3: block the replica link and run each route")
    p.add_argument("--mode", default="response", choices=["response", "commit_hook"])
    p.add_argument("--block", default="refuse", choices=["refuse", "blackhole"])
    p.add_argument("--after", default="unblock", choices=["unblock", "kill"])
    p.add_argument("--timeout", type=float, default=5.0, help="barrier timeout, seconds")
    p.add_argument("--hold", type=float, default=0.0, help="keep blocked at least this long, seconds")
    p.add_argument("--sync-interval", default="1s")
    p.set_defaults(fn=blocked)
    p = sub.add_parser("latency", help="healthy barrier latency and PUT counts")
    p.add_argument("--sync-interval", default="1s")
    p.add_argument("--rtt", type=int, default=0, help="emulated link round trip, ms")
    p.add_argument("--n", type=int, default=40)
    p.add_argument("--idle", type=float, default=60.0)
    p.add_argument("--tmpfs", action="store_true", help="database on tmpfs (no fsync cost)")
    p.set_defaults(fn=latency)
    p = sub.add_parser("sigterm", help="does Litestream flush on SIGTERM (barrier off)")
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--block", default="none", choices=["none", "refuse", "blackhole"])
    p.add_argument("--shutdown-sync-timeout", default="30s")
    p.add_argument("--signal", default="TERM", choices=["TERM", "KILL"])
    p.add_argument("--sync-interval", default="30s")
    p.add_argument("--delay", type=float, default=2.0, help="pause after the previous sync, seconds")
    p.set_defaults(fn=sigterm)
    p = sub.add_parser("restore", help="criterion 4: restore time at realistic sizes")
    p.add_argument("--sizes", type=int, nargs="+", default=[10, 100, 1000])
    p.add_argument("--wan", type=int, nargs=2, metavar=("RTT_MS", "RATE_KBPS"), default=None)
    p.set_defaults(fn=restore)
    p = sub.add_parser("postrestore", help="first security write after a restore (re-snapshot)")
    p.add_argument("--size", type=int, default=1000)
    p.add_argument("--wan", type=int, nargs=2, metavar=("RTT_MS", "RATE_KBPS"), default=None)
    p.add_argument("--timeout", type=float, default=5.0)
    p.add_argument("--writes", type=int, default=60)
    p.set_defaults(fn=postrestore)
    p = sub.add_parser("startup", help="replacement server with an empty or unreachable replica")
    p.add_argument("--cases", nargs="+", default=["empty", "refuse", "blackhole"])
    p.add_argument("--wait", type=float, default=150.0)
    p.set_defaults(fn=startup)
    p = sub.add_parser("scan", help="canary-scan paths for this run's generated secrets")
    p.add_argument("paths", nargs="+")
    p.set_defaults(fn=scan)
    p = sub.add_parser("all", help="run the whole recorded matrix (about 100 minutes)")
    p.add_argument("--only", nargs="*", help="step numbers to run")
    p.set_defaults(fn=run_all)
    p = sub.add_parser("issue1540", help="Litestream #1540/#1552: black-box repro and an ack soak")
    p.add_argument("--repeat", type=int, default=3)
    p.add_argument("--soak-seconds", type=float, default=60)
    p.set_defaults(fn=issue1540)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
