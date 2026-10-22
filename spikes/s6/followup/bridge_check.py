"""Native harnesses' bridge files: classification check, paused writers, and Codex's restore test
(S6 follow-up; R-08, G1BR-001 and its residual). Throwaway spike code.

Runs the Omnigent fork's own writers (cfo/integration af3e49de2, installed in a separate virtual
environment) under a throwaway home and temporary directory, with synthetic canary values. No
CLI, server, account or network: the Omnigent server is a fake on an httpx mock transport.

1. Inventory. Each harness writes its bridge files through the fork's functions. Every path
   under the home (and the Claude bridge under $TMPDIR) gets its decision from
   bridge-classification.json; a path in a Codex bridge that no rule knows fails the check.
2. Paused writers. os.replace is wrapped in this process (Omnigent's files are not touched): when
   a writer is about to rename a temporary file into a secret family member, a workspace
   checkpoint is captured right then, with the synthetic credential in the temporary file. The
   layer must hold neither the temporary file nor the value. Initial writes and the renewal
   writer are both covered.
3. Codex's restore test (G1BR-001). A native Codex session with private configuration and an
   event the server never received (the real forwarder's post fails with a connection error and
   dead-letters it), checkpointed as a base and a delta while the server is unreachable; the
   disk is replaced (the home deleted); the layers are restored and the credential checkpoint
   reinstalled; a start re-links the login; the cold-resume path replays the queue and rebuilds
   the rollout from the fake server. Then the same checkpoint is restored again and reconciled
   again, as after a crash before the next save. Negative control: the old blanket exclusion
   of the whole bridge directory loses the event and the private configuration.
4. RC-53. Every decompressed layer is searched for every planted value (raw, URL-encoded,
   JSON-escaped, hex, base64 at each alignment). A literal provider key in the private
   config.toml is the classification's one "decide" case and is reported, not hidden.

  python -I spikes/s6/followup/bridge_check.py --root <empty dir> --variant tmp-outside|tmp-inside --out result.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

CANARY_PREFIX = "CFO_" + "CANARY_"


def canary(label: str) -> str:
    return f"{CANARY_PREFIX}S6FU{label}{secrets.token_hex(10)}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--variant", choices=("tmp-outside", "tmp-inside"), required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    root = Path(a.root).resolve()
    if root.exists() and any(root.iterdir()):
        raise SystemExit("--root must be empty")
    home = root / "home"
    tmp = home / "tmp" if a.variant == "tmp-inside" else root / "tmp"
    for d in (home, tmp):
        d.mkdir(parents=True, mode=0o700, exist_ok=True)
    # Before any Omnigent import: its bridge roots are fixed at import time.
    os.environ.update(HOME=str(home), TMPDIR=str(tmp), XDG_CONFIG_HOME=str(home / ".config"),
                      XDG_DATA_HOME=str(home / ".local/share"), XDG_CACHE_HOME=str(home / ".cache"),
                      XDG_STATE_HOME=str(home / ".local/state"))
    for k in ("CODEX_HOME", "CLAUDE_CONFIG_DIR", "OMNIGENT_DATA_DIR", "OMNIGENT_CODEX_NATIVE_STATE_DIR",
              "OMNIGENT_CLAUDE_NATIVE_STATE_DIR", "OMNIGENT_BRIDGE_BIND_HOST", "OMNIGENT_HARNESS_TMP_PARENT"):
        os.environ.pop(k, None)
    tempfile.tempdir = None
    # The launch token reaches the host through its environment only (core change 17).
    launch_token = canary("launch")
    os.environ["OMNIGENT_HOST_TOKEN"] = launch_token
    result = asyncio.run(run(home, tmp, a.variant, launch_token))
    Path(a.out).write_text(json.dumps(result, indent=1, sort_keys=True) + "\n")
    print(json.dumps({"variant": a.variant, "failures": result["failures"]}, indent=1))
    return 1 if result["failures"] else 0


async def run(home: Path, tmp: Path, variant: str, launch_token: str) -> dict:
    import httpx

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import bridge_policy as bp
    from omnigent.harnesses.claude_native import bridge as cb
    from omnigent.harnesses.codex_native import app_server, forwarder
    from omnigent.harnesses.codex_native import bridge as xb
    from omnigent.harnesses.codex_native import main as xmain
    from omnigent.inner import codex_executor
    from omnigent.runner import subagent_routing, turn_routing

    tmp_rel = str(tmp.relative_to(home)) if tmp.is_relative_to(home) else None
    failures: list[str] = []
    canaries: dict[str, str] = {"launch token (environment only)": launch_token}
    work = home / "work"
    work.mkdir()
    layers_dir = home.parent / "layers"
    layers_dir.mkdir()

    def check(name: str, ok: bool) -> None:
        if not ok:
            failures.append(name)

    # ------------------------------------------------------------- the person's logins (seeded)
    codex_src = home / ".codex"
    codex_src.mkdir(mode=0o700)
    logins = {
        ".codex/auth.json": json.dumps({"OPENAI_API_KEY": None, "tokens": {
            "id_token": canary("codexid"), "access_token": canary("codexaccess"),
            "refresh_token": canary("codexrefresh"), "account_id": str(uuid.uuid4())},
            "last_refresh": "2026-10-22T00:00:00Z"}),
        ".codex/.credentials.json": json.dumps({"mcp": {"access_token": canary("codexmcp")}}),
        ".claude/.credentials.json": json.dumps({"claudeAiOauth": {
            "accessToken": canary("claudeaccess"), "refreshToken": canary("clauderefresh")}}),
    }
    for rel, text in logins.items():
        p = home / rel
        p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        p.write_text(text)
        p.chmod(0o600)
        for k, v in _strings(json.loads(text)):
            if v.startswith(CANARY_PREFIX):
                canaries[f"login {rel} {k}"] = v
    (codex_src / "config.toml").write_text('model = "gpt-shared"\n')
    (codex_src / "AGENTS.md").write_text("shared agent notes\n")
    (codex_src / "memories_1.sqlite").write_bytes(b"")
    for d in ("memories", "rules", "plugins/cache", "mcp-oauth-locks"):
        (codex_src / d).mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------- paused writers
    real_replace = os.replace
    paused: list[dict] = []
    watched = {"policy_hook.json", "bridge.json", "tool_relay.json", "server.json", "turn_router.json",
               "subagent_router.json", "permission_hook.json", "claude-settings.json", "config.toml"}
    layer_no = [0]

    def replace_with_pause(src, dst, *args, **kwargs):
        dstp, srcp = Path(dst), Path(src)
        if dstp.name in watched and srcp.exists():
            content = srcp.read_text(errors="replace")
            values = {f"value in {dstp.name}": v for v in _secret_values(content)}
            layer_no[0] += 1
            layer = layers_dir / f"paused-{layer_no[0]}.tar.gz"
            m = bp.write_layer(home, layer, tmp_rel=tmp_rel)
            rel_tmp = str(srcp.relative_to(home)) if srcp.is_relative_to(home) else None
            found = bp.scan_layer(layer, values) if values else []
            rec = {"writer_target": _mask(str(dstp.relative_to(home) if dstp.is_relative_to(home) else
                                               "$TMPDIR/" + str(dstp.relative_to(tmp)))),
                   "temporary_name": _temp_shape(srcp.name, dstp.name),
                   "temporary_inside_home": rel_tmp is not None,
                   "temporary_held_a_secret": bool(values),
                   "temporary_in_layer": rel_tmp in m["members"] if rel_tmp else False,
                   "decision_for_temporary": bp.decide(rel_tmp, tmp_rel=tmp_rel).rule if rel_tmp else "outside the home",
                   "secret_found_in_layer": found}
            paused.append(rec)
            if dstp.name != "config.toml":
                check(f"paused {rec['writer_target']}: temporary not in the layer", not rec["temporary_in_layer"])
                check(f"paused {rec['writer_target']}: no secret in the layer", not found)
            layer.unlink()
        return real_replace(src, dst, *args, **kwargs)

    os.replace = replace_with_pause

    # ------------------------------------------------------------- Codex-native bridge
    session_id = "conv_s6followup"
    thread = str(uuid.uuid4())
    B = xb.prepare_bridge_dir(session_id)
    xb.write_mcp_bridge_config(B)
    canaries["codex bridge.json token"] = json.loads((B / "bridge.json").read_text())["token"]
    delegated = canary("delegated")
    xb.write_policy_hook_config(B, ap_server_url="http://127.0.0.1:9", ap_auth_headers={"Authorization": f"Bearer {delegated}"})
    renewed = canary("delegatedrenewed")
    xb.update_policy_hook_auth_headers(B, {"Authorization": f"Bearer {renewed}"})
    canaries.update({"delegated token (policy_hook.json)": delegated, "renewed delegated token": renewed})
    xb.write_bridge_state(B, xb.CodexNativeBridgeState(session_id=session_id, socket_path="ws://127.0.0.1:9",
                                                       thread_id=thread, codex_home=str(B / "codex-home"), cwd=str(work)))
    xb.write_bridge_startup_timeout(B, 30.0)
    xb.update_mcp_server_startup(B, "omnigent", "ready")
    CH = xb.codex_home_for_bridge_dir(B)
    CH.mkdir(mode=0o700)
    codex_executor._populate_codex_home_config(CH, codex_src, minimal_config=False, inject_hooks=False,
                                               extend_model_catalog=False, include_credentials=True)
    app_server._pin_codex_config_model(CH, "gpt-private-s6")
    app_server._sync_codex_developer_instructions(CH, "S6 follow-up private instructions")
    app_server._write_codex_policy_hooks_file(CH, B, sys.executable)
    xb.mirror_applied_codex_settings(B, {"model": "gpt-private-s6"})
    rollout = CH / "sessions/2026/10/22" / f"rollout-2026-10-22T00-00-00-{thread}.jsonl"
    rollout.parent.mkdir(parents=True)
    rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": thread, "timestamp": "2026-10-22T00:00:00Z",
                                                                       "cwd": str(work), "cli_version": "0.0.0"}}) + "\n")
    loop = asyncio.get_running_loop()

    async def no_tool(name, args):
        return {}

    relay = cb.start_tool_relay(bridge_dir=B, tools=[], tool_executor=no_tool, loop=loop, session_id=session_id)
    canaries["codex bridge tool relay token"] = json.loads((B / "tool_relay.json").read_text())["token"]
    router = canary("router")
    subagent_routing.write_advertisement(B, url="http://127.0.0.1:9", token=router, filename="turn_router.json")
    subagent_routing.write_advertisement(B, url="http://127.0.0.1:9", token=router, filename="subagent_router.json")
    canaries["router token"] = router
    turn_routing.write_turn_routing_marker(B, session_id=session_id, decision_id="d1")
    turn_routing.write_pending_replay(B, session_id=session_id, prompt="S6 pending prompt", blocked_turn_id="turn_0")
    server_token = canary("serve")
    cb._write_json_file(B / "server.json", {"token": server_token, "pid": 1, "socket": "/nonexistent.sock"})
    canaries["serve-mcp token (server.json)"] = server_token

    # The server: unreachable now. The real forwarder's post fails and dead-letters the item.
    def unreachable(request):
        raise httpx.ConnectError("server unreachable (test)", request=request)

    item = lambda n, text: {"item_type": "message", "response_id": f"resp_{n}", "source_id": f"{thread}:turn_{n}:item_{n}",  # noqa: E731
                            "item_data": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}}
    async with httpx.AsyncClient(base_url="http://omnigent.test", transport=httpx.MockTransport(unreachable)) as down:
        token_ctx = forwarder._dead_letter_dir.set(B)
        try:
            r1 = await forwarder._post_session_event(down, session_id, event_type="external_conversation_item",
                                                     data=item(1, "S6 undelivered item one"), max_attempts=1)
        finally:
            forwarder._dead_letter_dir.reset(token_ctx)
    check("the first undelivered event was dead-lettered", r1 is None and (B / "dead_letter.jsonl").exists())

    # ------------------------------------------------------------- Claude-native
    cb.ensure_claude_workspace_trusted(work, env={"HOME": str(home)})
    tr = home / ".claude/projects/-work" / f"{uuid.uuid4()}.jsonl"
    tr.parent.mkdir(parents=True, exist_ok=True)
    tr.write_text('{"type": "user"}\n')
    CB = cb.prepare_bridge_dir("conv_claude_s6", workspace=work)
    canaries["claude bridge.json token"] = json.loads((CB / "bridge.json").read_text())["token"]
    claude_delegated, helper = canary("claudedelegated"), canary("apikeyhelper")
    cb.augment_claude_args((), bridge_dir=CB, ap_server_url="http://127.0.0.1:9",
                           ap_auth_headers={"Authorization": f"Bearer {claude_delegated}"}, api_key_helper=f"printf %s {helper}")
    canaries.update({"claude delegated token (permission_hook.json)": claude_delegated, "claude apiKeyHelper value": helper})
    crelay = cb.start_tool_relay(bridge_dir=CB, tools=[], tool_executor=no_tool, loop=loop)
    canaries["claude bridge tool relay token"] = json.loads((CB / "tool_relay.json").read_text())["token"]

    # ------------------------------------------------------------- 1. inventory
    inventory: dict[str, dict] = {}
    unclassified: list[str] = []
    roots = [home] + ([tmp] if tmp_rel is None else [])
    for base in roots:
        for p in sorted(base.rglob("*")):
            rel = str(p.relative_to(home)) if base == home else "$TMPDIR/" + str(p.relative_to(tmp))
            if rel.startswith(("layers", ".codex/", ".claude/.credentials")) or rel in (".codex", ".claude"):
                continue
            if base == home:
                d = bp.decide(rel, tmp_rel=tmp_rel)
                rule, action = d.rule, d.action
            else:
                rule, action = _tmp_rule(bp, str(p.relative_to(tmp)))
            kind = "link" if p.is_symlink() else "dir" if p.is_dir() else "socket" if p.is_socket() else "file"
            if p.is_file() and not p.is_symlink() and os.lstat(p).st_nlink > 1:
                kind = "hard link"
            entry = inventory.setdefault(rule, {"action": action, "paths": []})
            entry["paths"].append(f"{_mask(rel)} ({kind})")
            if action == "unclassified":
                unclassified.append(_mask(rel))
    check("every path in a Codex bridge is classified", not unclassified)

    real_decide = bp.decide
    # The scan finds what it looks for: a layer that saves everything holds the planted values.
    def save_all(rel, *, tmp_rel=None):
        return bp.Decision("save", "control:save everything", "control")

    bp.decide = save_all
    try:
        A = layers_dir / "control-save-all.tar.gz"
        bp.write_layer(home, A, tmp_rel=tmp_rel)
    finally:
        bp.decide = real_decide
    scan_control = sorted({f["canary"] for f in bp.scan_layer(A, canaries)})
    check("control: the scan finds the logins and the bridge tokens when nothing is excluded",
          any(c.startswith("login ") for c in scan_control) and "router token" in scan_control)


    # ------------------------------------------------------------- 3. Codex's restore test
    # Base while the server is unreachable; a second undelivered event and a private setting
    # change; then a delta.
    os.replace = real_replace
    L0, L1 = layers_dir / "w-base.tar.gz", layers_dir / "w-delta1.tar.gz"
    m0 = bp.write_layer(home, L0, tmp_rel=tmp_rel)
    async with httpx.AsyncClient(base_url="http://omnigent.test", transport=httpx.MockTransport(unreachable)) as down:
        token_ctx = forwarder._dead_letter_dir.set(B)
        try:
            await forwarder._post_session_event(down, session_id, event_type="external_conversation_item",
                                                data=item(2, "S6 undelivered item two"), max_attempts=1)
        finally:
            forwarder._dead_letter_dir.reset(token_ctx)
    app_server._pin_codex_config_model(CH, "gpt-private-s6-b")
    m1 = bp.write_layer(home, L1, parent_index=m0["index"], tmp_rel=tmp_rel)
    queue_rel = str((B / "dead_letter.jsonl").relative_to(home))
    check("the delta carries the queue and the private config", queue_rel in m1["members"] and
          str((CH / "config.toml").relative_to(home)) in m1["members"])
    rc53 = {L.name: bp.scan_layer(L, canaries) for L in (L0, L1)}
    check("RC-53: no planted value in any layer", not any(rc53.values()))
    relay.close()
    crelay.close()
    saved_logins = {rel: (home / rel).read_bytes() for rel in logins}  # the credential checkpoint

    fake = FakeServer(thread_items=[item(0, "S6 delivered before the outage")])

    async def reconcile(new_home: Path) -> dict:
        Bn = new_home / B.relative_to(home)
        CHn = Bn / "codex-home"
        for rel, data in saved_logins.items():  # credential checkpoint: staged install
            p = new_home / rel
            p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            p.write_bytes(data)
            p.chmod(0o600)
        CHn.mkdir(parents=True, exist_ok=True, mode=0o700)
        # A start: Omnigent re-links the login into the private home.
        codex_executor._populate_codex_home_config(CHn, new_home / ".codex", minimal_config=False, inject_hooks=False,
                                                   extend_model_catalog=False, include_credentials=True)
        out = {"auth_link_restored_as_symlink": (CHn / "auth.json").is_symlink(),
               "mcp_login_relinked_same_inode": (CHn / ".credentials.json").exists() and
               os.stat(CHn / ".credentials.json").st_ino == os.stat(new_home / ".codex/.credentials.json").st_ino,
               "private_model_kept": 'gpt-private-s6-b' in (CHn / "config.toml").read_text() if (CHn / "config.toml").exists() else False,
               "developer_instructions_kept": (CHn / ".omnigent-developer-instructions-state.toml").exists(),
               "queue_records_before": _count_lines(Bn / "dead_letter.jsonl")}
        async with httpx.AsyncClient(base_url="http://omnigent.test", transport=httpx.MockTransport(fake.handle)) as up:
            target = await xmain._ensure_local_codex_resume_rollout(up, session_id=session_id, external_session_id=thread,
                                                                    codex_home=CHn, workspace=work, model_provider="openai",
                                                                    codex_path=None)
        text = target.read_text()
        out.update({"queue_records_after": _count_lines(Bn / "dead_letter.jsonl"),
                    "rollout_has_item_one": "S6 undelivered item one" in text,
                    "rollout_has_item_two": "S6 undelivered item two" in text,
                    "rollout_has_delivered_item": "S6 delivered before the outage" in text})
        return out

    def replace_disk(policy_override=None) -> Path:
        shutil.rmtree(home)
        if tmp_rel is None:
            shutil.rmtree(tmp)
            tmp.mkdir(mode=0o700)
        home.mkdir(mode=0o700)
        stripped = bp.restore_layers([L0, L1], home, tmp_rel=tmp_rel)
        check("restore stripped nothing (no excluded member in any layer)", not stripped["stripped"])
        return home

    restore1 = await reconcile(replace_disk())
    after_first = fake.snapshot()
    # The same checkpoint again (taken before the replay): a crash before the next save.
    restore2 = await reconcile(replace_disk())
    after_second = fake.snapshot()
    for k in ("auth_link_restored_as_symlink", "mcp_login_relinked_same_inode", "private_model_kept",
              "developer_instructions_kept", "rollout_has_item_one", "rollout_has_item_two", "rollout_has_delivered_item"):
        check(f"restore 1: {k}", restore1[k] is True)
        check(f"restore 2: {k}", restore2[k] is True)
    check("restore 1: the queue held both events, and replay emptied it",
          restore1["queue_records_before"] == 2 and restore1["queue_records_after"] == 0)
    check("each undelivered event became one server item", after_first["items_per_source"] == {
        f"{thread}:turn_1:item_1": 1, f"{thread}:turn_2:item_2": 1})
    check("replayed again after the second restore, still one item each (server dedupes by source_id)",
          after_second["items_per_source"] == after_first["items_per_source"]
          and all(n == 2 for n in after_second["posts_per_source"].values()))
    queue_types = {json.loads(line)["event_type"] for L in (L0, L1) for line in _queue_lines(L, queue_rel)}
    check("the queue holds transcript or usage events only, never an action",
          queue_types <= {"external_conversation_item", "external_session_usage"})

    # Negative control: the old blanket exclusion of the whole bridge directory.

    def blanket(rel, *, tmp_rel=None):
        if rel.startswith(".omnigent/codex-native/"):
            return bp.Decision("exclude", "control:whole bridge directory", "control")
        return real_decide(rel, tmp_rel=tmp_rel)

    shutil.rmtree(home)
    home.mkdir(mode=0o700)
    bp.restore_layers([L0, L1], home, tmp_rel=tmp_rel)  # restore the real layers ...
    bp.decide = blanket
    try:
        C0 = layers_dir / "control.tar.gz"
        bp.write_layer(home, C0, tmp_rel=tmp_rel)  # ... and capture them the old way
        shutil.rmtree(home)
        home.mkdir(mode=0o700)
        bp.restore_layers([C0], home, tmp_rel=tmp_rel)
    finally:
        bp.decide = real_decide
    control_fake = FakeServer(thread_items=[item(0, "S6 delivered before the outage")])
    fake_saved, fake = fake, control_fake
    control = await reconcile(home)
    fake = fake_saved
    check("control: the blanket exclusion loses the undelivered events",
          not control["rollout_has_item_one"] and not control["rollout_has_item_two"])
    check("control: and the private configuration", not control["private_model_kept"])

    # ------------------------------------------------------------- controls for the checks
    # Exact final names only (the residual G1BR-001 named): a writer paused before its rename
    # leaves a temporary file holding the secret, and the layer captures it.
    finals = {"policy_hook.json", "bridge.json", "server.json", "tool_relay.json", "tool_relay.env",
              "turn_router.json", "subagent_router.json", "auth.json", ".credentials.json"}

    def exact_names(rel, *, tmp_rel=None):
        if Path(rel).name in finals:
            return bp.Decision("exclude", "control:exact final names only", "control")
        if rel.startswith(".omnigent/codex-native/"):
            return bp.Decision("save", "control:exact final names only", "control")
        return real_decide(rel, tmp_rel=tmp_rel)

    exact_control: dict = {}

    def replace_exact(src, dst, *args, **kwargs):
        if Path(dst).name == "policy_hook.json":
            values = {"value": v for v in _secret_values(Path(src).read_text())}
            E = layers_dir / "control-exact.tar.gz"
            bp.decide = exact_names
            try:
                m = bp.write_layer(home, E, tmp_rel=tmp_rel)
            finally:
                bp.decide = real_decide
            rel_tmp = str(Path(src).relative_to(home))
            exact_control.update(temporary_in_layer=rel_tmp in m["members"],
                                 secret_found=bool(bp.scan_layer(E, values)))
        return real_replace(src, dst, *args, **kwargs)

    os.replace = replace_exact
    try:
        Bc = home / B.relative_to(home)
        Bc.mkdir(parents=True, exist_ok=True, mode=0o700)
        xb.write_policy_hook_config(Bc, ap_server_url="http://127.0.0.1:9",
                                    ap_auth_headers={"Authorization": f"Bearer {canary('exactcontrol')}"})
    finally:
        os.replace = real_replace
    check("control: exact names only capture the paused temporary and its secret",
          exact_control.get("temporary_in_layer") is True and exact_control.get("secret_found") is True)

    # ------------------------------------------------------------- 4. the "decide" case
    key = canary("providerkey")
    os.replace = replace_with_pause
    try:
        ov = codex_executor._provider_codex_config_overrides(model="m", base_url="http://127.0.0.1:9",
                                                             auth_command=f"printf %s '{key}'", wire_api="responses")
        codex_executor.materialize_codex_provider_config(home / B.relative_to(home) / "codex-home", ov)
    finally:
        os.replace = real_replace
    K = layers_dir / "key-provider.tar.gz"
    bp.write_layer(home, K, tmp_rel=tmp_rel)
    key_found = bp.scan_layer(K, {"Omnigent key provider's API key": key})
    key_paused = [p for p in paused if p["writer_target"].endswith("config.toml")]

    return {
        "omnigent": "cfo/integration af3e49de2",
        "variant": variant,
        "tmpdir_inside_home": tmp_rel is not None,
        "failures": failures,
        "values_planted": sorted(canaries),
        "inventory": inventory,
        "paused_writers": paused,
        "rc53_layer_scan": rc53,
        "restore_1": restore1,
        "restore_2_same_checkpoint": restore2,
        "server_after_restore_1": after_first,
        "server_after_restore_2": after_second,
        "negative_control_whole_bridge_excluded": control,
        "control_scan_save_everything": scan_control,
        "control_exact_final_names_only": exact_control,
        "decide_case_key_provider": {"key_in_layer": key_found, "paused_temporary": key_paused,
                                     "note": "Expected: the classification saves config.toml, so a literal provider key is captured; the lead decides (fork change, scrub, or an RC-53 exception)."},
        "layer_bytes": {L.name: L.stat().st_size for L in (L0, L1)},
    }


class FakeServer:
    """Omnigent's session item store, idempotent by source_id as the real one is."""

    def __init__(self, thread_items):
        self.items: dict[str, dict] = {}
        self.posts: dict[str, int] = {}
        for it in thread_items:
            self._accept(it)

    def _accept(self, data):
        sid = data["source_id"]
        self.posts[sid] = self.posts.get(sid, 0) + 1
        if sid not in self.items:
            self.items[sid] = {**data["item_data"], "type": data["item_type"], "response_id": data["response_id"],
                               "id": f"item_{len(self.items)}"}

    def handle(self, request):
        import httpx

        if request.method == "POST" and request.url.path.endswith("/events"):
            body = json.loads(request.content)
            if body.get("type") == "external_conversation_item":
                self._accept(body["data"])
            return httpx.Response(200, json={"ok": True})
        if request.method == "GET" and request.url.path.endswith("/items"):
            return httpx.Response(200, json={"data": list(self.items.values()), "has_more": False})
        return httpx.Response(404, json={"error": "fake"})

    def snapshot(self):
        # The fake stores one item per source_id, as the real server's idempotent item ids do;
        # what this run shows is that every replay re-posts under the same source_id.
        return {"items_total": len(self.items),
                "items_per_source": {k: 1 for k in self.items if k.split(":")[1] != "turn_0"},
                "posts_per_source": {k: v for k, v in self.posts.items() if k.split(":")[1] != "turn_0"}}


def _strings(v, path=""):
    if isinstance(v, dict):
        for k, x in v.items():
            yield from _strings(x, f"{path}.{k}" if path else k)
    elif isinstance(v, str):
        yield path, v


def _secret_values(text: str) -> list[str]:
    import re

    return sorted(set(re.findall(r"CFO_CANARY_[A-Za-z0-9]+", text)) | set(
        m for m in re.findall(r'"token":\s*"([A-Za-z0-9_\-]{20,})"', text)) | set(
        m for m in re.findall(r"OMNIGENT_RELAY_TOKEN='([^']+)'", text)))


def _temp_shape(tmp_name: str, final: str) -> str:
    import re

    return re.sub(r"[A-Za-z0-9_]{8}(?=(\.tmp)?$)", "<8>", tmp_name) if tmp_name != final else tmp_name


def _mask(rel: str) -> str:
    import re

    rel = re.sub(r"codex-native/[0-9a-f]{32}", "codex-native/<hash>", rel)
    rel = re.sub(r"claude-native/[0-9a-f]{32}", "claude-native/<hash>", rel)
    rel = re.sub(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<uuid>", rel)
    rel = re.sub(r"omnigent-\d+", "omnigent-<uid>", rel)
    rel = re.sub(r"(\.[A-Za-z_.\-]+\.(json|toml|jsonl)\.)[A-Za-z0-9_]{8}(\.tmp)?$", r"\1<8>\3", rel)
    rel = re.sub(r"mcp-\d+\.sock", "mcp-<pid>.sock", rel)
    rel = re.sub(r"\.\d+\.wait$", ".<pid>.wait", rel)
    rel = re.sub(r"/[0-9a-f]{32}(\.[a-z.]+)?$", r"/<hash>\1", rel)
    return rel


def _tmp_rule(bp, rel_in_tmp: str) -> tuple[str, str]:
    for rule in bp.RULES:
        if rule.root == "tmp" and any(p.match(rel_in_tmp) for p in rule.patterns):
            return f"{rule.id} (outside the home: not captured)", "outside"
    return "tmp: no rule (outside the home: not captured)", "outside"


def _count_lines(p: Path) -> int:
    return len([x for x in p.read_text().splitlines() if x.strip()]) if p.exists() else 0


def _queue_lines(layer: Path, rel: str) -> list[str]:
    import gzip
    import io
    import tarfile

    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(layer.read_bytes()))) as tar:
        try:
            return [x for x in tar.extractfile(rel).read().decode().splitlines() if x.strip()]
        except KeyError:
            return []


if __name__ == "__main__":
    raise SystemExit(main())
