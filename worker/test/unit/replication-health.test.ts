// The replication warning's judge (WP3.5, `server/replication-health.ts`), from the entrypoint's
// `GET :8001/status` (FH-15's G3 part).
import { describe, expect, it } from "vitest";
import { judgeReplication } from "../../src/server/replication-health.ts";

const NOW = Date.parse("2026-10-22T09:20:00.000Z");
const running = (replication: unknown) => ({ phase: "running", replication });

describe("judgeReplication", () => {
  it.each([
    [null, "unknown"],
    [{ phase: "starting", replication: null }, "unknown"],
    [running(null), "unknown"],
    [running(undefined), "unknown"],
    [running({ error: "ConnectionRefusedError: litestream" }), "failing"],
    [running({ caughtUp: true, lastSyncAt: "2026-10-22T09:00:00Z" }), "replicating"],
    [running({ caughtUp: false, lastSyncAt: "2026-10-22T09:19:30.000Z" }), "replicating"],
    [running({ caughtUp: false, lastSyncAt: "2026-10-22T09:18:00.000Z" }), "lagging"],
    [running({ caughtUp: false, lastSyncAt: null }), "lagging"],
    [running({ caughtUp: false, lastSyncAt: "not a time" }), "lagging"],
    [running({ caughtUp: "yes" }), "unknown"],
  ])("%o → %s", (status, state) => {
    expect(judgeReplication(status, NOW).state).toBe(state);
  });

  it("reports Litestream's last sync and when it checked", () => {
    expect(
      judgeReplication(running({ caughtUp: true, lastSyncAt: "2026-10-22T09:19:59.5Z" }), NOW),
    ).toEqual({
      state: "replicating",
      lastSyncAt: "2026-10-22T09:19:59.500Z",
      checkedAt: "2026-10-22T09:20:00.000Z",
    });
  });
});
