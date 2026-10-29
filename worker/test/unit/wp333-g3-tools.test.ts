// WP3.33: the G3 sitting's harness tools (worker/test/staging/wp318), in Node: the one-shot
// commands (commands.ts) and their runner, the wake-time table (wakes.ts), the log scan
// (scan.ts), the instance starts the analysis lists (instances.ts), the limit (limit.ts), and
// run.sh's dry-run and file paths, which touch no account (a stand-in `cf` fails the test if
// called).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ComputerId } from "@cfo/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  COMMAND_MAX_AGE_MS,
  type CommandPorts,
  type CommandResult,
  commandKey,
  decide,
  describeResult,
  INTERRUPTED_AFTER_MS,
  idOfKey,
  makeCommand,
  newCommandId,
  parseCommand,
  type RunOutcome,
  resultFor,
  resultKey,
  runCommands,
  type SoakCommand,
  type SoakStatus,
} from "../staging/wp318/commands.ts";
import { instanceCounts, instanceStarts, type Planned } from "../staging/wp318/instances.ts";
import { controlOnVersion, LIMIT_VAR, limitSetting, withLimit } from "../staging/wp318/limit.ts";
import type { LogLine } from "../staging/wp318/plan.ts";
import { scanLines, TOKEN_SHAPES, tokenHits, valuesFrom } from "../staging/wp318/scan.ts";
import { soakPlatformConfig } from "../staging/wp318/soak-config.ts";
import { describeWakes, wakeTable } from "../staging/wp318/wakes.ts";

const A = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
const B = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4";
const T = Date.UTC(2026, 9, 29, 12, 0, 0);
const S = 1000;
const HERE = resolve(import.meta.dirname, "..", "staging", "wp318");

// ---------------------------------------------------------------------------------------------
// The one-shot commands.

describe("the one-shot commands' objects", () => {
  const id = newCommandId(T, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

  it("are named by the laptop's time and 4 random bytes, under the commands prefix", () => {
    expect(id).toBe("cmd-20261029T120000Z-deadbeef");
    expect(commandKey(id)).toBe(`soak/commands/${id}.json`);
    expect(resultKey(id)).toBe(`soak/command-results/${id}.json`);
    expect(idOfKey(commandKey(id))).toBe(id);
    for (const key of ["soak/commands/x.json", "soak/current.json", `soak/commands/${id}.txt`]) {
      expect(idOfKey(key)).toBeNull();
    }
    expect(() => newCommandId(T, new Uint8Array([1, 2]))).toThrow(/4 random bytes/);
  });

  it("check a computer ID exactly as the contracts do", () => {
    for (const candidate of [
      A,
      "cmp_01HZY3M8K6Q4T2V9W7X5R0S1N3",
      "cmp_01hzy3m8k6q4t2v9w7x5r0s1n",
      "cmp_01hzy3m8k6q4t2v9w7x5r0s1ni",
      "cmp_01hzy3m8k6q4t2v9w7x5r0s1nu",
      "ins_01hzy3m8k6q4t2v9w7x5r0s1n3",
      `${A}/../x`,
    ]) {
      const ours = (() => {
        try {
          makeCommand("computer-kill", candidate, T, id);
          return true;
        } catch {
          return false;
        }
      })();
      expect([candidate, ours]).toEqual([candidate, ComputerId.safeParse(candidate).success]);
    }
  });

  it("refuse a bad command before anything is written", () => {
    expect(makeCommand("computer-kill", A, T, id)).toEqual({
      id,
      command: "computer-kill",
      computerId: A,
      issuedAt: T,
    });
    expect(makeCommand("soak-start", undefined, T, id).computerId).toBeNull();
    expect(() => makeCommand("computer-kill", undefined, T, id)).toThrow(/needs a computer ID/);
    expect(() => makeCommand("workspace-reset", "cmp_x", T, id)).toThrow(/needs a computer ID/);
    expect(() => makeCommand("server-reset", A, T, id)).toThrow(/takes no computer/);
    expect(() => makeCommand("rm-rf", undefined, T, id)).toThrow(/unknown command/);
    expect(() => makeCommand("soak-start", undefined, T, "cmd-1")).toThrow(/not a command ID/);
  });

  it("are read field by field from the bucket, never trusted", () => {
    const key = commandKey(id);
    const body = (o: object) =>
      JSON.stringify({ id, command: "computer-kill", computerId: A, issuedAt: T, ...o });
    expect(parseCommand(key, body({}))).toEqual({
      ok: true,
      command: { id, command: "computer-kill", computerId: A, issuedAt: T },
    });
    const problems: [string, string, string][] = [
      ["soak/current.json", body({}), "not a command key"],
      [key, "{", "not JSON"],
      [key, "[1]", "not an object"],
      [key, "null", "not an object"],
      [key, body({ extra: 1 }), "unknown fields"],
      [key, body({ id: "cmd-20261029T120000Z-00000000" }), "its ID is not its key's"],
      [key, body({ command: "drop-table" }), "unknown command"],
      [key, body({ computerId: null }), "needs a computer ID"],
      [key, body({ issuedAt: "now" }), "no issuedAt"],
    ];
    for (const [k, b, problem] of problems) {
      const parsed = parseCommand(k, b);
      expect(parsed.ok).toBe(false);
      expect(!parsed.ok && parsed.problem).toContain(problem);
    }
    expect(parseCommand(key, JSON.stringify({ id, command: "server-reset", issuedAt: T }))).toEqual(
      {
        ok: true,
        command: { id, command: "server-reset", computerId: null, issuedAt: T },
      },
    );
  });
});

describe("whether a command may run", () => {
  const command = (name: SoakCommand["command"], at = T): SoakCommand => ({
    id: "cmd-20261029T120000Z-00000001",
    command: name,
    computerId: name === "computer-kill" || name === "workspace-reset" ? A : null,
    issuedAt: at,
  });
  const running: SoakStatus = { runId: "soak-1", ended: false };
  const ended: SoakStatus = { runId: "soak-1", ended: true };

  it("never while a soak run is active, but its start; never twice the start", () => {
    const at = { now: T + 30 * S, computers: [A] };
    expect(decide(command("computer-kill"), { ...at, soak: null })).toEqual({ run: true });
    expect(decide(command("computer-kill"), { ...at, soak: running })).toEqual({
      run: false,
      reason: "soak_running",
    });
    expect(decide(command("workspace-reset"), { ...at, soak: ended })).toEqual({ run: true });
    expect(decide(command("server-reset"), { ...at, soak: running, computers: null })).toEqual({
      run: false,
      reason: "soak_running",
    });
    expect(decide(command("soak-start"), { ...at, soak: null, computers: null })).toEqual({
      run: true,
    });
    for (const soak of [running, ended]) {
      expect(decide(command("soak-start"), { ...at, soak, computers: null })).toEqual({
        run: false,
        reason: "already_started",
      });
    }
  });

  it("never late, never from a clock far ahead, never on an unknown computer", () => {
    const base = { soak: null, computers: [A] };
    expect(decide(command("computer-kill"), { ...base, now: T + COMMAND_MAX_AGE_MS })).toEqual({
      run: true,
    });
    expect(decide(command("computer-kill"), { ...base, now: T + COMMAND_MAX_AGE_MS + 1 })).toEqual({
      run: false,
      reason: "stale",
    });
    expect(decide(command("computer-kill"), { ...base, now: T - 3 * 60_000 })).toEqual({
      run: false,
      reason: "issued_in_the_future",
    });
    expect(decide(command("computer-kill"), { ...base, now: T, computers: [B] })).toEqual({
      run: false,
      reason: "unknown_computer",
    });
  });
});

/** A results bucket, a soak run's claim table and its effects, in memory. */
function harness(options: { soak?: SoakStatus | null; computers?: string[] } = {}) {
  const objects = new Map<string, string>();
  const claims = new Map<string, { claimedAt: number; result: CommandResult | null }>();
  const published: CommandResult[] = [];
  const ran: SoakCommand[] = [];
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  let now = T + 30 * S;
  const h = {
    objects,
    claims,
    published,
    ran,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
    effect: async (_c: SoakCommand): Promise<RunOutcome> => ({ outcome: "ok", detail: { g: 1 } }),
    failPublish: false,
    ports: null as unknown as CommandPorts,
  };
  h.ports = {
    now: () => now,
    list: async () => [...objects.keys()].filter((k) => k.startsWith("soak/commands/")),
    read: async (key) => objects.get(key) ?? null,
    remove: async (key) => {
      objects.delete(key);
    },
    claim: (id, at) => {
      const known = claims.get(id);
      if (known === undefined) {
        claims.set(id, { claimedAt: at, result: null });
        return { fresh: true };
      }
      return { fresh: false, claimedAt: known.claimedAt, result: known.result };
    },
    record: (result) => {
      const known = claims.get(result.id);
      if (known !== undefined) known.result = result;
    },
    publish: async (result) => {
      if (h.failPublish) throw new Error("R2 put failed");
      published.push(result);
      objects.set(resultKey(result.id), JSON.stringify(result));
    },
    soak: async () => options.soak ?? null,
    computers: async () => options.computers ?? [A, B],
    run: async (command) => {
      ran.push(command);
      return h.effect(command);
    },
    log: (event, fields) => logs.push({ event, fields }),
  };
  return h;
}

function put(
  h: ReturnType<typeof harness>,
  name: SoakCommand["command"],
  computer?: string,
  n = 1,
) {
  const id = newCommandId(T, new Uint8Array([0, 0, 0, n]));
  const command = makeCommand(name, computer, T, id);
  h.objects.set(commandKey(id), JSON.stringify(command));
  return id;
}

describe("the soak run's command runner", () => {
  it("runs a command once, recorded before it is published, then removes its object", async () => {
    const h = harness();
    const id = put(h, "computer-kill", A);
    const results = await runCommands(h.ports);
    expect(h.ran.map((c) => c.id)).toEqual([id]);
    expect(results).toEqual([
      {
        id,
        command: "computer-kill",
        computerId: A,
        outcome: "ok",
        reason: null,
        detail: { g: 1 },
        issuedAt: T,
        startedAt: T + 30 * S,
        endedAt: T + 30 * S,
      },
    ]);
    expect(h.claims.get(id)?.result).toEqual(results[0]);
    expect(h.objects.has(commandKey(id))).toBe(false);
    expect(JSON.parse(h.objects.get(resultKey(id)) ?? "{}")).toEqual(results[0]);
    expect(h.logs).toEqual([
      {
        event: "command",
        fields: { id, command: "computer-kill", computerId: A, outcome: "ok", reason: null },
      },
    ]);
    // The cron's next pass finds nothing to do.
    expect(await runCommands(h.ports)).toEqual([]);
    expect(h.ran).toHaveLength(1);
  });

  it("never runs a command twice when the cron fires twice at once", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.effect = async () => {
      await held;
      return { outcome: "ok" };
    };
    const id = put(h, "workspace-reset", A);
    const first = runCommands(h.ports);
    const second = runCommands(h.ports);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(h.ran.map((c) => c.id)).toEqual([id]);
    expect([...a, ...b].map((r) => r.id)).toEqual([id]);
  });

  it("publishes an outcome again, without running, when an earlier pass stopped before removing the object", async () => {
    const h = harness();
    const id = put(h, "server-reset");
    h.failPublish = true;
    expect(await runCommands(h.ports)).toHaveLength(1);
    expect(h.logs.at(-1)).toMatchObject({ event: "command_pass_failed" });
    expect(h.objects.has(commandKey(id))).toBe(true);
    h.failPublish = false;
    expect(await runCommands(h.ports)).toEqual([]);
    expect(h.ran).toHaveLength(1);
    expect(h.published.map((r) => r.id)).toEqual([id]);
    expect(h.objects.has(commandKey(id))).toBe(false);
  });

  it("records a claimed command with no outcome as interrupted, never running it, after five minutes", async () => {
    const h = harness();
    const id = put(h, "computer-kill", A);
    // An earlier pass claimed it and was cut off before recording anything.
    h.claims.set(id, { claimedAt: T + 30 * S, result: null });
    expect(await runCommands(h.ports)).toEqual([]);
    expect(h.objects.has(commandKey(id))).toBe(true);
    h.advance(INTERRUPTED_AFTER_MS);
    const [result] = await runCommands(h.ports);
    expect(result).toMatchObject({ id, outcome: "failed", reason: "interrupted" });
    expect(h.ran).toHaveLength(0);
    expect(h.objects.has(commandKey(id))).toBe(false);
  });

  it("refuses during a soak run, refuses a malformed object, and removes a stranger's object unread", async () => {
    const h = harness({ soak: { runId: "soak-1", ended: false } });
    const kill = put(h, "computer-kill", A, 1);
    const start = put(h, "soak-start", undefined, 2);
    const bad = newCommandId(T, new Uint8Array([0, 0, 0, 3]));
    h.objects.set(commandKey(bad), "{not json");
    h.objects.set("soak/commands/notes.txt", "hello");
    const results = await runCommands(h.ports);
    expect(results.map((r) => [r.id, r.outcome, r.reason])).toEqual([
      [kill, "refused", "soak_running"],
      [start, "refused", "already_started"],
      [bad, "refused", "malformed: not JSON"],
    ]);
    expect(h.ran).toEqual([]);
    expect([...h.objects.keys()].filter((k) => k.startsWith("soak/commands/"))).toEqual([]);
    expect(h.logs.some((l) => l.event === "command_ignored")).toBe(true);
  });

  it("records a failure, with the error's first words, when the effect or a read throws", async () => {
    const h = harness();
    h.effect = async () => {
      throw new Error("Network connection lost.");
    };
    const kill = put(h, "computer-kill", A, 1);
    const [failed] = await runCommands(h.ports);
    expect(failed).toMatchObject({ id: kill, outcome: "failed", reason: "error" });
    expect(String(failed?.detail)).toContain("Network connection lost.");
    const g = harness();
    g.ports = {
      ...g.ports,
      computers: async () => {
        throw new Error("ControlDO did not answer");
      },
    };
    put(g, "workspace-reset", B, 2);
    const [unread] = await runCommands(g.ports);
    expect(unread).toMatchObject({ outcome: "failed", reason: "error" });
    expect(g.ran).toEqual([]);
  });

  it("names the outcome in one line, and knows a command's outcome from anything else", () => {
    const result: CommandResult = {
      id: "cmd-20261029T120000Z-00000001",
      command: "computer-kill",
      computerId: A,
      outcome: "ok",
      reason: null,
      detail: { generation: 2, host: "7f3c2a9e" },
      issuedAt: T,
      startedAt: T + 40 * S,
      endedAt: T + 41 * S,
    };
    expect(describeResult(result)).toBe(
      `ok computer-kill ${A} 41.0 s {"generation":2,"host":"7f3c2a9e"}`,
    );
    expect(
      describeResult({ ...result, outcome: "refused", reason: "not_staging", detail: null }),
    ).toBe(`refused computer-kill ${A} (not_staging) 41.0 s`);
    expect(
      describeResult({ ...result, command: null, computerId: null, issuedAt: null, detail: null }),
    ).toBe("ok ?");
    expect(resultFor(JSON.stringify(result), result.id)).toEqual(result);
    expect(resultFor(JSON.stringify(result), "cmd-20261029T120000Z-00000002")).toBeNull();
    expect(resultFor(JSON.stringify({ ...result, outcome: "maybe" }), result.id)).toBeNull();
    expect(resultFor('{"errors":[{"code":10007}]}', result.id)).toBeNull();
    expect(resultFor("null", result.id)).toBeNull();
    expect(resultFor("", result.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The wake-time table.

const HOST_A = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";

function line(at: number, source: Record<string, unknown>, version = "v1"): LogLine {
  return { timestamp: at, version, source };
}
const ws = (at: number, event: string, f: Record<string, unknown> = {}) =>
  line(at, { cfo: "workspace", event, computerId: A, ...f });
const route = (at: number, path: string, generation: number, computerId = A, status = 101) =>
  line(at, {
    cfo: "computer_route",
    event: "request",
    method: "GET",
    path,
    upgrade: true,
    status,
    computerId,
    generation,
  });
const resume = (at: number, computerId = A, status = 200) =>
  line(at, {
    cfo: "launcher_api",
    event: "call",
    operation: "resume",
    path: "/launcher/resume",
    status,
    computerId,
  });

describe("run.sh wakes", () => {
  // A's first wake; a sleep; a wake from a message with two refused starts; a staging kill and a
  // wake after it. B's wake refused at the limit.
  const logs: LogLine[] = [
    resume(T),
    line(T + 0.2 * S, { cfo: "control", event: "reserve_granted", computerId: A, generation: 1 }),
    ws(T + 0.5 * S, "container_start", { generation: 1, refusals: 0 }),
    ws(T + 40 * S, "restore_confirmed", { generation: 1, layers: 0 }),
    ws(T + 42 * S, "start_delivered", { generation: 1, attempt: 1, outcome: "taken" }),
    route(T + 50 * S, `/v1/hosts/${HOST_A}/tunnel`, 1),
    route(T + 58 * S, "/v1/runners/runner_token_0123/tunnel", 1),
    route(T + 300 * S, "/v1/runners/runner_token_0456/tunnel", 1),
    ws(T + 900 * S, "stop_confirmed", { generation: 1, reason: "sleep" }),
    line(T + 901 * S, { cfo: "control", event: "released", computerId: A, generation: 1 }),
    resume(T + 1000 * S),
    line(T + 1000.1 * S, {
      cfo: "control",
      event: "reserve_granted",
      computerId: A,
      generation: 2,
    }),
    ws(T + 1000.3 * S, "container_start", { generation: 2, refusals: 0 }),
    ws(T + 1010.3 * S, "start_retry", { generation: 2, refusals: 1 }),
    ws(T + 1015.3 * S, "container_start", { generation: 2, refusals: 1 }),
    ws(T + 1025.3 * S, "start_retry", { generation: 2, refusals: 2 }),
    ws(T + 1035.3 * S, "container_start", { generation: 2, refusals: 2 }),
    ws(T + 1060 * S, "restore_confirmed", { generation: 2, layers: 3 }),
    route(T + 1070 * S, `/v1/hosts/${HOST_A}/tunnel`, 2),
    route(T + 1075 * S, "/v1/runners/runner_token_0789/tunnel", 2),
    ws(T + 2000 * S, "staging_kill", { generation: 2, state: "host_running" }),
    ws(T + 2030 * S, "unexpected_stop", { generation: 2, credentialsPending: 0 }),
    resume(T + 2100 * S),
    line(T + 2100.1 * S, {
      cfo: "control",
      event: "reserve_granted",
      computerId: A,
      generation: 3,
    }),
    ws(T + 2100.4 * S, "container_start", { generation: 3, refusals: 0 }),
    route(T + 2160 * S, `/v1/hosts/${HOST_A}/tunnel`, 3),
    route(T + 2170 * S, "/v1/runners/runner_token_0abc/tunnel", 3),
    // A refused tunnel, another computer's, and lines that are not events: ignored.
    route(T + 2171 * S, `/v1/hosts/${HOST_A}/tunnel`, 3, A, 409),
    { timestamp: T + 2172 * S, source: "plain text" },
    resume(T + 2200 * S, B, 409),
    line(T + 2200.1 * S, {
      cfo: "control",
      event: "reserve_refused",
      computerId: B,
      generation: 2,
      reason: "at_capacity",
      limit: 1,
    }),
  ];

  it("times each wake from its start() to the host and to the first turn, with the gap after the stop", () => {
    const { wakes, refused } = wakeTable([...logs].reverse());
    expect(wakes.map((w) => [w.computerId, w.generation])).toEqual([
      [A, 1],
      [A, 2],
      [A, 3],
    ]);
    const [first, second, third] = wakes;
    expect(first).toMatchObject({
      resumeAt: T,
      startAt: T + 0.5 * S,
      retries: 0,
      layers: 0,
      host: "7f3c2a9e",
      stopBefore: null,
      killAt: null,
      timedFrom: "start",
      ms: { startToHost: 49.5 * S, hostToRunner: 8 * S, resumeToRunner: 58 * S, stopToStart: null },
    });
    expect(first?.deliveredAt).toBe(T + 42 * S);
    expect(second).toMatchObject({
      retries: 2,
      startAt: T + 1000.3 * S,
      lastStartAt: T + 1035.3 * S,
      stopBefore: { kind: "stop_confirmed", reason: "sleep", at: T + 900 * S },
      ms: { stopToStart: 100.3 * S, retrying: 35 * S, startToHost: 69.7 * S },
    });
    expect(second?.ms.startToRestored).toBeCloseTo(59.7 * S);
    expect(third).toMatchObject({
      killAt: T + 2000 * S,
      stopBefore: { kind: "unexpected_stop", reason: "unexpected" },
      ms: { killToStop: 30 * S, killToHost: 160 * S, stopToStart: 70.4 * S },
    });
    expect(refused).toEqual([
      { at: T + 2200 * S, computerId: B, kind: "resume_refused", detail: "status 409" },
      {
        at: T + 2200.1 * S,
        computerId: B,
        kind: "reserve_refused",
        detail: '{"reason":"at_capacity","limit":1}',
      },
    ]);
    const table = describeWakes({ wakes, refused });
    expect(table[0]).toContain("start→host 49.5s");
    expect(table[1]).toContain("retries 2 over 35.0s");
    expect(table[1]).toContain("stop→start 100.3s (stop_confirmed: sleep)");
    expect(table[2]).toContain("kill→stop 30.0s");
    expect(table[3]).toContain("REFUSED resume_refused status 409");
    expect(describeWakes({ wakes: [], refused: [] })).toEqual(["no wake in these logs"]);
  });

  it("reads logs from before WP3.33 (28 Oct's, redacted): timed from the grant, no host prefix", () => {
    const old: LogLine[] = [
      line(T, { cfo: "launcher_api", event: "call", operation: "resume", status: 200 }),
      line(T + 0.1 * S, { cfo: "control", event: "reserve_granted", computerId: A, generation: 1 }),
      ws(T + 40 * S, "restore_confirmed", { generation: 1, layers: 0 }),
      ws(T + 41 * S, "start_delivered", { attempt: 1, outcome: "taken" }),
      route(T + 45 * S, "/v1/hosts/<hex32>/tunnel", 1),
      line(T + 900 * S, { cfo: "control", event: "released", computerId: A, generation: 1 }),
      line(T + 1000 * S, {
        cfo: "control",
        event: "reserve_granted",
        computerId: A,
        generation: 2,
      }),
      ws(T + 1041 * S, "start_delivered", { attempt: 1, outcome: "taken" }),
    ];
    const { wakes } = wakeTable(old);
    expect(wakes).toHaveLength(2);
    expect(wakes[0]).toMatchObject({
      timedFrom: "grant",
      resumeAt: null,
      deliveredAt: T + 41 * S,
      host: null,
      hostAt: T + 45 * S,
      ms: { startToHost: 44.9 * S, hostToRunner: null },
    });
    expect(wakes[1]).toMatchObject({
      deliveredAt: T + 1041 * S,
      stopBefore: { kind: "released", at: T + 900 * S },
      hostAt: null,
    });
    expect(describeWakes({ wakes, refused: [] })[0]).toContain("(from the grant)");
  });
});

// ---------------------------------------------------------------------------------------------
// The scan.

// Token-shaped values are built at run time: no source file holds one.
const tok = {
  claude: ["sk", "ant", "oat01", "Q".repeat(20) + "q1".repeat(20)].join("-"),
  openai: ["sk", "proj", "A1b2".repeat(12)].join("-"),
  github: `${"gh"}u_${"a1B2".repeat(9)}`,
  jwt: [`ey${"J"}hbGciOiJIUzI1NiJ9`, `ey${"J"}zdWIiOiJ4In0`, "Ab1".repeat(15).slice(0, 43)].join(
    ".",
  ),
  hex64: "ab".repeat(32),
  urlsafe: "Zq3".repeat(15).slice(0, 43),
};

describe("run.sh scan's token pass", () => {
  it("finds each token shape once, by kind and offset, never as text", () => {
    for (const [kind, value] of [
      ["claude", tok.claude],
      ["openai", tok.openai],
      ["github", tok.github],
      ["jwt", tok.jwt],
      ["hex64", tok.hex64],
      ["urlsafe256", tok.urlsafe],
    ] as const) {
      expect(tokenHits(`x ${value} y`)).toEqual([{ kind, index: 2 }]);
    }
    expect(TOKEN_SHAPES.map((s) => s.kind)).toEqual([
      "claude",
      "openai",
      "github",
      "jwt",
      "hex64",
      "urlsafe256",
    ]);
  });

  it("does not count what only looks alike: digests, IDs, lower-case runs, a JWT's own parts", () => {
    expect(tokenHits(`image@sha256:${"ab".repeat(32)}`)).toEqual([]);
    expect(tokenHits(`${"ab".repeat(32)}c`)).toEqual([]);
    expect(tokenHits("/v1/runners/runner_token_0123456789abcdef0123456789abcdef/tunnel")).toEqual(
      [],
    );
    expect(
      tokenHits(`cmp_01hzy3m8k6q4t2v9w7x5r0s1n3 ${"a".repeat(43)} task-${"b".repeat(30)}`),
    ).toEqual([]);
    expect(
      tokenHits("3f2a9c1e-7b4d-4e8f-a1c2-5d6e7f809a1b 7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f"),
    ).toEqual([]);
    // A JWT whose signature is 43 base64url characters is one JWT, not also a launch token.
    expect(tokenHits(tok.jwt).map((h) => h.kind)).toEqual(["jwt"]);
  });

  it("reports counts, the line, time, event and field of each hit, and never the value", () => {
    const events = [
      // A raw Workers Logs event, a token in its message and in a logged field.
      JSON.stringify({
        timestamp: T,
        $workers: { scriptVersion: { id: "3f2a9c1e-7b4d-4e8f-a1c2-5d6e7f809a1b" } },
        $metadata: { message: `oops ${tok.claude}` },
        source: { cfo: "server", event: "forward_error", error: `bearer ${tok.jwt}` },
      }),
      // A line logs.ts reduced, whose source Workers Logs kept as a string.
      JSON.stringify({
        timestamp: T + 1,
        source: JSON.stringify({ cfo: "x", event: "y", note: tok.github }),
      }),
      `not json ${tok.hex64}`,
      "",
      JSON.stringify({ timestamp: T + 2, source: { event: "z", [tok.urlsafe]: 1, n: tok.openai } }),
      `cfo-canary-wp35-terminal and cfo-capability.${tok.urlsafe} and r2-key-0123456789`,
    ];
    const report = scanLines("cfo-stg-wp318-platform", events, [
      { label: "r2_access_key_id", value: "r2-key-0123456789" },
      { label: "short", value: "abc" },
    ]);
    expect(report).toMatchObject({
      worker: "cfo-stg-wp318-platform",
      lines: 5,
      unreadable: 2,
      canaryHits: 1,
      capabilityHits: 1,
      tokens: {
        claude: 1,
        openai: 1,
        github: 1,
        jwt: 1,
        hex64: 1,
        urlsafe256: 2,
        "value:r2_access_key_id": 1,
        "value:short": 0,
      },
    });
    expect(report.tokenPositions).toEqual([
      { line: 1, at: T, event: "forward_error", path: "$metadata.message", kind: "claude" },
      { line: 1, at: T, event: "forward_error", path: "source.error", kind: "jwt" },
      { line: 2, at: T + 1, event: "y", path: "source{}.note", kind: "github" },
      { line: 3, at: null, event: null, path: "(line)", kind: "hex64" },
      { line: 4, at: T + 2, event: "z", path: "source.<key>", kind: "urlsafe256" },
      { line: 4, at: T + 2, event: "z", path: "source.n", kind: "openai" },
      { line: 5, at: null, event: null, path: "(line)", kind: "urlsafe256" },
    ]);
    // A value used as a key never reaches a printed path, nor one as an event's name.
    const keyed = scanLines("w", [
      JSON.stringify({
        timestamp: T,
        source: {
          event: tok.hex64,
          [tok.hex64]: { inner: tok.github },
          ok_name: { [tok.urlsafe]: 1 },
        },
      }),
    ]);
    expect(keyed.tokenPositions.map((p) => [p.path, p.kind, p.event])).toEqual([
      ["source.event", "hex64", null],
      ["source.<key>", "hex64", null],
      ["source.<key>.inner", "github", null],
      ["source.ok_name.<key>", "urlsafe256", null],
    ]);
    expect(JSON.stringify(keyed)).not.toMatch(
      new RegExp(`${tok.hex64}|${tok.urlsafe}|${tok.github}`),
    );
    const printed = JSON.stringify(report);
    for (const value of [...Object.values(tok), "r2-key-0123456789"]) {
      expect(printed).not.toContain(value);
    }
  });

  it("lists terminal events with their close codes and instances, per window, and every instance start", () => {
    const wsLine = (at: number, source: Record<string, unknown>, version = "3f2a9c1e-7b4d-4e8f") =>
      JSON.stringify({ timestamp: at, $workers: { scriptVersion: { id: version } }, source });
    const lines = [
      wsLine(T, {
        cfo: "workspace",
        event: "instance_started",
        class: "WorkspaceDO",
        instanceId: "aaaa000000000001",
        computerId: A,
      }),
      wsLine(T + 1, {
        cfo: "workspace",
        event: "terminal_bridged",
        window: 1,
        instanceId: "aaaa000000000001",
      }),
      wsLine(T + 2, {
        cfo: "workspace",
        event: "terminal_stream_ended",
        window: 1,
        reason: "the link dropped",
        code: 4003,
        computerCode: 1006,
        computerClean: false,
        instanceId: "aaaa000000000001",
      }),
      wsLine(T + 3, {
        cfo: "workspace",
        event: "instance_started",
        class: "WorkspaceDO",
        instanceId: "aaaa000000000002",
        computerId: A,
      }),
      wsLine(T + 4, {
        cfo: "workspace",
        event: "terminal_reattached",
        window: 1,
        instanceId: "aaaa000000000002",
      }),
      wsLine(T + 5, {
        cfo: "workspace",
        event: "terminal_taken_over",
        window: 1,
        instanceId: "aaaa000000000002",
      }),
      wsLine(T + 6, {
        cfo: "workspace",
        event: "terminal_session_gone",
        window: 2,
        code: 4002,
        instanceId: "bbbb000000000009",
      }),
      wsLine(T + 7, { cfo: "workspace", event: "terminal_upgrade_refused", reason: "expired" }),
      wsLine(T + 8, { cfo: "pages", event: "page_change_refused", reason: "intent" }),
      wsLine(T + 9, {
        cfo: "watchdog",
        event: "instance_started",
        class: "OmnigentServer",
        instanceId: "cccc000000000003",
        containerRunning: true,
      }),
    ];
    const report = scanLines("w", lines);
    expect(report.events).toHaveLength(7);
    expect(report.events[1]).toEqual({
      at: T + 2,
      event: "terminal_stream_ended",
      reason: "the link dropped",
      window: 1,
      code: 4003,
      computerCode: 1006,
      computerClean: false,
      instanceId: "aaaa000000000001",
    });
    expect(report.terminal.totals).toEqual({
      terminal_reattached: 1,
      terminal_taken_over: 1,
      terminal_session_gone: 1,
    });
    expect(report.terminal.windows).toEqual([
      {
        computerId: A,
        window: 1,
        events: {
          terminal_bridged: 1,
          terminal_stream_ended: 1,
          terminal_reattached: 1,
          terminal_taken_over: 1,
        },
        codes: { "4003": 1 },
        computerCodes: { "1006": 1 },
        instanceIds: ["aaaa000000000001", "aaaa000000000002"],
      },
      {
        computerId: null,
        window: 2,
        events: { terminal_session_gone: 1 },
        codes: { "4002": 1 },
        computerCodes: {},
        instanceIds: ["bbbb000000000009"],
      },
      {
        computerId: null,
        window: null,
        events: { terminal_upgrade_refused: 1 },
        codes: {},
        computerCodes: {},
        instanceIds: [],
      },
    ]);
    expect(report.instances).toEqual([
      {
        at: T,
        class: "WorkspaceDO",
        instanceId: "aaaa000000000001",
        computerId: A,
        version: "3f2a9c1e-7b4d",
      },
      {
        at: T + 3,
        class: "WorkspaceDO",
        instanceId: "aaaa000000000002",
        computerId: A,
        version: "3f2a9c1e-7b4d",
      },
      {
        at: T + 9,
        class: "OmnigentServer",
        instanceId: "cccc000000000003",
        computerId: null,
        version: "3f2a9c1e-7b4d",
      },
    ]);
  });

  it("reads --value-file arguments: a label and a file's first line", () => {
    const files: Record<string, string> = { "/x/id": "0123456789abcdef\n", "/x/empty": "\n" };
    const read = (path: string) => files[path] ?? "";
    expect(valuesFrom(["--value-file", "r2=/x/id", "--value-file", "none=/x/empty"], read)).toEqual(
      [{ label: "r2", value: "0123456789abcdef" }],
    );
    expect(() => valuesFrom(["--value-file", "/x/id"], read)).toThrow(/label/);
    expect(() => valuesFrom(["--values"], read)).toThrow(/unknown argument/);
  });
});

// ---------------------------------------------------------------------------------------------
// The instance starts the analysis lists.

describe("run.sh analyze's instance starts", () => {
  const started = (
    at: number,
    cls: string,
    instanceId: string,
    version = "v1",
    computerId?: string,
  ) =>
    line(
      at,
      {
        cfo: cls === "OmnigentServer" ? "watchdog" : cls === "ControlDO" ? "control" : "workspace",
        event: "instance_started",
        class: cls,
        instanceId,
        ...(computerId === undefined ? {} : { computerId }),
      },
      version,
    );
  const term = (at: number, event: string, instanceId: string, window = 1) =>
    line(at, { cfo: "workspace", event, window, instanceId });

  it("explains starts by a version switch, a deploy, or a planned reset, and lists the rest", () => {
    const planned: Planned[] = [
      { kind: "platform_deploy", at: T - 60 * S, version: "v1" },
      { kind: "server_reset", at: T + 100 * S },
      { kind: "workspace_reset", at: T + 400 * S, computerId: A },
      { kind: "web_deploy", at: T + 500 * S },
    ];
    const lines: LogLine[] = [
      started(T, "OmnigentServer", "s1"),
      started(T + 101 * S, "OmnigentServer", "s2"),
      started(T + 200 * S, "OmnigentServer", "s3"),
      started(T + 300 * S, "OmnigentServer", "s4", "v2"),
      started(T + 10 * S, "WorkspaceDO", "w1", "v1", A),
      term(T + 11 * S, "terminal_bridged", "w1"),
      term(T + 12 * S, "terminal_detached", "w1"),
      started(T + 20 * S, "WorkspaceDO", "w2", "v1", A),
      term(T + 21 * S, "terminal_reattached", "w2"),
      term(T + 22 * S, "terminal_stream_ended", "w2"),
      started(T + 30 * S, "WorkspaceDO", "w3", "v1", A),
      started(T + 40 * S, "WorkspaceDO", "b1", "v0", B),
      started(T + 401 * S, "WorkspaceDO", "w4", "v1", A),
      started(T + 402 * S, "WorkspaceDO", "b2", "v0", B),
      started(T + 50 * S, "ControlDO", "c1"),
      started(T + 60 * S, "ControlDO", "c2"),
      line(T + 70 * S, { cfo: "x", event: "instance_started", class: "SoakRun", instanceId: "r" }),
      line(T + 71 * S, { cfo: "x", event: "instance_started", class: "ControlDO" }),
      { timestamp: T + 72 * S, source: "text" },
    ];
    const starts = instanceStarts(lines, planned);
    expect(starts.map((s) => [s.instanceId, s.cause])).toEqual([
      ["s1", "deploy"],
      ["w1", "deploy"],
      ["w2", "unexplained"],
      ["w3", "idle"],
      ["b1", "idle"],
      ["c1", "deploy"],
      ["c2", "idle"],
      ["s2", "planned_reset"],
      ["s3", "unexplained"],
      ["s4", "deploy"],
      ["w4", "planned_reset"],
      ["b2", "idle"],
    ]);
    expect(starts.find((s) => s.instanceId === "w2")?.note).toContain("terminal stream");
    expect(starts.find((s) => s.instanceId === "s4")?.note).toBe("version v1 → v2");
    expect(instanceCounts(starts)).toEqual({
      OmnigentServer: { deploy: 2, planned_reset: 1, unexplained: 1 },
      WorkspaceDO: { deploy: 1, unexplained: 1, idle: 3, planned_reset: 1 },
      ControlDO: { deploy: 1, idle: 1 },
    });
  });

  it("says when an OmnigentServer start has no earlier instance to compare with", () => {
    const [only] = instanceStarts([started(T, "OmnigentServer", "s1", "v9")], []);
    expect(only).toMatchObject({ cause: "unexplained" });
    expect(only?.note).toContain("no earlier instance");
    const [unversioned] = instanceStarts(
      [
        {
          timestamp: T,
          source: { event: "instance_started", class: "ControlDO", instanceId: "c" },
        },
      ],
      [{ kind: "platform_deploy", at: T - S, version: "v1" }],
    );
    expect(unversioned?.cause).toBe("idle");
  });
});

// ---------------------------------------------------------------------------------------------
// The limit.

describe("run.sh limit", () => {
  it("takes a value only as ControlDO would, and renders it in the soak's platform configuration", () => {
    expect(limitSetting("1")).toBe("1");
    expect(limitSetting("0")).toBe("0");
    expect(limitSetting("default")).toBeNull();
    for (const bad of ["", "-1", "1001", "one", "1.5", " 1"]) {
      expect(() => limitSetting(bad)).toThrow(/CFO_MAX_AWAKE_COMPUTERS/);
    }
    expect(withLimit({ A: "x", [LIMIT_VAR]: "5" }, null)).toEqual({ A: "x" });
    expect(withLimit({ A: "x" }, "1")).toEqual({ A: "x", [LIMIT_VAR]: "1" });
    const rendered = {
      name: "cfo-stg-wp318-platform",
      durable_objects: { bindings: [] },
      migrations: [{ tag: "v1" }],
      r2_buckets: [],
      vars: { CFO_INSTALLATION_ID: "ins_x" },
    };
    expect(soakPlatformConfig(rendered, "b1", "1").vars).toEqual({
      CFO_INSTALLATION_ID: "ins_x",
      WP318_BUILD: "b1",
      [LIMIT_VAR]: "1",
    });
    expect(soakPlatformConfig(rendered, "b1").vars).toEqual({
      CFO_INSTALLATION_ID: "ins_x",
      WP318_BUILD: "b1",
    });
  });

  it("holds once a ControlDO instance runs the deployed version", () => {
    const control = (at: number, version: string, event = "instance_started") =>
      line(at, { cfo: "control", event, class: "ControlDO", instanceId: "c", boots: 2 }, version);
    const lines = [control(T + 2, "v2"), control(T, "v1"), control(T + 1, "v2", "reserve_granted")];
    expect(controlOnVersion(lines, "v2")?.timestamp).toBe(T + 2);
    expect(controlOnVersion(lines, "v3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// run.sh's dry-run and file paths: no account is touched.

describe("run.sh's G3 verbs without an account", () => {
  const dir = mkdtempSync(join(tmpdir(), "wp333-runsh-"));
  const bin = join(dir, "bin");
  const out = join(dir, "out");
  const state = join(dir, "state");
  const touched = join(dir, "cf-was-called");
  spawnSync("mkdir", ["-p", bin, state]);
  writeFileSync(
    join(state, "config.json"),
    JSON.stringify({ accountId: "0".repeat(32), zone: "example.test" }),
  );
  // A stand-in `cf` that records any call: a dry run must never reach Cloudflare.
  writeFileSync(join(bin, "cf"), `#!/bin/sh\necho called >>'${touched}'\nexit 1\n`);
  chmodSync(join(bin, "cf"), 0o755);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) =>
    spawnSync("bash", [join(HERE, "run.sh"), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        WP318_DIR: out,
        CFO_STAGING_DIR: state,
        WP318_MAX_AWAKE: "",
      },
    });

  it("prints its usage, with the new verbs", () => {
    const usage = run();
    expect(usage.status).toBe(2);
    for (const verb of [
      "computer-kill",
      "workspace-reset",
      "server-reset",
      "soak-start",
      "limit",
      "wakes",
      "scan",
    ]) {
      expect(usage.stdout).toContain(`run.sh ${verb}`);
    }
  });

  it("dry-runs each one-shot command: the object it would write, and nothing written", () => {
    for (const args of [
      ["computer-kill", A],
      ["workspace-reset", A],
      ["server-reset"],
      ["soak-start"],
    ]) {
      const result = run(...args, "--dry-run");
      expect([args[0], result.status, result.stderr]).toEqual([args[0], 0, ""]);
      const [said, body] = result.stdout.trim().split("\n");
      expect(said).toMatch(
        /^dry run: would write soak\/commands\/cmd-\d{8}T\d{6}Z-[0-9a-f]{8}\.json into cfo-stg-wp318-platform-results:$/,
      );
      const key = said?.split(" ")[4] ?? "";
      expect(parseCommand(key, body ?? "")).toMatchObject({
        ok: true,
        command: { command: args[0], computerId: args[1] ?? null },
      });
    }
    expect(run("computer-kill").status).toBe(2);
    expect(run("computer-kill", "--dry-run").status).toBe(2);
    const bad = run("workspace-reset", "cmp_nope", "--dry-run");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("needs a computer ID");
    expect(run("server-reset", A, "--dry-run").status).toBe(2);
    expect(existsSync(touched)).toBe(false);
  });

  it("dry-runs a limit with ControlDO's own check, keeping and deploying nothing", () => {
    const one = run("limit", "1", "--dry-run");
    expect(one.status).toBe(0);
    expect(one.stdout).toContain('{"CFO_MAX_AWAKE_COMPUTERS":"1"}');
    expect(one.stdout).toContain("dry run: nothing kept or deployed");
    expect(run("limit", "default", "--dry-run").stdout).toContain("(unset: the default, 2)");
    const bad = run("limit", "2000", "--dry-run");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("CFO_MAX_AWAKE_COMPUTERS must be a whole number");
    expect(existsSync(join(out, "limit"))).toBe(false);
    expect(existsSync(touched)).toBe(false);
  });

  it("reads kept logs with wakes --file and scan --file", () => {
    const logs = join(dir, "logs.jsonl");
    writeFileSync(
      logs,
      [
        line(T, { cfo: "control", event: "reserve_granted", computerId: A, generation: 1 }),
        ws(T + 0.5 * S, "container_start", { generation: 1, refusals: 0 }),
        route(T + 50 * S, `/v1/hosts/${HOST_A}/tunnel`, 1),
      ]
        .map((l) => JSON.stringify(l))
        .join("\n"),
    );
    const wakes = run("wakes", "--file", logs);
    expect(wakes.status).toBe(0);
    expect(wakes.stdout).toContain(`${A}  g1  start→host 49.5s`);
    expect(wakes.stdout).toContain("host 7f3c2a9e");
    const scan = run("scan", "--file", logs);
    expect(scan.status).toBe(0);
    expect(JSON.parse(scan.stdout)).toMatchObject({ worker: "logs.jsonl", lines: 3 });
    expect(existsSync(touched)).toBe(false);
  });
});
