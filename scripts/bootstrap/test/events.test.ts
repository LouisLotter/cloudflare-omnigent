import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  appliedStatus,
  checkGitHubLinking,
  checkMcpServices,
  decide,
  integrationsOff,
  parseLogs,
  SERVER_HELD_WHY,
  type StatusEvent,
  verifyRelease,
} from "../events.ts";
import { INSTALLATION } from "./fixtures.ts";

const SCRIPT = "cloudflare-omnigent";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const OTHER = "ins_01hs3f9q2m8z4w7k6t5r1n0yzz";

function line(
  at: number,
  initialized: boolean,
  reason: string,
  extra: {
    installationId?: string;
    version?: string;
    secretPresent?: boolean;
    configApplied?: boolean;
  } = {},
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
    ...(extra.configApplied === undefined ? {} : { configApplied: extra.configApplied }),
  };
}

/** A status line from a server started with the logging version's configuration, after the release. */
function appliedLine(at: number, initialized = true, reason = "durable", installationId?: string) {
  return line(at, initialized, reason, {
    secretPresent: false,
    configApplied: true,
    ...(installationId === undefined ? {} : { installationId }),
  });
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
    configApplied: true,
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

  it("keeps the version, the reason and the flags only when they are given properly", () => {
    const raw = {
      ...event(NOW, {
        ...line(NOW, true, "durable"),
        reason: 7,
        secretPresent: "yes",
        configApplied: "true",
      }),
    };
    (raw.$workers as { scriptVersion: unknown }).scriptVersion = { id: "" };
    const [only] = parseLogs([raw], SCRIPT).statuses;
    expect(only).toMatchObject({
      versionId: undefined,
      reason: undefined,
      secretPresent: undefined,
      configApplied: undefined,
    });
    const [applied] = parseLogs([event(NOW, appliedLine(NOW))], SCRIPT).statuses;
    expect(applied).toMatchObject({ secretPresent: false, configApplied: true });
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

  it("passes once a server started with the released configuration reports itself, and nothing reports the password after", () => {
    const before = [
      event(released - 60_000, line(released - 60_000, true, "durable")),
      event(released + 60_000, line(released + 60_000, true, "durable")),
      event(released + 360_000, { cfo: "watchdog", event: "first_alarm" }, "v2"),
    ];
    // The released version runs, but the server it adopted still holds the old configuration.
    expect(verifyRelease(logsOf(before), rules)).toEqual({
      verified: false,
      why: expect.stringMatching(/^released, not yet applied: /),
    });
    const logs = logsOf([
      ...before,
      event(released + 450_000, appliedLine(released + 450_000), "v2"),
    ]);
    expect(verifyRelease(logs, rules)).toEqual({ verified: true });
  });

  it("counts as applied only this installation's line from the released version, after the release, without the password", () => {
    const run = event(released + 360_000, { cfo: "watchdog", event: "first_alarm" }, "v2");
    const notApplied = [
      // A build that does not say which configuration its server runs: never proof.
      event(
        released + 400_000,
        line(released + 400_000, true, "durable", { secretPresent: false }),
        "v2",
      ),
      event(
        released + 400_000,
        line(released + 400_000, true, "durable", { secretPresent: false, configApplied: false }),
        "v2",
      ),
      // Another version's, another installation's, or one from before the release.
      event(released + 400_000, appliedLine(released + 400_000), "v3"),
      event(released + 400_000, appliedLine(released + 400_000, true, "durable", OTHER), "v2"),
      event(released - 1, appliedLine(released - 1), "v2"),
    ];
    for (const lineEvent of notApplied) {
      expect(verifyRelease(logsOf([run, lineEvent]), rules)).toMatchObject({
        verified: false,
        why: expect.stringContaining("not yet applied"),
      });
    }
  });

  it("waits while the restarted server does not show a durable owner", () => {
    const run = event(released + 360_000, { cfo: "watchdog", event: "first_alarm" }, "v2");
    const notDurable = event(
      released + 420_000,
      appliedLine(released + 420_000, false, "not_replicated"),
      "v2",
    );
    expect(verifyRelease(logsOf([run, notDurable]), rules)).toEqual({
      verified: false,
      why: "released and applied, but the restarted server does not show a durable owner yet: the owner exists but its record is not replicated yet",
    });
    const unknown = event(released + 420_000, appliedLine(released + 420_000, false, "odd"), "v2");
    expect(verifyRelease(logsOf([run, unknown]), rules)).toMatchObject({
      why: expect.stringContaining("the owner is not initialized and durable yet"),
    });
    const durable = event(released + 480_000, appliedLine(released + 480_000), "v2");
    expect(verifyRelease(logsOf([run, notDurable, durable]), rules)).toEqual({ verified: true });
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

  it("says a server that refused a setting is held, until a server answers after it", () => {
    const run = event(released + 360_000, { cfo: "watchdog", event: "first_alarm" }, "v2");
    const refused = (at: number, version = "v2", held: unknown = true) =>
      event(at, { cfo: "watchdog", event: "config_error", exitCode: 78, held }, version);
    expect(verifyRelease(logsOf([run, refused(released + 400_000)]), rules)).toEqual({
      verified: false,
      why: SERVER_HELD_WHY,
      held: true,
    });
    expect(SERVER_HELD_WHY).toContain("cfo.config.error");
    // Not this version's, from before the release, or not holding the current configuration.
    for (const other of [
      refused(released + 400_000, "v1"),
      refused(released - 1),
      refused(released + 400_000, "v2", false),
      refused(released + 400_000, "v2", "yes"),
    ]) {
      expect(verifyRelease(logsOf([run, other]), rules)).toMatchObject({
        verified: false,
        why: expect.stringMatching(/^released, not yet applied: /),
      });
    }
    // A server answered after the hold (the setting changed): judged by that status.
    const answered = event(released + 460_000, appliedLine(released + 460_000), "v2");
    expect(verifyRelease(logsOf([run, refused(released + 400_000), answered]), rules)).toEqual({
      verified: true,
    });
    // A hold after the newest status wins.
    const before = event(released + 380_000, appliedLine(released + 380_000), "v2");
    expect(verifyRelease(logsOf([run, before, refused(released + 400_000)]), rules)).toMatchObject({
      held: true,
    });
  });
});

describe("appliedStatus: the status the release check judges (WP3.44)", () => {
  const released = NOW;
  const rules = { installationId: INSTALLATION, releasedVersionId: "v2", releasedAt: released };
  const logsOf = (events: unknown[]) => parseLogs(events, SCRIPT);

  it("is the newest applied line of this installation from the released version, after the release", () => {
    const first = event(released + 400_000, appliedLine(released + 400_000), "v2");
    const second = event(released + 460_000, appliedLine(released + 460_000), "v2");
    const ignored = [
      event(released + 500_000, appliedLine(released + 500_000), "v3"),
      event(released + 500_000, appliedLine(released + 500_000, true, "durable", OTHER), "v2"),
      event(released - 1, appliedLine(released - 1), "v2"),
      event(
        released + 500_000,
        line(released + 500_000, true, "durable", { secretPresent: false }),
        "v2",
      ),
      event(released + 500_000, line(released + 500_000, true, "durable"), "v2"),
    ];
    const logs = logsOf([first, second, ...ignored]);
    expect(appliedStatus(logs, rules)?.loggedAt).toBe(released + 460_000);
    expect(verifyRelease(logs, rules)).toEqual({
      verified: false,
      why: "the released version still reports the bootstrap password",
    });
    expect(appliedStatus(logsOf(ignored), rules)).toBeUndefined();
    expect(appliedStatus(logs, { ...rules, releasedVersionId: undefined })).toBeUndefined();
  });

  it("is never one without a version, even when the release names none", () => {
    const unnamed = {
      ...event(released + 400_000, appliedLine(released + 400_000)),
      $workers: { scriptName: SCRIPT, eventType: "alarm", entrypoint: "OmnigentServer" },
    };
    expect(
      appliedStatus(logsOf([unnamed]), { ...rules, releasedVersionId: undefined }),
    ).toBeUndefined();
  });
});

describe("integrationsOff: an update's integrations still on (WP3.44)", () => {
  const R1 = "a1".repeat(16);
  const R2 = "b2".repeat(16);
  const APP = "1a2b3c4d5e6f7081";
  const NONE = { github: false, mcp: [] } as const;
  const GITHUB = { github: true, mcp: [] } as const;
  const MCP = { github: false, mcp: [{ revision: R1, on: true }] } as const;
  /** The applied status of a server that reports both integrations on. */
  const on: StatusEvent = {
    ...status(NOW, true, "durable"),
    secretPresent: false,
    githubApp: APP,
    githubLinking: true,
    mcpRevision: R1,
    mcpRegistry: true,
  };
  /** A status from a build that reports neither (every field unsaid). */
  const older: StatusEvent = { ...status(NOW, true, "durable"), secretPresent: false };

  it("requires nothing of an installation with neither, whatever the status says", () => {
    expect(integrationsOff(on, NONE)).toBeUndefined();
    expect(integrationsOff(older, NONE)).toBeUndefined();
    expect(
      integrationsOff({ ...on, githubApp: null, githubLinking: false, mcpRegistry: false }, NONE),
    ).toBeUndefined();
    // Choices that turn nothing on (every service removed) require nothing either.
    expect(
      integrationsOff(
        { ...older, mcpRevision: R2 },
        { github: false, mcp: [{ revision: R1, on: false }] },
      ),
    ).toBeUndefined();
  });

  it("GitHub linking, when set up: the App held and linking listed", () => {
    expect(integrationsOff(on, GITHUB)).toBeUndefined();
    expect(integrationsOff({ ...on, githubLinking: false }, GITHUB)).toBe(
      "GitHub linking is off: this installation has a GitHub App set up, but Omnigent on the restarted server does not list GitHub linking",
    );
    expect(integrationsOff({ ...on, githubApp: null }, GITHUB)).toBe(
      "GitHub linking is off: this installation has a GitHub App set up, but the restarted server does not hold it",
    );
    const unsaid =
      "GitHub linking is not confirmed: the restarted server's status does not say whether it is on";
    for (const over of [
      { githubLinking: null },
      { githubLinking: undefined },
      { githubApp: undefined },
    ]) {
      expect(integrationsOff({ ...on, ...over }, GITHUB)).toBe(unsaid);
    }
    expect(integrationsOff(older, GITHUB)).toBe(unsaid);
  });

  it("MCP, when services are on: the journal's revision, and the registry listed", () => {
    expect(integrationsOff(on, MCP)).toBeUndefined();
    expect(integrationsOff({ ...on, mcpRegistry: false }, MCP)).toBe(
      "MCP services are off: services are on in this installation, but Omnigent on the restarted server does not list its MCP registry",
    );
    for (const mcpRegistry of [null, undefined]) {
      expect(integrationsOff({ ...on, mcpRegistry }, MCP)).toBe(
        "MCP services are not confirmed: the restarted server's status does not say whether Omnigent lists its MCP registry",
      );
    }
    // A revision mismatch: other choices (set from another laptop, or none at all).
    for (const mcpRevision of [R2, null]) {
      expect(integrationsOff({ ...on, mcpRevision }, MCP)).toBe(
        "MCP services are not confirmed: the restarted server runs other MCP choices than this state file records",
      );
    }
    expect(integrationsOff({ ...on, mcpRevision: undefined }, MCP)).toBe(
      "MCP services are not confirmed: the restarted server's status does not say which MCP choices it runs",
    );
    expect(integrationsOff(older, MCP)).toMatch(/^MCP services are not confirmed: /);
  });

  it("a change begun but not confirmed sent: either list may run, each with its own requirement", () => {
    // Turning the first service on: before it arrived, no revision and nothing on.
    const adding = {
      github: false,
      mcp: [
        { revision: undefined, on: false },
        { revision: R1, on: true },
      ],
    };
    expect(integrationsOff({ ...older, mcpRevision: null, mcpRegistry: false }, adding)).toBe(
      undefined,
    );
    expect(integrationsOff(on, adding)).toBeUndefined();
    expect(integrationsOff({ ...on, mcpRegistry: false }, adding)).toMatch(/^MCP services are off/);
    // Never unsaid, which matches neither.
    expect(integrationsOff(older, adding)).toMatch(/does not say which MCP choices/);
    // Turning the last service off: once it arrived, nothing is required.
    const removing = {
      github: false,
      mcp: [
        { revision: R1, on: true },
        { revision: R2, on: false },
      ],
    };
    expect(integrationsOff({ ...on, mcpRevision: R2, mcpRegistry: false }, removing)).toBe(
      undefined,
    );
    expect(integrationsOff({ ...on, mcpRegistry: false }, removing)).toMatch(
      /^MCP services are off/,
    );
  });

  it("the MCP servers added on the page, when required (WP8.14): all still served", () => {
    const PAGE = { github: false, mcp: [], adminServices: true } as const;
    const unconfirmed = "MCP servers added on the page are not confirmed: the restarted server";
    // None added: nothing more, whatever Omnigent lists.
    for (const mcpRegistry of [true, false, null, undefined]) {
      expect(
        integrationsOff(
          { ...older, mcpRegistry, mcpAdminServices: { stored: 0, served: 0 } },
          PAGE,
        ),
      ).toBeUndefined();
    }
    // All served, or more (nothing lost).
    expect(integrationsOff({ ...on, mcpAdminServices: { stored: 2, served: 2 } }, PAGE)).toBe(
      undefined,
    );
    expect(integrationsOff({ ...on, mcpAdminServices: { stored: 2, served: 3 } }, PAGE)).toBe(
      undefined,
    );
    // One lost in the restart.
    expect(integrationsOff({ ...on, mcpAdminServices: { stored: 2, served: 1 } }, PAGE)).toBe(
      "MCP servers added on the page are off: the restarted server serves 1 of the 2 the update's restore point recorded (the page turned off, a server it cannot use, or a service turned on with bootstrap.ts services that has the same name)",
    );
    // Omnigent not listing its registry, or not saying.
    expect(
      integrationsOff(
        { ...on, mcpRegistry: false, mcpAdminServices: { stored: 1, served: 0 } },
        PAGE,
      ),
    ).toBe(
      "MCP servers added on the page are off: the update's restore point recorded 1, but Omnigent on the restarted server does not list its MCP registry",
    );
    expect(
      integrationsOff(
        { ...on, mcpRegistry: null, mcpAdminServices: { stored: 1, served: 1 } },
        PAGE,
      ),
    ).toBe(`${unconfirmed}'s status does not say whether Omnigent lists its MCP registry`);
    // Not reported yet, or not readable, or not said at all: never counted as on.
    expect(integrationsOff({ ...on, mcpAdminServices: { stored: 3, served: null } }, PAGE)).toBe(
      `${unconfirmed} has not said yet how many of its 3 it serves`,
    );
    expect(integrationsOff({ ...on, mcpAdminServices: { stored: null, served: 0 } }, PAGE)).toBe(
      `${unconfirmed} cannot say how many the update's restore point recorded (taken by an earlier release, or its database unreadable): go back with bootstrap.ts update --rollback and update again`,
    );
    for (const mcpAdminServices of [null, undefined]) {
      expect(integrationsOff({ ...on, mcpAdminServices }, PAGE)).toBe(
        `${unconfirmed}'s status does not say how many the update's restore point recorded`,
      );
    }
    // Not required: nothing is asked of them.
    expect(
      integrationsOff({ ...on, mcpAdminServices: { stored: 2, served: 0 } }, NONE),
    ).toBeUndefined();
    expect(
      integrationsOff(
        { ...on, mcpAdminServices: { stored: 2, served: 0 } },
        { ...PAGE, adminServices: false },
      ),
    ).toBeUndefined();
  });

  it("names every integration that is off, GitHub first", () => {
    expect(
      integrationsOff(
        { ...on, githubLinking: false, mcpRegistry: false },
        { github: true, mcp: MCP.mcp },
      ),
    ).toBe(
      "GitHub linking is off: this installation has a GitHub App set up, but Omnigent on the restarted server does not list GitHub linking; MCP services are off: services are on in this installation, but Omnigent on the restarted server does not list its MCP registry",
    );
  });

  const revision = fc.constantFrom(R1, R2);
  const countArb = fc.oneof(fc.constant(null), fc.nat({ max: 4 }));
  const statusArb = fc.record({
    githubApp: fc.constantFrom(undefined, null, APP),
    githubLinking: fc.constantFrom(undefined, null, true, false),
    mcpRevision: fc.oneof(fc.constantFrom(undefined, null), revision),
    mcpRegistry: fc.constantFrom(undefined, null, true, false),
    mcpAdminServices: fc.oneof(
      fc.constantFrom(undefined, null),
      fc.record({ stored: countArb, served: countArb }),
    ),
  });
  const requiredArb = fc.record({
    github: fc.boolean(),
    mcp: fc.array(
      fc.record({ revision: fc.option(revision, { nil: undefined }), on: fc.boolean() }),
      { maxLength: 3 },
    ),
    adminServices: fc.boolean(),
  });

  it("accepts only what the status positively shows on (property)", () => {
    fc.assert(
      fc.property(statusArb, requiredArb, (fields, required) => {
        const off = integrationsOff({ ...older, ...fields }, required);
        const mcpOn = required.mcp.some((choices) => choices.on);
        if (off === undefined) {
          if (required.github) {
            expect(typeof fields.githubApp).toBe("string");
            expect(fields.githubLinking).toBe(true);
          }
          if (mcpOn) {
            // The status names choices the journal records; when those turn a service on,
            // Omnigent lists its registry.
            const runs = required.mcp.filter(
              (choices) => (choices.revision ?? null) === fields.mcpRevision,
            );
            expect(runs.length).toBeGreaterThan(0);
            if (runs.every((choices) => choices.on)) expect(fields.mcpRegistry).toBe(true);
          }
          if (required.adminServices) {
            // The counts are said; any page server the database held is served, with MCP listed.
            const counts = fields.mcpAdminServices;
            expect(counts?.stored).toEqual(expect.any(Number));
            if ((counts?.stored ?? 0) > 0) {
              expect(fields.mcpRegistry).toBe(true);
              expect(counts?.served).toBeGreaterThanOrEqual(counts?.stored ?? 0);
            }
          }
        } else {
          // Something required was not on, and the message names it.
          expect(required.github || mcpOn || required.adminServices).toBe(true);
          expect(off).toMatch(/^(GitHub linking|MCP services|MCP servers added on the page) /);
        }
      }),
    );
  });

  it("never counts an unsaid field as on (property)", () => {
    fc.assert(
      fc.property(statusArb, requiredArb, (fields, required) => {
        const unsaidGitHub =
          required.github && (fields.githubApp === undefined || fields.githubLinking === undefined);
        const unsaidMcp =
          required.mcp.some((choices) => choices.on) &&
          (fields.mcpRevision === undefined || fields.mcpRegistry === undefined) &&
          !required.mcp.some(
            (choices) => !choices.on && (choices.revision ?? null) === fields.mcpRevision,
          );
        const unsaidPage =
          required.adminServices &&
          (fields.mcpAdminServices === undefined ||
            fields.mcpAdminServices === null ||
            fields.mcpAdminServices.stored === null);
        const off = integrationsOff({ ...older, ...fields }, required);
        if (unsaidGitHub) expect(off).toContain("GitHub linking");
        if (unsaidMcp) expect(off).toContain("MCP services");
        if (unsaidPage) expect(off).toContain("MCP servers added on the page");
      }),
    );
  });

  it("requires nothing without GitHub or services on (property)", () => {
    fc.assert(
      fc.property(statusArb, requiredArb, (fields, required) => {
        const none = {
          github: false,
          mcp: required.mcp.map((c) => ({ ...c, on: false })),
          adminServices: false,
        };
        expect(integrationsOff({ ...older, ...fields }, none)).toBeUndefined();
      }),
    );
  });
});

describe("checkGitHubLinking (WP3.36)", () => {
  const SINCE = NOW;
  /** The tag of the App the step stored, and of an earlier one (--replace). */
  const APP = "1a2b3c4d5e6f7081";
  const OLD = "9f8e7d6c5b4a3921";
  /** A status from a server started with its logging version's configuration. */
  const github = (
    at: number,
    linking: unknown,
    over: { version?: string; githubApp?: unknown; configApplied?: boolean; id?: string } = {},
  ) =>
    event(
      at,
      {
        ...line(at, true, "durable", {
          secretPresent: false,
          configApplied: over.configApplied ?? true,
          ...(over.id === undefined ? {} : { installationId: over.id }),
        }),
        githubApp: "githubApp" in over ? over.githubApp : APP,
        githubLinking: linking,
      },
      over.version ?? "v2",
    );
  const configError = (
    at: number,
    over: { held?: unknown; githubApp?: unknown; entrypoint?: string } = {},
  ) => {
    const e = event(at, {
      cfo: "watchdog",
      event: "config_error",
      exitCode: 78,
      held: "held" in over ? over.held : true,
      githubApp: "githubApp" in over ? over.githubApp : APP,
    });
    return { ...e, $workers: { ...e.$workers, entrypoint: over.entrypoint ?? "OmnigentServer" } };
  };
  const changed = (at: number) => event(at, { cfo: "watchdog", event: "config_changed" });
  const check = (events: unknown[]) =>
    checkGitHubLinking(parseLogs(events, SCRIPT), {
      installationId: INSTALLATION,
      appTag: APP,
      since: SINCE,
    });

  it("is on, or off, by the newest status naming this App, after the change, whatever the version", () => {
    expect(check([github(SINCE + 60_000, true)])).toEqual({ state: "on" });
    expect(check([github(SINCE + 60_000, false)])).toEqual({ state: "off" });
    expect(check([github(SINCE + 60_000, false), github(SINCE + 120_000, true)])).toEqual({
      state: "on",
    });
    // Versions do not matter: Cloudflare may name none, or an old one (Codex r1-1).
    expect(check([github(SINCE + 60_000, true, { version: "" })])).toEqual({ state: "on" });
  });

  it("never counts a status of another App (an earlier one on --replace, or none), from before the change, of another installation, or not applied", () => {
    for (const ignored of [
      github(SINCE + 60_000, true, { githubApp: OLD }),
      github(SINCE + 60_000, true, { githubApp: null }),
      github(SINCE + 60_000, true, { githubApp: true }),
      github(SINCE - 1, true),
      github(SINCE + 60_000, true, { id: OTHER }),
      github(SINCE + 60_000, true, { configApplied: false }),
      github(SINCE + 60_000, false, { githubApp: OLD }),
    ]) {
      expect(check([ignored]).state).toBe("waiting");
    }
  });

  it("waits while the status does not say", () => {
    for (const unsaid of [null, "on", 1]) {
      expect(check([github(SINCE + 60_000, unsaid)])).toMatchObject({
        state: "waiting",
        why: expect.stringContaining("does not say whether GitHub linking is on"),
      });
    }
  });

  it("says held only when the watchdog holds a configuration with this App, and nothing newer answered", () => {
    expect(check([configError(SINCE + 60_000)])).toEqual({ state: "held" });
    expect(check([github(SINCE + 30_000, true), configError(SINCE + 60_000)])).toEqual({
      state: "held",
    });
    expect(check([configError(SINCE + 30_000), github(SINCE + 60_000, true)])).toEqual({
      state: "on",
    });
    // An older container's exit (the current configuration starts at once), another App's, an
    // unsaid one, one from before the change, or one not from the object: not evidence (r1-2).
    for (const ignored of [
      configError(SINCE + 60_000, { held: false }),
      configError(SINCE + 60_000, { held: undefined }),
      configError(SINCE + 60_000, { githubApp: OLD }),
      configError(SINCE + 60_000, { githubApp: null }),
      configError(SINCE - 1),
      configError(SINCE + 60_000, { entrypoint: "ControlDO" }),
    ]) {
      expect(check([ignored]).state).toBe("waiting");
    }
  });

  it("lets a later word override an earlier verdict, whatever order the lines arrive in (Codex r2-1)", () => {
    const on = github(SINCE + 60_000, true);
    for (const later of [
      github(SINCE + 120_000, true, { githubApp: OLD }), // a rollback to the earlier App
      github(SINCE + 120_000, true, { githubApp: null }), // the App removed
      github(SINCE + 120_000, true, { configApplied: false }), // a restart under way
      changed(SINCE + 120_000), // a replacement begun
      configError(SINCE + 120_000, { githubApp: OLD }), // another configuration held
    ]) {
      expect(check([later, on]).state).toBe("waiting");
      expect(check([on, later]).state).toBe("waiting");
    }
    expect(
      check([github(SINCE + 60_000, false), github(SINCE + 120_000, true, { githubApp: OLD })]),
    ).toMatchObject({ state: "waiting", why: expect.stringContaining("without this App") });
    expect(check([configError(SINCE + 60_000), changed(SINCE + 120_000)])).toMatchObject({
      state: "waiting",
      why: expect.stringContaining("restarting"),
    });
    // At the same moment, a change outranks a verdict.
    expect(check([on, changed(SINCE + 60_000)]).state).toBe("waiting");
    // And fresh evidence after the change decides again.
    expect(check([on, changed(SINCE + 120_000), github(SINCE + 180_000, true)])).toEqual({
      state: "on",
    });
  });

  it("says whether the watchdog has begun the restart", () => {
    expect(check([])).toMatchObject({ why: expect.stringContaining("has not switched") });
    expect(check([changed(SINCE - 1)])).toMatchObject({
      why: expect.stringContaining("has not switched"),
    });
    expect(check([changed(SINCE + 60_000)])).toMatchObject({
      why: expect.stringContaining("restarting with the App's settings"),
    });
    expect(check([github(SINCE + 60_000, false, { configApplied: false })])).toMatchObject({
      why: expect.stringContaining("restarting with the App's settings"),
    });
  });
});

describe("checkMcpServices (WP5.10)", () => {
  const SINCE = NOW;
  /** The revision the step stored, and an earlier one. */
  const REV = "0a".repeat(16);
  const OLD = "0b".repeat(16);
  const mcp = (
    at: number,
    registry: unknown,
    over: { mcpRevision?: unknown; configApplied?: boolean; id?: string } = {},
  ) =>
    event(
      at,
      {
        ...line(at, true, "durable", {
          secretPresent: false,
          configApplied: over.configApplied ?? true,
          ...(over.id === undefined ? {} : { installationId: over.id }),
        }),
        mcpRevision: "mcpRevision" in over ? over.mcpRevision : REV,
        mcpRegistry: registry,
      },
      "v2",
    );
  const configError = (at: number, over: { held?: unknown; mcpRevision?: unknown } = {}) =>
    event(at, {
      cfo: "watchdog",
      event: "config_error",
      exitCode: 78,
      held: "held" in over ? over.held : true,
      mcpRevision: "mcpRevision" in over ? over.mcpRevision : REV,
    });
  const changed = (at: number) => event(at, { cfo: "watchdog", event: "config_changed" });
  const check = (events: unknown[]) =>
    checkMcpServices(parseLogs(events, SCRIPT), {
      installationId: INSTALLATION,
      revision: REV,
      since: SINCE,
    });

  it("reads the fields from a status line and a held configuration", () => {
    const logs = parseLogs([mcp(SINCE + 1, true), configError(SINCE + 2)], SCRIPT);
    expect(logs.statuses[0]).toMatchObject({ mcpRegistry: true, mcpRevision: REV });
    expect(logs.configErrors[0]).toMatchObject({ held: true, mcpRevision: REV });
    const unsaid = parseLogs([mcp(SINCE + 1, "yes", { mcpRevision: 7 })], SCRIPT);
    expect(unsaid.statuses[0]).toMatchObject({ mcpRegistry: undefined, mcpRevision: undefined });
  });

  it("reads the MCP servers added on the page (WP8.14): both counts, or null, or unsaid", () => {
    const counted = (value: unknown) =>
      parseLogs(
        [event(SINCE + 1, { ...line(SINCE + 1, true, "durable"), mcpAdminServices: value })],
        SCRIPT,
      ).statuses[0];
    expect(counted({ stored: 2, served: 1 })?.mcpAdminServices).toEqual({ stored: 2, served: 1 });
    expect(counted({ stored: null, served: null })?.mcpAdminServices).toEqual({
      stored: null,
      served: null,
    });
    expect(counted(null)?.mcpAdminServices).toBeNull();
    for (const value of [
      7,
      [],
      {},
      { stored: 1 },
      { stored: -1, served: 0 },
      { stored: "2", served: 2 },
    ]) {
      expect(counted(value)?.mcpAdminServices).toBeUndefined();
    }
    // A line without the member (a release from before it) does not carry it at all.
    const older = parseLogs([event(SINCE + 1, line(SINCE + 1, true, "durable"))], SCRIPT);
    expect(older.statuses[0]).not.toHaveProperty("mcpAdminServices");
  });

  it("is applied by the newest status naming this revision, with what Omnigent lists", () => {
    expect(check([mcp(SINCE + 60_000, true)])).toEqual({ state: "applied", registry: true });
    expect(check([mcp(SINCE + 60_000, false)])).toEqual({ state: "applied", registry: false });
    expect(check([mcp(SINCE + 60_000, false), mcp(SINCE + 120_000, true)])).toEqual({
      state: "applied",
      registry: true,
    });
  });

  it("never counts another revision, none, before the change, another installation, or not applied", () => {
    for (const ignored of [
      mcp(SINCE + 60_000, true, { mcpRevision: OLD }),
      mcp(SINCE + 60_000, true, { mcpRevision: null }),
      mcp(SINCE + 60_000, true, { mcpRevision: undefined }),
      mcp(SINCE - 1, true),
      mcp(SINCE + 60_000, true, { id: OTHER }),
      mcp(SINCE + 60_000, true, { configApplied: false }),
    ]) {
      expect(check([ignored]).state).toBe("waiting");
    }
    expect(check([mcp(SINCE + 60_000, null)])).toMatchObject({
      state: "waiting",
      why: expect.stringContaining("does not say whether Omnigent lists MCP"),
    });
  });

  it("says held only for this revision, and lets a later word override any verdict", () => {
    expect(check([configError(SINCE + 60_000)])).toEqual({ state: "held" });
    expect(check([configError(SINCE + 60_000, { mcpRevision: OLD })]).state).toBe("waiting");
    expect(check([configError(SINCE + 60_000, { held: false })]).state).toBe("waiting");
    expect(check([configError(SINCE + 30_000), mcp(SINCE + 60_000, true)]).state).toBe("applied");
    const applied = mcp(SINCE + 60_000, true);
    for (const later of [
      mcp(SINCE + 120_000, true, { mcpRevision: OLD }),
      mcp(SINCE + 120_000, true, { configApplied: false }),
      changed(SINCE + 120_000),
      configError(SINCE + 120_000, { mcpRevision: OLD }),
    ]) {
      expect(check([later, applied]).state).toBe("waiting");
      expect(check([applied, later]).state).toBe("waiting");
    }
    expect(check([applied, changed(SINCE + 60_000)]).state).toBe("waiting");
    expect(check([])).toMatchObject({ why: expect.stringContaining("has not switched") });
    expect(check([changed(SINCE + 60_000)])).toMatchObject({
      why: expect.stringContaining("restarting with the new MCP settings"),
    });
    expect(check([mcp(SINCE + 60_000, true, { mcpRevision: OLD })])).toMatchObject({
      why: expect.stringContaining("still runs other MCP settings"),
    });
  });
});
