"""Omnigent's own native-harness writers, driven for the image's bridge tests (from S6).

Runs on Omnigent's interpreter (``/opt/venv/bin/python -I``) with a throwaway HOME and TMPDIR,
as a workload process the test's capture pauses. Synthetic canary values only; no CLI, server,
account or network: the Omnigent server is a fake on an httpx mock transport.

    bridge_writers.py writers <ctl dir>   every secret writer, each paused before its rename
    bridge_writers.py session-1 <ctl>     a native Codex session and one undelivered event
    bridge_writers.py session-2 <ctl>     a second undelivered event and a private-model change
    bridge_writers.py reconcile <ctl> <server.json> <out.json>
                                          after a restore: re-link the login, cold-resume

Pauses: ``os.replace`` is wrapped in this process only (Omnigent's files are untouched). When
a writer is about to rename a temporary file into a secret family member, it records the
temporary and the values in it to ``<ctl>/paused.json`` and waits for ``<ctl>/go``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import sys
import time
import uuid
from pathlib import Path

CANARY = "CFO_" + "CANARY_"
HOME = Path(os.environ["HOME"])
SESSION = "conv_cfo34bridge"
THREAD = "0199c3a4-7b2e-7c1d-9f00-0000000034ab"
WATCHED = {
    "policy_hook.json",
    "bridge.json",
    "tool_relay.json",
    "server.json",
    "turn_router.json",
    "subagent_router.json",
    "provider_key",
}


def canary(label: str) -> str:
    return f"{CANARY}B34{label}{secrets.token_hex(10)}"


def values_in(text: str) -> list[str]:
    return sorted(
        set(re.findall(r"CFO_CANARY_[A-Za-z0-9]+", text))
        | set(re.findall(r'"token":\s*"([A-Za-z0-9_\-]{20,})"', text))
    )


def wait_for(path: Path, timeout: float = 120.0) -> None:
    end = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() > end:
            raise SystemExit(f"no {path.name} from the test")
        time.sleep(0.01)
    path.unlink()


def writers(ctl: Path) -> None:
    real_replace = os.replace
    planted: dict[str, str] = {}

    def paused_replace(src, dst, *args, **kwargs):
        srcp, dstp = Path(src), Path(dst)
        if dstp.name in WATCHED and srcp.exists():
            text = srcp.read_text(errors="replace")
            record = {
                "target": str(dstp.relative_to(HOME)) if dstp.is_relative_to(HOME) else str(dstp),
                "temporary": str(srcp.relative_to(HOME)) if srcp.is_relative_to(HOME) else None,
                "values": values_in(text),
            }
            tmp = ctl / "paused.json.tmp"
            tmp.write_text(json.dumps(record))
            real_replace(tmp, ctl / "paused.json")
            wait_for(ctl / "go")
        return real_replace(src, dst, *args, **kwargs)

    os.replace = paused_replace
    from omnigent.harnesses.claude_native import bridge as cb
    from omnigent.harnesses.codex_native import bridge as xb
    from omnigent.inner import codex_executor
    from omnigent.runner import subagent_routing

    bridge = xb.prepare_bridge_dir(SESSION)
    xb.write_mcp_bridge_config(bridge)
    delegated = canary("delegated")
    xb.write_policy_hook_config(
        bridge, ap_server_url="http://127.0.0.1:9", ap_auth_headers={"Authorization": f"Bearer {delegated}"}
    )
    renewed = canary("renewed")
    xb.update_policy_hook_auth_headers(bridge, {"Authorization": f"Bearer {renewed}"})
    planted.update(delegated=delegated, renewed=renewed)
    router = canary("router")
    subagent_routing.write_advertisement(bridge, url="http://127.0.0.1:9", token=router, filename="turn_router.json")
    subagent_routing.write_advertisement(bridge, url="http://127.0.0.1:9", token=router, filename="subagent_router.json")
    planted["router"] = router
    serve = canary("serve")
    cb._write_json_file(bridge / "server.json", {"token": serve, "pid": 1, "socket": "/nonexistent.sock"})
    planted["serve"] = serve

    async def relay() -> None:
        async def no_tool(name, args):
            return {}

        handle = cb.start_tool_relay(
            bridge_dir=bridge, tools=[], tool_executor=no_tool, loop=asyncio.get_running_loop(), session_id=SESSION
        )
        planted["relay"] = json.loads((bridge / "tool_relay.json").read_text())["token"]
        env = (bridge / "tool_relay.env").read_text() if (bridge / "tool_relay.env").exists() else ""
        planted.update({f"relay-env-{i}": v for i, v in enumerate(re.findall(r"='([^']+)'", env))})
        handle.close()

    asyncio.run(relay())
    # Core change 20: a key provider's key goes to <bridge>/provider_key, never config.toml.
    key = canary("providerkey")
    planted["provider-key"] = key
    codex_home = xb.codex_home_for_bridge_dir(bridge)
    overrides = codex_executor._provider_codex_config_overrides(
        model="m", base_url="http://127.0.0.1:9", api_key=key, wire_api="responses"
    )
    codex_executor.materialize_codex_provider_config(codex_home, overrides, key_file=bridge / "provider_key")
    planted["bridge.json"] = json.loads((bridge / "bridge.json").read_text())["token"]
    (ctl / "done.json").write_text(json.dumps({"planted": planted, "bridge": str(bridge.relative_to(HOME))}))


def _item(n: int, text: str) -> dict:
    return {
        "item_type": "message",
        "response_id": f"resp_{n}",
        "source_id": f"{THREAD}:turn_{n}:item_{n}",
        "item_data": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]},
    }


async def _dead_letter(bridge: Path, n: int, text: str) -> None:
    import httpx
    from omnigent.harnesses.codex_native import forwarder

    def unreachable(request):
        raise httpx.ConnectError("server unreachable (test)", request=request)

    async with httpx.AsyncClient(base_url="http://omnigent.test", transport=httpx.MockTransport(unreachable)) as down:
        token = forwarder._dead_letter_dir.set(bridge)
        try:
            result = await forwarder._post_session_event(
                down, SESSION, event_type="external_conversation_item", data=_item(n, text), max_attempts=1
            )
        finally:
            forwarder._dead_letter_dir.reset(token)
    assert result is None and (bridge / "dead_letter.jsonl").exists()


def session_1(ctl: Path) -> None:
    from omnigent.harnesses.codex_native import app_server
    from omnigent.harnesses.codex_native import bridge as xb
    from omnigent.inner import codex_executor

    bridge = xb.prepare_bridge_dir(SESSION)
    codex_home = xb.codex_home_for_bridge_dir(bridge)
    codex_home.mkdir(mode=0o700, parents=True, exist_ok=True)
    codex_executor._populate_codex_home_config(
        codex_home, HOME / ".codex", minimal_config=False, inject_hooks=False,
        extend_model_catalog=False, include_credentials=True,
    )
    app_server._pin_codex_config_model(codex_home, "gpt-private-34")
    app_server._sync_codex_developer_instructions(codex_home, "WP3.4 private instructions")
    rollout = codex_home / "sessions/2026/10/25" / f"rollout-2026-10-25T00-00-00-{THREAD}.jsonl"
    rollout.parent.mkdir(parents=True, exist_ok=True)
    rollout.write_text(json.dumps({"type": "session_meta", "payload": {
        "id": THREAD, "timestamp": "2026-10-25T00:00:00Z", "cwd": str(HOME / "work"), "cli_version": "0.0.0"}}) + "\n")
    asyncio.run(_dead_letter(bridge, 1, "WP3.4 undelivered item one"))
    (ctl / "session.json").write_text(json.dumps({"bridge": str(bridge.relative_to(HOME))}))


def session_2(ctl: Path) -> None:
    from omnigent.harnesses.codex_native import app_server
    from omnigent.harnesses.codex_native import bridge as xb

    bridge = xb.prepare_bridge_dir(SESSION)
    asyncio.run(_dead_letter(bridge, 2, "WP3.4 undelivered item two"))
    app_server._pin_codex_config_model(xb.codex_home_for_bridge_dir(bridge), "gpt-private-34-b")


class FakeServer:
    """Omnigent's session item store, idempotent by ``source_id`` as the real one is."""

    def __init__(self, path: Path) -> None:
        self.path = path
        state = json.loads(path.read_text()) if path.exists() else {"items": {}, "posts": {}}
        self.items, self.posts = state["items"], state["posts"]
        if not self.items:
            self._accept(_item(0, "WP3.4 delivered before the outage"))

    def _accept(self, data: dict) -> None:
        sid = data["source_id"]
        self.posts[sid] = self.posts.get(sid, 0) + 1
        if sid not in self.items:
            self.items[sid] = {**data["item_data"], "type": data["item_type"],
                               "response_id": data["response_id"], "id": f"item_{len(self.items)}"}

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

    def save(self) -> None:
        self.path.write_text(json.dumps({"items": self.items, "posts": self.posts}))


def reconcile(ctl: Path, server_path: Path, out: Path) -> None:
    import httpx
    from omnigent.harnesses.codex_native import bridge as xb
    from omnigent.harnesses.codex_native import main as xmain
    from omnigent.inner import codex_executor

    bridge = xb.prepare_bridge_dir(SESSION)
    codex_home = xb.codex_home_for_bridge_dir(bridge)
    codex_home.mkdir(mode=0o700, parents=True, exist_ok=True)
    codex_executor._populate_codex_home_config(
        codex_home, HOME / ".codex", minimal_config=False, inject_hooks=False,
        extend_model_catalog=False, include_credentials=True,
    )
    queue = bridge / "dead_letter.jsonl"
    before = len([x for x in queue.read_text().splitlines() if x.strip()]) if queue.exists() else 0
    config = (codex_home / "config.toml").read_text() if (codex_home / "config.toml").exists() else ""
    result = {
        "auth_link_is_symlink": (codex_home / "auth.json").is_symlink(),
        "mcp_login_same_inode": (codex_home / ".credentials.json").exists()
        and os.stat(codex_home / ".credentials.json").st_ino == os.stat(HOME / ".codex/.credentials.json").st_ino,
        "private_model_kept": "gpt-private-34-b" in config,
        "instructions_kept": (codex_home / ".omnigent-developer-instructions-state.toml").exists(),
        "queue_before": before,
    }
    server = FakeServer(server_path)

    async def resume() -> Path:
        transport = httpx.MockTransport(server.handle)
        async with httpx.AsyncClient(base_url="http://omnigent.test", transport=transport) as up:
            return await xmain._ensure_local_codex_resume_rollout(
                up, session_id=SESSION, external_session_id=THREAD, codex_home=codex_home,
                workspace=HOME / "work", model_provider="openai", codex_path=None,
            )

    text = asyncio.run(resume()).read_text()
    server.save()
    after = len([x for x in queue.read_text().splitlines() if x.strip()]) if queue.exists() else 0
    result.update(
        queue_after=after,
        rollout_has_one="WP3.4 undelivered item one" in text,
        rollout_has_two="WP3.4 undelivered item two" in text,
        rollout_has_delivered="WP3.4 delivered before the outage" in text,
        server_items={k: 1 for k in server.items if ":turn_0:" not in k},
        server_posts={k: v for k, v in server.posts.items() if ":turn_0:" not in k},
    )
    out.write_text(json.dumps(result))


def main() -> int:
    mode, ctl = sys.argv[1], Path(sys.argv[2])
    if mode == "writers":
        writers(ctl)
    elif mode == "session-1":
        session_1(ctl)
    elif mode == "session-2":
        session_2(ctl)
    elif mode == "reconcile":
        reconcile(ctl, Path(sys.argv[3]), Path(sys.argv[4]))
    else:
        raise SystemExit(f"unknown mode {mode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())


_ = uuid  # kept for parity with the S6 harness
