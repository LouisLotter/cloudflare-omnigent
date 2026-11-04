// A refused setting's hold read the same way by `run`, `update` and `status` (WP8.10, Codex r2
// R2-P01, R2-P02), from the lines the real watchdog emits for the sequences the review used.

import { describe, expect, it } from "vitest";
import {
  INITIAL_WATCHDOG_STATE,
  type Observation,
  type Step,
  step,
  WATCHDOG_TIMING,
  type WatchdogState,
} from "../../../worker/src/server/watchdog.ts";
import { decide, holdReport, parseLogs, verifyRelease } from "../events.ts";
import { heldSince } from "../machine.ts";
import { INSTALLATION } from "./fixtures.ts";

const SCRIPT = "cloudflare-omnigent";
const T0 = Date.UTC(2026, 10, 4, 15, 0, 0);
let ids = 0;
const nextId = () => `out_${String(++ids).padStart(26, "0")}`;
const STOPPED: Observation = { kind: "stopped", exitCode: null };
const refused = (config: string): Observation => ({
  kind: "stopped",
  exitCode: 78,
  ranWith: config,
});

/** The Workers Logs event of one line the OmnigentServer object logged in an alarm. */
function line(at: number, source: unknown, version: string) {
  return {
    timestamp: at,
    $workers: {
      scriptName: SCRIPT,
      scriptVersion: { id: version },
      eventType: "alarm",
      entrypoint: "OmnigentServer",
    },
    $metadata: { id: `e${at}-${Math.random()}` },
    source,
  };
}

/** One alarm through the real watchdog: its state, and the lines the object logs for it. */
function alarm(
  state: WatchdogState,
  observation: Observation,
  at: number,
  config: string,
  version: string,
): { readonly state: WatchdogState; readonly lines: unknown[] } {
  const s: Step = step(state, observation, at, WATCHDOG_TIMING, nextId, config);
  const events = s.effects.flatMap((e) =>
    e.type === "event" ? [line(at, { cfo: "watchdog", event: e.name, ...e.fields }, version)] : [],
  );
  return { state: s.state, lines: [line(at, { level: "info", message: "" }, version), ...events] };
}

/** The bootstrap status a server logs once its owner is initialized and durable. */
function durable(at: number, version: string) {
  return line(
    at,
    {
      cfo: "bootstrap",
      event: "status",
      reason: "durable",
      bootstrapStatus: {
        protocolVersion: 1,
        installationId: INSTALLATION,
        initialized: true,
        checkedAt: new Date(at).toISOString(),
      },
      secretPresent: true,
      configApplied: true,
    },
    version,
  );
}

describe("a refused setting's hold, through the real watchdog (Codex r2)", () => {
  it("R2-P01: run keeps waiting once a changed configuration starts, then sees the durable owner", () => {
    const deployedAt = T0 - 60_000;
    // Configuration A starts and exits 78: held; its next check says the hold is current.
    const started = alarm(INITIAL_WATCHDOG_STATE, STOPPED, T0, "A", "v1");
    const held = alarm(started.state, refused("A"), T0 + 5_000, "A", "v1");
    expect(held.state.phase).toBe("held");
    const again = alarm(held.state, STOPPED, T0 + 65_000, "A", "v1");
    // The owner corrects the setting: configuration B (a new version) is started.
    const changed = alarm(again.state, STOPPED, T0 + 125_000, "B", "v2");
    expect(changed.state.phase).toBe("starting");
    const lines = [...started.lines, ...held.lines, ...again.lines, ...changed.lines];
    const logs = parseLogs(lines, SCRIPT);
    expect(logs.configChanges).toEqual([T0 + 125_000]);
    // B is starting, with no status yet: no hold, so `run` keeps waiting for it.
    expect(heldSince(logs, INSTALLATION, deployedAt)).toBe(false);
    expect(holdReport(logs, INSTALLATION)[0]).toMatch(/^no current hold/);
    expect(
      decide(logs.statuses, { installationId: INSTALLATION, now: T0 + 126_000 }).accepted,
    ).toBe(false);
    // B answers with a durable owner: `run` accepts it.
    const answered = parseLogs([...lines, durable(T0 + 240_000, "v2")], SCRIPT);
    expect(heldSince(answered, INSTALLATION, deployedAt)).toBe(false);
    expect(
      decide(answered.statuses, { installationId: INSTALLATION, now: T0 + 241_000 }).accepted,
    ).toBe(true);
  });

  it("R2-P02: a second refusal after a changed configuration is the current hold, for verifyRelease and holdReport alike", () => {
    const started = alarm(INITIAL_WATCHDOG_STATE, STOPPED, T0, "A", "v1");
    const held = alarm(started.state, refused("A"), T0 + 5_000, "A", "v1");
    const again = alarm(held.state, STOPPED, T0 + 65_000, "A", "v1");
    const changed = alarm(again.state, STOPPED, T0 + 125_000, "B", "v2");
    // B exits 78 too: held again, before its next recurring check (at T0 + 190 s).
    const second = alarm(changed.state, refused("B"), T0 + 130_000, "B", "v2");
    expect(second.state.phase).toBe("held");
    const logs = parseLogs(
      [...started.lines, ...held.lines, ...again.lines, ...changed.lines, ...second.lines],
      SCRIPT,
    );
    const now = T0 + 131_000;
    const release = verifyRelease(logs, {
      installationId: INSTALLATION,
      releasedVersionId: "v2",
      releasedAt: T0 + 120_000,
    });
    expect(release).toMatchObject({ verified: false, held: true });
    const report = holdReport(logs, INSTALLATION);
    expect(report[0]).toMatch(/^the server is held now/);
    expect(report[0]).toContain("version v2");
    expect(heldSince(logs, INSTALLATION, T0)).toBe(true);
    // A's hold is history: ended by the change to B.
    expect(report.slice(1).join("\n")).toContain(
      "since answered or restarted with another configuration",
    );
  });
});
