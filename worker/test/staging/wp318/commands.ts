// The G3 sitting's one-shot harness commands (WP3.33), pure parts and the laptop's CLI. Test
// tooling only, never shipped.
//
// The lead runs `run.sh computer-kill <computer>`, `workspace-reset <computer>`, `server-reset`,
// `soak-start`, or (read-only, for `run.sh limit`) `limits`. run.sh writes a command object into the staging results bucket (the bucket the
// soak run already writes, `<platform Worker>-results`), under `soak/commands/<id>.json`, with the
// lead's own `cf` login. The soak module's cron (soak.ts, every minute) hands the objects to its
// SoakRun object, which runs each one once (`runCommands` below) and records the outcome:
//   - in its own storage, claimed before the effect (persist-before-effect), so a command never
//     runs twice, even when the cron fires twice at once or a pass is cut off;
//   - as `soak/command-results/<id>.json`, which run.sh waits for, and in `soak/commands.json`,
//     every outcome so far, which `run.sh collect` keeps for the analysis;
//   - as a `soak/command` log line with its name, computer and outcome.
// Every command but `soak-start` and the read-only `limits` is refused while a soak run is active,
// so the soak's analysis sees only its scheduled disruptions; SoakRun runs the commands and the
// soak's start one at a time, and decides each command just before its effect (Codex WP3.33
// r1-2). A command older than 10 minutes when it would run (written while the soak module was not
// deployed, say) is refused, never run late.
//
//   node worker/test/staging/wp318/commands.ts make <command> [computer ID]
//       prints the object's key, then its body (one line each); refuses a bad command or ID
//   node worker/test/staging/wp318/commands.ts show <id>
//       reads an outcome (JSON) on stdin and prints it in one line: exit 0 if the command ran,
//       1 if it was refused or failed, 3 (nothing printed) if the input is not that command's
//       outcome (none yet)

/** The commands, as run.sh names them. */
export const SOAK_COMMANDS = [
  "computer-kill",
  "workspace-reset",
  "server-reset",
  "soak-start",
  "limits",
] as const;
export type SoakCommandName = (typeof SOAK_COMMANDS)[number];

/** The commands that act on one computer. */
const ON_A_COMPUTER: ReadonlySet<string> = new Set(["computer-kill", "workspace-reset"]);
/** The commands that change nothing, and so may run during a soak. */
const READ_ONLY: ReadonlySet<string> = new Set(["limits"]);

export const COMMAND_PREFIX = "soak/commands/";
export const RESULT_PREFIX = "soak/command-results/";
/** Every outcome so far, for `run.sh collect` and the analysis. */
export const COMMANDS_LOG_KEY = "soak/commands.json";

/** A command first seen later than this after it was written is refused, never run late. */
export const COMMAND_MAX_AGE_MS = 10 * 60_000;
/** The laptop's clock may run ahead of the Worker's by this much. */
export const COMMAND_MAX_SKEW_MS = 2 * 60_000;
/** A claimed command with no outcome this long after (its pass was cut off) is interrupted. */
export const INTERRUPTED_AFTER_MS = 5 * 60_000;

// A computer ID, as `@cfo/contracts`' ComputerId has it (Crockford base32, lowercase). Kept here so
// that the laptop's CLI imports nothing from the workspace packages; a unit test holds the two
// together.
const COMPUTER_ID = /^cmp_[0-9a-hjkmnp-tv-z]{26}$/;
const COMMAND_ID = /^cmd-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

export interface SoakCommand {
  readonly id: string;
  readonly command: SoakCommandName;
  readonly computerId: string | null;
  /** When the laptop wrote it (ms). */
  readonly issuedAt: number;
}

export type Outcome = "ok" | "refused" | "failed";

/** What a command did, as recorded once. Names, numbers and reasons only: never a value. */
export interface CommandResult {
  readonly id: string;
  readonly command: string | null;
  readonly computerId: string | null;
  readonly outcome: Outcome;
  readonly reason: string | null;
  readonly detail: unknown;
  readonly issuedAt: number | null;
  readonly startedAt: number;
  readonly endedAt: number;
}

/** A new command's ID: the laptop's time and 4 random bytes. */
export function newCommandId(now: number, random: Uint8Array): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const hex = [...random.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== 8) throw new Error("4 random bytes are needed");
  return `cmd-${stamp}Z-${hex}`;
}

export function commandKey(id: string): string {
  return `${COMMAND_PREFIX}${id}.json`;
}

export function resultKey(id: string): string {
  return `${RESULT_PREFIX}${id}.json`;
}

/** The command ID a key under COMMAND_PREFIX names, or null for any other key. */
export function idOfKey(key: string): string | null {
  if (!key.startsWith(COMMAND_PREFIX) || !key.endsWith(".json")) return null;
  const id = key.slice(COMMAND_PREFIX.length, -".json".length);
  return COMMAND_ID.test(id) ? id : null;
}

function isCommandName(name: unknown): name is SoakCommandName {
  return typeof name === "string" && (SOAK_COMMANDS as readonly string[]).includes(name);
}

/** The problem with a command's name and computer, or null. */
function problemOf(name: unknown, computerId: unknown): string | null {
  if (!isCommandName(name)) return `unknown command (${SOAK_COMMANDS.join(", ")})`;
  if (ON_A_COMPUTER.has(name)) {
    if (typeof computerId !== "string" || !COMPUTER_ID.test(computerId)) {
      return `${name} needs a computer ID (cmp_…)`;
    }
  } else if (computerId !== null && computerId !== undefined) {
    return `${name} takes no computer`;
  }
  return null;
}

/** The command the laptop writes; throws on a bad name or computer ID. */
export function makeCommand(
  name: string,
  computerId: string | undefined,
  now: number,
  id: string,
): SoakCommand {
  const problem = problemOf(name, computerId ?? null);
  if (problem !== null) throw new Error(problem);
  if (!COMMAND_ID.test(id)) throw new Error("not a command ID");
  return { id, command: name as SoakCommandName, computerId: computerId ?? null, issuedAt: now };
}

/** A command object as read from the bucket: checked field by field, never trusted. */
export function parseCommand(
  key: string,
  body: string,
):
  | { readonly ok: true; readonly command: SoakCommand }
  | { readonly ok: false; readonly problem: string } {
  const id = idOfKey(key);
  if (id === null) return { ok: false, problem: "not a command key" };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, problem: "not JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: "not an object" };
  }
  const o = raw as Record<string, unknown>;
  const known = new Set(["id", "command", "computerId", "issuedAt"]);
  if (Object.keys(o).some((k) => !known.has(k))) return { ok: false, problem: "unknown fields" };
  if (o.id !== id) return { ok: false, problem: "its ID is not its key's" };
  const problem = problemOf(o.command, o.computerId ?? null);
  if (problem !== null) return { ok: false, problem };
  if (typeof o.issuedAt !== "number" || !Number.isFinite(o.issuedAt)) {
    return { ok: false, problem: "no issuedAt" };
  }
  return {
    ok: true,
    command: {
      id,
      command: o.command as SoakCommandName,
      computerId: typeof o.computerId === "string" ? o.computerId : null,
      issuedAt: o.issuedAt,
    },
  };
}

/** The soak run as the decision needs it: none, running, or ended. */
export interface SoakStatus {
  readonly runId: string;
  readonly ended: boolean;
}

/** Whether a command may run now, or why not. */
export function decide(
  command: SoakCommand,
  context: {
    readonly now: number;
    readonly soak: SoakStatus | null;
    /** The installation's computers; null when the command names none. */
    readonly computers: readonly string[] | null;
  },
): { readonly run: true } | { readonly run: false; readonly reason: string } {
  if (context.now - command.issuedAt > COMMAND_MAX_AGE_MS) return { run: false, reason: "stale" };
  if (command.issuedAt - context.now > COMMAND_MAX_SKEW_MS) {
    return { run: false, reason: "issued_in_the_future" };
  }
  if (command.command === "soak-start") {
    if (context.soak !== null) return { run: false, reason: "already_started" };
  } else if (!READ_ONLY.has(command.command) && context.soak !== null && !context.soak.ended) {
    return { run: false, reason: "soak_running" };
  }
  if (
    command.computerId !== null &&
    context.computers !== null &&
    !context.computers.includes(command.computerId)
  ) {
    return { run: false, reason: "unknown_computer" };
  }
  return { run: true };
}

/** What running a command gave. */
export interface RunOutcome {
  readonly outcome: Outcome;
  readonly reason?: string;
  readonly detail?: unknown;
}

/** A command's claim in the soak run's storage. */
export type Claim =
  | { readonly fresh: true }
  | {
      readonly fresh: false;
      readonly claimedAt: number;
      /** Its recorded outcome; null while it runs, or if its pass was cut off. */
      readonly result: CommandResult | null;
    };

/** What `runCommands` needs from the soak run (soak.ts wires them; the tests fake them). */
export interface CommandPorts {
  now(): number;
  /** The keys under COMMAND_PREFIX. */
  list(): Promise<readonly string[]>;
  /** A command object's body; null if it is gone. */
  read(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  /**
   * Claims a command ID, atomically and durably: `fresh` exactly once per ID, whatever passes
   * run at the same time.
   */
  claim(id: string, at: number): Claim;
  /** Records a claimed command's outcome, durably. */
  record(result: CommandResult): void;
  /** Writes the outcome where run.sh and `run.sh collect` read it. */
  publish(result: CommandResult): Promise<void>;
  soak(): Promise<SoakStatus | null>;
  computers(): Promise<readonly string[]>;
  run(command: SoakCommand): Promise<RunOutcome>;
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
}

function short(error: unknown): string {
  return String(error).slice(0, 200);
}

/**
 * One pass over the command objects: each command runs at most once, after its claim is stored,
 * and its outcome is recorded, published, then its object removed. A command already claimed is
 * never run again: its recorded outcome is published again (an earlier pass may have been cut
 * off before it removed the object), or, past INTERRUPTED_AFTER_MS with none, it is recorded as
 * interrupted. Returns the outcomes recorded in this pass.
 */
export async function runCommands(ports: CommandPorts): Promise<CommandResult[]> {
  const recorded: CommandResult[] = [];
  const finish = async (key: string, result: CommandResult, fresh: boolean) => {
    if (fresh) {
      ports.record(result);
      recorded.push(result);
      ports.log("command", {
        id: result.id,
        command: result.command,
        computerId: result.computerId,
        outcome: result.outcome,
        reason: result.reason,
      });
    }
    await ports.publish(result);
    await ports.remove(key);
  };
  for (const key of await ports.list()) {
    try {
      await one(key);
    } catch (error) {
      // The next pass tries this object again; a claimed command still never runs twice.
      ports.log("command_pass_failed", { key: key.slice(0, 80), error: short(error) });
    }
  }
  return recorded;

  async function one(key: string): Promise<void> {
    const id = idOfKey(key);
    if (id === null) {
      // Only run.sh writes here; anything else is removed, unread.
      ports.log("command_ignored", { key: key.slice(0, 80) });
      await ports.remove(key);
      return;
    }
    const body = await ports.read(key);
    if (body === null) return;
    const now = ports.now();
    const claim = ports.claim(id, now);
    if (!claim.fresh) {
      if (claim.result !== null) {
        await finish(key, claim.result, false);
      } else if (now - claim.claimedAt >= INTERRUPTED_AFTER_MS) {
        await finish(
          key,
          {
            id,
            command: null,
            computerId: null,
            outcome: "failed",
            reason: "interrupted",
            detail: "claimed, and no outcome was recorded: it may or may not have taken effect",
            issuedAt: null,
            startedAt: claim.claimedAt,
            endedAt: now,
          },
          true,
        );
      }
      return;
    }
    // Claimed: from here on this command never runs again, whatever happens below.
    const parsed = parseCommand(key, body);
    if (!parsed.ok) {
      await finish(
        key,
        {
          id,
          command: null,
          computerId: null,
          outcome: "refused",
          reason: `malformed: ${parsed.problem}`,
          detail: null,
          issuedAt: null,
          startedAt: now,
          endedAt: ports.now(),
        },
        true,
      );
      return;
    }
    const command = parsed.command;
    let outcome: RunOutcome;
    let startedAt = now;
    try {
      // The computers first: the soak's state and the time are read last, just before the effect
      // (Codex WP3.33 r1-2), and SoakRun lets no soak start in between.
      const computers = command.computerId === null ? null : await ports.computers();
      const soak = await ports.soak();
      startedAt = ports.now();
      const decision = decide(command, { now: startedAt, soak, computers });
      outcome = decision.run
        ? await ports.run(command)
        : { outcome: "refused", reason: decision.reason };
    } catch (error) {
      outcome = { outcome: "failed", reason: "error", detail: short(error) };
    }
    await finish(
      key,
      {
        id,
        command: command.command,
        computerId: command.computerId,
        outcome: outcome.outcome,
        reason: outcome.reason ?? null,
        detail: outcome.detail ?? null,
        issuedAt: command.issuedAt,
        startedAt,
        endedAt: ports.now(),
      },
      true,
    );
  }
}

/**
 * A forced reset's outcome (Codex WP3.33 r1-3). `stagingReset(reason)` ends the callee's
 * invocation with `ctx.abort(reason)`, so its caller sees exactly `Error: <reason>` (as on
 * 28 Oct). That is the reset; any other rejection (a lost connection, an unknown method before a
 * version switch) may not have reached the object: failed, never retried; and an answer with no
 * error means no reset was seen.
 */
export function resetOutcome(
  reason: string,
  settled: { readonly ok: true } | { readonly ok: false; readonly error: unknown },
): RunOutcome {
  if (settled.ok) return { outcome: "failed", reason: "no_reset_seen" };
  const message = settled.error instanceof Error ? settled.error.message : String(settled.error);
  return message === reason
    ? { outcome: "ok", detail: "reset" }
    : { outcome: "failed", reason: "error", detail: short(settled.error) };
}

/** The outcome in `text` if it is command `id`'s, else null (no object yet, or an error body). */
export function resultFor(text: string, id: string): CommandResult | null {
  try {
    const parsed = JSON.parse(text) as Partial<CommandResult> | null;
    if (parsed === null || typeof parsed !== "object" || parsed.id !== id) return null;
    if (!["ok", "refused", "failed"].includes(String(parsed.outcome))) return null;
    return parsed as CommandResult;
  } catch {
    return null;
  }
}

/** One line for the lead: the command, its computer, its outcome and why. */
export function describeResult(result: CommandResult): string {
  const seconds =
    result.issuedAt === null ? "" : ` ${((result.endedAt - result.issuedAt) / 1000).toFixed(1)} s`;
  const detail =
    result.detail === null || result.detail === undefined
      ? ""
      : ` ${JSON.stringify(result.detail)}`;
  return `${result.outcome} ${result.command ?? "?"}${result.computerId ? ` ${result.computerId}` : ""}${result.reason ? ` (${result.reason})` : ""}${seconds}${detail}`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [verb, name, computerId] = argv;
  if (verb === "make" && name !== undefined) {
    const now = Date.now();
    const id = newCommandId(now, crypto.getRandomValues(new Uint8Array(4)));
    let command: SoakCommand;
    try {
      command = makeCommand(name, computerId, now, id);
    } catch (error) {
      process.stderr.write(`run.sh: ${(error as Error).message}\n`);
      return 2;
    }
    process.stdout.write(`${commandKey(id)}\n${JSON.stringify(command)}\n`);
    return 0;
  }
  if (verb === "show" && name !== undefined) {
    const { readFileSync } = await import("node:fs");
    const result = resultFor(readFileSync(0, "utf8"), name);
    if (result === null) return 3;
    process.stdout.write(`${describeResult(result)}\n`);
    return result.outcome === "ok" ? 0 : 1;
  }
  process.stderr.write("commands.ts make <command> [computer ID] | show <id>\n");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
