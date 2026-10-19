"""Raw tunnel probe: one WebSocket to ws://omnigent.internal/_s2/echo, held open.

Sends a ping every PING_S seconds and measures the round trip through the intercept, the
PrivateRoute and the ServerDO. Reports every connect and every drop at once, and a summary
every minute. Reconnects after RETRY_S seconds, so a drop's outage is measured to within
about a second.
"""

from __future__ import annotations

import asyncio
import json
import statistics
import time

import websockets

from s2common import SERVER_URL, now_ms, report

PING_S = 5.0
RETRY_S = 0.5
TIMEOUT_S = 10.0


class Stats:
    def __init__(self) -> None:
        self.rtts: list[float] = []
        self.lost = 0
        self.builds: set[str] = set()

    def flush(self, connected: bool, conn_id: int) -> None:
        rtts = sorted(self.rtts)
        summary: dict[str, object] = {"n": len(rtts), "lost": self.lost, "connected": connected}
        if rtts:
            summary.update(
                p50=round(statistics.median(rtts), 1),
                p95=round(rtts[min(len(rtts) - 1, int(len(rtts) * 0.95))], 1),
                max=round(rtts[-1], 1),
            )
        report("echo-minute", conn=conn_id, builds=sorted(self.builds), **summary)
        self.rtts.clear()
        self.lost = 0
        self.builds.clear()


async def run() -> None:
    url = SERVER_URL.replace("http://", "ws://") + "/_s2/echo?c=probe"
    stats = Stats()
    conn_id = 0
    down_since: int | None = now_ms()
    connected = False
    failures = 0

    async def minute() -> None:
        while True:
            await asyncio.sleep(60)
            stats.flush(connected, conn_id)

    asyncio.create_task(minute())
    while True:
        attempt_at = now_ms()
        try:
            async with websockets.connect(
                url, open_timeout=TIMEOUT_S, ping_interval=None, max_size=2**20
            ) as ws:
                conn_id += 1
                connected = True
                report(
                    "echo-up",
                    conn=conn_id,
                    connectMs=now_ms() - attempt_at,
                    outageMs=(now_ms() - down_since) if down_since else None,
                )
                down_since = None
                seq = 0
                while True:
                    seq += 1
                    sent = time.perf_counter()
                    await ws.send(json.dumps({"seq": seq, "ct": now_ms()}))
                    try:
                        reply = await asyncio.wait_for(ws.recv(), timeout=TIMEOUT_S)
                    except TimeoutError:
                        stats.lost += 1
                        report("echo-timeout", conn=conn_id, seq=seq)
                        raise
                    stats.rtts.append((time.perf_counter() - sent) * 1000)
                    stats.builds.add(json.loads(reply).get("build", "?"))
                    await asyncio.sleep(PING_S)
        except Exception as error:  # noqa: BLE001 - every failure is a measured drop
            if connected:
                down_since = now_ms()
                connected = False
                code = getattr(error, "code", None) or getattr(
                    getattr(error, "rcvd", None), "code", None
                )
                report("echo-down", conn=conn_id, error=type(error).__name__, code=code)
                failures = 0
            else:
                failures += 1
                if failures == 1 or failures % 20 == 0:
                    message = f"{type(error).__name__}: {str(error)[:160]}"
                    report("echo-fail", failures=failures, error=message)
            await asyncio.sleep(RETRY_S)


if __name__ == "__main__":
    asyncio.run(run())
