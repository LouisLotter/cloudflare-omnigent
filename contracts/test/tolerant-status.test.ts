// WP3.29: the supervisor's `computer_status` reply is read tolerantly (a newer supervisor's
// field or enum value degrades to "can't tell"), and every other computer-API message stays
// strict.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CliLoginStatus,
  HostnameState,
  StatusSignInState,
  SupervisorAlertKind,
  SupervisorMessage,
  SupervisorReply,
  SupervisorStatus,
  WorkspaceCommand,
  WorkspaceCommandReply,
} from "../src/index.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const load = (...path: string[]): unknown =>
  JSON.parse(readFileSync(join(fixturesDir, ...path), "utf8"));
const valid = (name: string): [string, Record<string, unknown>][] =>
  readdirSync(join(fixturesDir, name))
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, load(name, f) as Record<string, unknown>]);

const current = (load("WorkspaceCommandReply", "computer-status.json") as { status: object })
  .status as Record<string, unknown>;

describe("the computer status, read tolerantly", () => {
  it("parses a future supervisor's status, showing what it does not know as unknown", () => {
    const { input } = load(
      "WorkspaceCommandReply",
      "tolerated",
      "computer-status-future-supervisor.json",
    ) as {
      input: unknown;
    };
    const reply = WorkspaceCommandReply.parse(input);
    if (reply.type !== "computer_status") throw new Error("not a status");
    const status = reply.status;
    expect(status.hostname).toBe("unknown");
    expect(status.logins).toEqual({ claude: "signed_in", codex: "unknown" });
    expect(status.signIn).toEqual({ claude: "unknown", codex: "awaiting_user" });
    expect(status.alerts).toEqual([
      { kind: "rc53_finding", count: 3 },
      { kind: "other", count: 7 },
    ]);
    // Fields it does not know are dropped at every depth, never passed on.
    expect(Object.keys(reply).sort()).toEqual(["status", "type"]);
    expect(Object.keys(status)).not.toContain("memory");
    expect(Object.keys(status.versions).sort()).toEqual(["claude", "codex", "gh"]);
    expect(status.disk).toEqual({ totalBytes: 21474836480, freeBytes: 17179869184 });
    expect(Object.keys(status.captures[0]?.rc53 ?? {})).not.toContain("skipped");
    expect(JSON.stringify(status)).not.toContain("future");
  });

  it("maps any unknown string to the field's can't-tell value and keeps every known one", () => {
    type Field = {
      known: readonly string[];
      fallback: string;
      build: (value: string) => unknown;
      read: (status: SupervisorStatus) => string | undefined;
    };
    const fields: Field[] = [
      {
        known: HostnameState.options,
        fallback: "unknown",
        build: (v) => ({ ...current, hostname: v }),
        read: (s) => s.hostname,
      },
      {
        known: CliLoginStatus.options,
        fallback: "unknown",
        build: (v) => ({ ...current, logins: { claude: v, codex: "signed_in" } }),
        read: (s) => s.logins.claude,
      },
      {
        known: StatusSignInState.options,
        fallback: "unknown",
        build: (v) => ({ ...current, signIn: { claude: "none", codex: v } }),
        read: (s) => s.signIn.codex,
      },
      {
        known: SupervisorAlertKind.options,
        fallback: "other",
        build: (v) => ({ ...current, alerts: [{ kind: v, count: 1 }] }),
        read: (s) => s.alerts[0]?.kind,
      },
    ];
    for (const field of fields) {
      const value = fc.oneof(fc.constantFrom(...field.known), fc.string({ maxLength: 40 }));
      fc.assert(
        fc.property(value, (v) => {
          const expected = field.known.includes(v) ? v : field.fallback;
          expect(field.read(SupervisorStatus.parse(field.build(v)))).toBe(expected);
        }),
      );
    }
  });

  it("still refuses a wrong type, a missing field, a bad version or an out-of-bound count", () => {
    const { hostname: _, ...withoutHostname } = current;
    for (const bad of [
      { ...current, hostname: 5 },
      { ...current, hostname: null },
      withoutHostname,
      { ...current, logins: { claude: "signed_in" } },
      { ...current, signIn: { claude: ["none"], codex: "none" } },
      { ...current, alerts: [{ kind: 1, count: 1 }] },
      { ...current, alerts: [{ kind: "other", count: -1 }] },
      { ...current, alerts: Array.from({ length: 33 }, () => ({ kind: "other", count: 1 })) },
      { ...current, versions: { claude: "v2.1", codex: null, gh: null } },
      { ...current, disk: { totalBytes: 1 } },
      { ...current, rc53: "yes" },
      { ...current, terminals: -1 },
    ]) {
      expect(SupervisorStatus.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("adds up alerts it reads as one kind, within the count's bound", () => {
    const status = SupervisorStatus.parse({
      ...current,
      alerts: [
        { kind: "new_a", count: Number.MAX_SAFE_INTEGER },
        { kind: "new_b", count: 5 },
        { kind: "command_failed", count: 2 },
      ],
    });
    expect(status.alerts).toEqual([
      { kind: "other", count: Number.MAX_SAFE_INTEGER },
      { kind: "command_failed", count: 2 },
    ]);
  });
});

describe("everything else stays strict", () => {
  const withField = (message: Record<string, unknown>) => ({ ...message, futureField: 1 });

  it("refuses every command with an unknown field", () => {
    const commands = valid("WorkspaceCommand");
    expect(commands.length).toBeGreaterThan(10);
    for (const [file, command] of commands) {
      expect(WorkspaceCommand.safeParse(command).success, file).toBe(true);
      expect(WorkspaceCommand.safeParse(withField(command)).success, file).toBe(false);
    }
  });

  it("refuses every supervisor message and every WorkspaceDO answer with an unknown field", () => {
    for (const [file, message] of valid("SupervisorMessage")) {
      expect(SupervisorMessage.safeParse(withField(message)).success, file).toBe(false);
    }
    for (const [file, reply] of valid("SupervisorReply")) {
      expect(SupervisorReply.safeParse(withField(reply)).success, file).toBe(false);
    }
  });

  it("refuses every other command reply with an unknown field, and tolerates the status's", () => {
    let others = 0;
    for (const [file, reply] of valid("WorkspaceCommandReply")) {
      const parsed = WorkspaceCommandReply.safeParse(withField(reply));
      if (reply.type === "computer_status") {
        expect(parsed.success, file).toBe(true);
      } else {
        others += 1;
        expect(parsed.success, file).toBe(false);
      }
    }
    expect(others).toBeGreaterThan(10);
  });

  it("refuses an unknown field inside a report, a sign-in view or a job", () => {
    const status = load("WorkspaceCommandReply", "status.json") as {
      report: Record<string, unknown> & { host: object };
    };
    const signIn = load("WorkspaceCommandReply", "sign-in-awaiting-codex.json") as {
      view: object;
    };
    const job = load("WorkspaceCommandReply", "capture-staged.json") as { job: object };
    for (const bad of [
      { ...status, report: { ...status.report, futureField: 1 } },
      { ...status, report: { ...status.report, host: { ...status.report.host, futureField: 1 } } },
      { ...signIn, view: { ...signIn.view, futureField: 1 } },
      { ...job, job: { ...job.job, futureField: 1 } },
    ]) {
      expect(WorkspaceCommandReply.safeParse(bad).success).toBe(false);
    }
  });

  it("refuses an unknown enum value outside the status", () => {
    const status = load("WorkspaceCommandReply", "status.json") as {
      report: Record<string, unknown> & { host: object; logins: object };
    };
    const signIn = load("WorkspaceCommandReply", "sign-in-awaiting-codex.json") as {
      view: object;
    };
    for (const bad of [
      { ...status, report: { ...status.report, host: { ...status.report.host, state: "paused" } } },
      {
        ...status,
        report: { ...status.report, logins: { claude: "rate_limited", codex: "unknown" } },
      },
      { ...signIn, view: { ...signIn.view, state: "unknown" } },
    ]) {
      expect(WorkspaceCommandReply.safeParse(bad).success).toBe(false);
    }
  });
});
