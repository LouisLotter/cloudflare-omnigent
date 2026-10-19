"""Count user and assistant items in the S2 conversation, from the full item list, not the snapshot."""
import os

import httpx

base = os.environ["S2_SERVER_URL"]
with httpx.Client(base_url=base, timeout=30) as c:
    tok = c.post(
        "/auth/login",
        json={"username": os.environ["S2_ADMIN_USER"], "password": os.environ["S2_ADMIN_PASSWORD"]},
    ).json()["token"]
    c.headers["authorization"] = f"Bearer {tok}"
    sessions = c.get("/v1/sessions", params={"visibility": "all", "limit": 50}).json()["data"]
    for s in sessions:
        sid = s.get("id")
        snap = c.get(f"/v1/sessions/{sid}", params={"include_usage": "false"}).json()
        items = snap.get("items") or []
        if not items:
            continue
        roles = {"user": 0, "assistant": 0}
        after = None
        total = 0
        while True:
            params = {"limit": 100, "order": "asc"}
            if after:
                params["after"] = after
            page = c.get(f"/v1/sessions/{sid}/items", params=params).json()
            data = page.get("data") or []
            for it in data:
                role = (it.get("data") or {}).get("role") or it.get("role")
                last = it
                if role in roles:
                    roles[role] += 1
                total += 1
            if not page.get("has_more") or not data:
                break
            after = page.get("last_id") or data[-1].get("id")
        print("last item:", last.get("type"), (last.get("data") or {}).get("role") or last.get("role"), sorted(last.keys())[:8])
        snap_assist = sum(1 for i in items if (i.get("data") or {}).get("role") == "assistant")
        print(
            f"session status={snap.get('status')} snapshot_items={len(items)} "
            f"snapshot_assistant={snap_assist} all_items={total} all_user={roles['user']} "
            f"all_assistant={roles['assistant']}"
        )
