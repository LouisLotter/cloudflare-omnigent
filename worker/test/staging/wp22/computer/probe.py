"""WP2.2 staging: a stand-in for a computer's live connection (not Omnigent's host).

It holds one WebSocket to ws://omnigent.internal/ws, which the computer container's intercept
sends through the platform Worker's ComputerRoute to OmnigentServer and the server container's
echo, the path a host's tunnel takes on A'. It sends a message every second and reconnects half
a second after any drop. Drops are recorded by the server's log; this prints its own view to
stdout as one JSON line per event.
"""

from __future__ import annotations

import asyncio
import json
import os
import time

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

URL = os.environ.get("WP22_URL", "ws://omnigent.internal/ws?client=computer")


def say(ev: str, **fields: object) -> None:
    print(json.dumps({"ev": ev, "wall": round(time.time() * 1000, 3), **fields}), flush=True)


async def hold() -> None:
    attempt = 0
    while True:
        attempt += 1
        try:
            async with connect(URL, open_timeout=10, ping_interval=None) as ws:
                say("open", attempt=attempt)
                seq = 0
                while True:
                    seq += 1
                    await ws.send(f"ping {seq}")
                    await asyncio.wait_for(ws.recv(), timeout=5)
                    await asyncio.sleep(1)
        except (ConnectionClosed, OSError, TimeoutError, asyncio.TimeoutError) as error:
            say("drop", attempt=attempt, error=type(error).__name__)
        except Exception as error:  # noqa: BLE001 - the probe must keep trying
            say("error", attempt=attempt, error=f"{type(error).__name__}: {error}"[:200])
        await asyncio.sleep(0.5)


if __name__ == "__main__":
    asyncio.run(hold())
