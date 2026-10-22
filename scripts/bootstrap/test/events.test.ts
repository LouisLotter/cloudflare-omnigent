import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, parseLogs, type StatusEvent, verifyRelease } from "../events.ts";
import { INSTALLATION } from "./fixtures.ts";

const SCRIPT = "cloudflare-omnigent";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const OTHER = "ins_01hs3f9q2m8z4w7k6t5r1n0yzz";

function line(
  at: number,
  initialized: boolean,
  reason: string,
  extra: { installationId?: string; version?: string; secretPresent?: boolean } = {},
) {
  return {
    cfo: "bootstrap",
    event: "status",
    reason,
    bootstrapStatus: {
      protocolVersion: 1,
      installationId: extra.installationId ?? INSTALLATION,
      initialized,
      checkedAt: new Date(at).toISOString(),
    },
    secretPresent: extra.secretPresent ?? true,
  };
}

function event(at: number, source: unknown, version = "v1", script = SCRIPT, eventType = "alarm") {
  return {
    timestamp: at,
    $workers: {
      scriptName: script,
      scriptVersion: { id: version },
      eventType,
      entrypoint: "OmnigentServer",
    },
    $metadata: { id: `e${at}` },
    source,
  };
}

function status(
  at: number,
  initialized: boolean,
  reason: string,
  installationId = INSTALLATION,
): StatusEvent {
  return {
    loggedAt: at,
    versionId: "v1",
    status: {
      protocolVersion: 1,
      installationId,
      initialized,
      checkedAt: new Date(at).toISOString(),
    },
    reason,
    secretPresent: true,
  };
}

describe("parseLogs", () => {
  it("reads a status that Workers Logs parsed into source, or kept as a message", () => {
    const parsed = parseLogs(
      [
        event(NOW, line(NOW, true, "durable")),
        event(NOW - 1000, {
          level: "info",
          message: JSON.stringify(line(NOW - 1000, false, "not_replicated")),
        }),
      ],
      SCRIPT,
    );
    expect(parsed.statuses.map((s) => [s.status.initialized, s.reason, s.versionId])).toEqual([
      [true, "durable", "v1"],
      [false, "not_replicated", "v1"],
    ]);
    expect(parsed.invocations).toHaveLength(2);
    expect(parsed.malformed).toBe(0);
  });

  it("ignores other scripts, other lines and events without a time", () => {
    const parsed = parseLogs(
      [
        event(NOW, line(NOW, true, "durable"), "v1", "cfo-stg-other-platform"),
        event(NOW, { cfo: "watchdog", event: "server_ready" }),
        event(NOW, { level: "info", message: "not json" }),
        event(NOW, { level: "info", message: "[1,2]" }),
        { ...event(NOW, line(NOW, true, "durable")), timestamp: "soon" },
        null,
        "text",
        { $workers: null },
      ],
      SCRIPT,
    );
    expect(parsed.statuses).toEqual([]);
    expect(parsed.invocations).toHaveLength(3);
  });

  it("never accepts a line that is not the contract, and counts it", () => {
    const bad = [
      {
        ...line(NOW, true, "durable"),
        bootstrapStatus: { ...line(NOW, true, "durable").bootstrapStatus, extra: 1 },
      },
      {
        ...line(NOW, true, "durable"),
        bootstrapStatus: { ...line(NOW, true, "durable").bootstrapStatus, protocolVersion: 2 },
      },
      {
        ...line(NOW, true, "durable"),
        bootstrapStatus: { ...line(NOW, true, "durable").bootstrapStatus, installationId: "ins_x" },
      },
      {
        ...line(NOW, true, "durable"),
        bootstrapStatus: { ...line(NOW, true, "durable").bootstrapStatus, initialized: "true" },
      },
      { ...line(NOW, true, "durable"), bootstrapStatus: null },
    ];
    const parsed = parseLogs(
      bad.map((b) => event(NOW, b)),
      SCRIPT,
    );
    expect(parsed.statuses).toEqual([]);
    expect(parsed.malformed).toBe(5);
  });

  it("takes a status only from the OmnigentServer object's own invocations, never the container's output", () => {
    const fromContainer = {
      ...event(NOW, line(NOW, true, "durable")),
      $workers: { scriptName: SCRIPT },
    };
    const otherClass = event(NOW, line(NOW, true, "durable"));
    (otherClass.$workers as Record<string, unknown>).entrypoint = "ControlDO";
    const parsed = parseLogs([fromContainer, otherClass], SCRIPT);
    expect(parsed.statuses).toEqual([]);
    expect(parsed.malformed).toBe(2);
  });

  it("keeps the version, the reason and the secret flag only when they are given properly", () => {
    const raw = {
      ...event(NOW, { ...line(NOW, true, "durable"), reason: 7, secretPresent: "yes" }),
    };
    (raw.$workers as { scriptVersion: unknown }).scriptVersion = { id: "" };
    const [only] = parseLogs([raw], SCRIPT).statuses;
    expect(only).toMatchObject({
      versionId: undefined,
      reason: undefined,
      secretPresent: undefined,
    });
  });
});

describe("decide", () => {
  const rules = { installationId: INSTALLATION, now: NOW };

  it("accepts the newest fresh durable status of this installation", () => {
    const d = decide(
      [status(NOW - 120_000, false, "not_replicated"), status(NOW - 60_000, true, "durable")],
      rules,
    );
    expect(d).toMatchObject({ accepted: true, event: { status: { initialized: true } } });
  });

  it("waits while no status has arrived, or only another installation's", () => {
    expect(decide([], rules)).toMatchObject({
      accepted: false,
      why: expect.stringContaining("no bootstrap status yet"),
    });
    expect(decide([status(NOW, true, "durable", OTHER)], rules)).toMatchObject({
      accepted: false,
      why: "the only bootstrap statuses are another installation's",
    });
  });

  it("follows the newest status: an older durable one does not count after a newer setback", () => {
    const d = decide(
      [status(NOW - 120_000, true, "durable"), status(NOW - 60_000, false, "boot_changed")],
      rules,
    );
    expect(d).toMatchObject({
      accepted: false,
      why: "the server restarted between the watchdog's reads",
    });
  });

  it("orders by the watchdog's time, then by Workers Logs' time", () => {
    const same = NOW - 30_000;
    const early = { ...status(same, true, "durable"), loggedAt: same };
    const late = { ...status(same, false, "not_replicated"), loggedAt: same + 5 };
    expect(decide([late, early], rules).accepted).toBe(false);
    expect(decide([early, late], rules).accepted).toBe(false);
  });

  it("refuses a status that is too old, or from the future", () => {
    expect(decide([status(NOW - 11 * 60_000, true, "durable")], rules)).toMatchObject({
      accepted: false,
      why: "the newest bootstrap status is too old",
    });
    expect(decide([status(NOW + 6 * 60_000, true, "durable")], rules)).toMatchObject({
      accepted: false,
      why: expect.stringContaining("check this laptop's clock"),
    });
    expect(decide([status(NOW + 4 * 60_000, true, "durable")], rules).accepted).toBe(true);
  });

  it("explains each reason the watchdog gives, and an unknown one", () => {
    for (const [reason, why] of [
      ["not_initialized", "Omnigent does not show the owner yet"],
      ["not_replicated", "the owner exists but its record is not replicated yet"],
      ["info_unavailable", "the watchdog could not read Omnigent's /v1/info"],
      ["position_unavailable", "the watchdog could not read the replicated position"],
      ["boot_changed", "the server restarted between the watchdog's reads"],
      ["something_new", "the owner is not initialized and durable yet"],
    ] as const) {
      expect(decide([status(NOW, false, reason)], rules)).toMatchObject({ accepted: false, why });
    }
  });

  it("refuses an initialized status that gives another reason than durable", () => {
    expect(decide([status(NOW, true, "not_replicated")], rules)).toMatchObject({
      accepted: false,
      why: "the newest bootstrap status contradicts itself",
    });
    // The watchdog always gives the reason: a line without one is not accepted (review r1).
    const noReason = { ...status(NOW, true, "durable"), reason: undefined };
    expect(decide([noReason], rules)).toMatchObject({
      accepted: false,
      why: "the newest bootstrap status contradicts itself",
    });
  });

  it("never lets an older answer roll back a status seen earlier (review r1, F3)", () => {
    const seenNegative = status(NOW - 30_000, false, "boot_changed");
    const olderPositive = status(NOW - 60_000, true, "durable");
    expect(decide([olderPositive], { ...rules, seen: seenNegative })).toMatchObject({
      accepted: false,
      why: "the server restarted between the watchdog's reads",
      latest: seenNegative,
    });
    // A remembered positive holds back too: acceptance needs a status in this answer.
    expect(decide([], { ...rules, seen: status(NOW - 30_000, true, "durable") })).toMatchObject({
      accepted: false,
      why: "waiting for the watchdog's next status",
    });
    expect(decide([], { ...rules, seen: { ...seenNegative, reason: "new" } })).toMatchObject({
      why: "the owner is not initialized and durable yet",
    });
    // The same status seen again, or a newer one, decides as usual.
    expect(decide([seenNegative], { ...rules, seen: seenNegative }).accepted).toBe(false);
    const again = status(NOW - 30_000, true, "durable");
    expect(decide([again], { ...rules, seen: again }).accepted).toBe(true);
    expect(
      decide([status(NOW - 10_000, true, "durable")], { ...rules, seen: seenNegative }).accepted,
    ).toBe(true);
    // Another installation's remembered status does not count.
    expect(
      decide([olderPositive], { ...rules, seen: status(NOW, false, "boot_changed", OTHER) })
        .accepted,
    ).toBe(true);
  });

  it("property: accepts exactly when this installation's newest status is fresh and durable", () => {
    const arb = fc.array(
      fc.record({
        age: fc.integer({ min: -4 * 60_000, max: 20 * 60_000 }),
        initialized: fc.boolean(),
        mine: fc.boolean(),
      }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(arb, (specs) => {
        const statuses = specs.map((s, i) => ({
          ...status(
            NOW - s.age,
            s.initialized,
            s.initialized ? "durable" : "not_replicated",
            s.mine ? INSTALLATION : OTHER,
          ),
          loggedAt: i,
        }));
        const mine = statuses.filter((s) => s.status.installationId === INSTALLATION);
        const d = decide(statuses, rules);
        if (mine.length === 0) {
          expect(d.accepted).toBe(false);
          return;
        }
        const newestTime = Math.max(...mine.map((s) => Date.parse(s.status.checkedAt)));
        const newest = mine.filter((s) => Date.parse(s.status.checkedAt) === newestTime).at(-1);
        const expected = newest?.status.initialized === true && NOW - newestTime <= 10 * 60_000;
        expect(d.accepted).toBe(expected);
        if (d.accepted) expect(d.event.status.installationId).toBe(INSTALLATION);
      }),
    );
  });
});

describe("verifyRelease", () => {
  const released = NOW;
  const rules = { installationId: INSTALLATION, releasedVersionId: "v2", releasedAt: released };
  const logsOf = (events: unknown[]) => parseLogs(events, SCRIPT);

  it("passes once OmnigentServer runs the released version, and nothing reports the password after", () => {
    const logs = logsOf([
      event(released - 60_000, line(released - 60_000, true, "durable")),
      event(released + 60_000, line(released + 60_000, true, "durable")),
      event(released + 360_000, { cfo: "watchdog", event: "noop" }, "v2"),
    ]);
    expect(verifyRelease(logs, rules)).toEqual({ verified: true });
  });

  it("waits while the old version runs, and fails while the released one reports the password", () => {
    expect(
      verifyRelease(
        logsOf([event(released + 60_000, line(released + 60_000, true, "durable"))]),
        rules,
      ),
    ).toMatchObject({
      verified: false,
      why: expect.stringContaining("has not run on the released version"),
    });
    expect(
      verifyRelease(
        logsOf([
          event(released + 300_000, line(released + 300_000, true, "durable"), "v2"),
          event(released + 300_000, { cfo: "watchdog" }, "v2"),
        ]),
        rules,
      ),
    ).toMatchObject({
      verified: false,
      why: "the released version still reports the bootstrap password",
    });
    expect(
      verifyRelease(
        logsOf([
          event(released + 300_000, { cfo: "watchdog" }, "v2"),
          event(released + 360_000, line(released + 360_000, true, "durable"), "v3"),
        ]),
        rules,
      ),
    ).toMatchObject({
      verified: false,
      why: "the bootstrap password was reported after the switch",
    });
  });

  it("counts only OmnigentServer's alarms on the released version, after the release (review r1, F6)", () => {
    const controlAlarm = event(released + 400_000, { cfo: "x" }, "v2");
    (controlAlarm.$workers as Record<string, unknown>).entrypoint = "ControlDO";
    const logs = logsOf([
      controlAlarm,
      event(released - 1, { cfo: "x" }, "v2"),
      event(released + 400_000, { cfo: "x" }, "v2", SCRIPT, "scheduled"),
      event(released + 400_000, { cfo: "x" }, "v9"),
      {
        ...event(released + 400_000, { cfo: "x" }),
        $workers: { scriptName: SCRIPT, eventType: "alarm", entrypoint: "OmnigentServer" },
      },
    ]);
    expect(verifyRelease(logs, rules).verified).toBe(false);
  });

  it("cannot check without the released version", () => {
    expect(verifyRelease(logsOf([]), { ...rules, releasedVersionId: undefined })).toMatchObject({
      verified: false,
      why: expect.stringContaining("did not say which version"),
    });
  });
});
