import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AbsolutePath,
  CHECKPOINT_POLICY_V1,
  CheckpointPolicy,
  ClaimStartRefused,
  COMPUTER_API_MESSAGES,
  ComputerPageState,
  CREDENTIAL_PROVIDER,
  type CredentialManifest,
  canonicalTreeBytes,
  classifyPath,
  credentialIsNewer,
  credentialObjectKey,
  DeclaredCredentialPath,
  deriveSetupCard,
  ErrorCode,
  type GuardInput,
  globToRegExp,
  HostId,
  INITIAL_CONTEXT,
  type IndexEntry,
  isSaved,
  LAUNCHER_ERROR_CLASS,
  LAUNCHER_ERROR_STATUS,
  LAUNCHER_EVENTS,
  LAUNCHER_OPERATIONS,
  LauncherRequest,
  LauncherResult,
  LayerIndex,
  LIFECYCLE_TABLE,
  LifecycleEvent,
  LifecycleState,
  launcherStringToSign,
  type MachineContext,
  PAGE_EVENTS,
  PagesCall,
  RelativePath,
  SIGN_OUT_TABLE,
  SupervisorMessage,
  sha256Hex,
  signLauncherRequest,
  signOutSettled,
  step,
  TIMING,
  treeDigest,
  typedStatus,
  WorkspaceCommand,
  WorkspaceManifest,
  workspaceBackupPrefix,
} from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));
const encode = (text: string) => new TextEncoder().encode(text);

describe("the launcher API's HMAC envelope", () => {
  const vectors = load("vectors/launcher-signing-v1.json") as {
    key: string;
    cases: {
      operation: string;
      keyId: string;
      timestamp: number;
      body: string;
      stringToSign: string;
      headers: Record<string, string>;
    }[];
  };

  it("reproduces the vectors, which Python's hmac computed independently", async () => {
    for (const c of vectors.cases) {
      const body = encode(c.body);
      expect(
        launcherStringToSign({
          operation: c.operation,
          keyId: c.keyId,
          timestamp: String(c.timestamp),
          bodySha256: await sha256Hex(body),
        }),
      ).toBe(c.stringToSign);
      const headers = await signLauncherRequest({
        key: encode(vectors.key),
        keyId: c.keyId,
        operation: c.operation,
        timestamp: c.timestamp,
        body,
      });
      expect(headers).toEqual(c.headers);
      // The vector's body is a valid request for its operation.
      expect(LauncherRequest.parse(JSON.parse(c.body)).operation).toBe(c.operation);
    }
  });

  it("binds the operation, key ID, timestamp and every body byte", async () => {
    const c = vectors.cases[0];
    if (!c) throw new Error("no vector");
    const sign = (
      over: Partial<{ operation: string; keyId: string; timestamp: number }>,
      body = c.body,
    ) =>
      signLauncherRequest({
        key: encode(vectors.key),
        keyId: over.keyId ?? c.keyId,
        operation: over.operation ?? c.operation,
        timestamp: over.timestamp ?? c.timestamp,
        body: encode(body),
      });
    const signature = (await sign({}))["X-Omnigent-Signature"];
    for (const changed of [
      await sign({ operation: "resume" }),
      await sign({ keyId: "k-2026-11" }),
      await sign({ timestamp: c.timestamp + 1 }),
      await sign({}, `${c.body} `),
    ]) {
      expect(changed["X-Omnigent-Signature"]).not.toBe(signature);
    }
  });

  it("refuses a short key and a malformed key ID", async () => {
    const body = encode("{}");
    await expect(
      signLauncherRequest({
        key: encode("short"),
        keyId: "k",
        operation: "prepare",
        timestamp: 1,
        body,
      }),
    ).rejects.toThrow();
    await expect(
      signLauncherRequest({
        key: encode("x".repeat(32)),
        keyId: "bad key",
        operation: "prepare",
        timestamp: 1,
        body,
      }),
    ).rejects.toThrow();
  });
});

describe("the launcher API's operations", () => {
  const operations = LauncherRequest.options.map((o) => o.shape.operation.value);

  it("has one rule per operation, matching the fork's launcher methods", () => {
    expect(Object.keys(LAUNCHER_OPERATIONS).sort()).toEqual([...operations].sort());
    // Omnigent passes its own operation ID only to claim_start and suspend (core change 13).
    expect(
      operations.filter((op) => LAUNCHER_OPERATIONS[op].operationIdFromOmnigent).sort(),
    ).toEqual(["claim_start", "suspend"]);
    // The durability wait precedes every platform effect of these four (R-23, FH-29).
    expect(operations.filter((op) => LAUNCHER_OPERATIONS[op].durabilityWait).sort()).toEqual([
      "provision",
      "start_host",
      "suspend",
      "terminate",
    ]);
    // Whatever Omnigent passes an operation ID to must record its outcome under it.
    for (const op of operations) {
      if (LAUNCHER_OPERATIONS[op].operationIdFromOmnigent) {
        expect(LAUNCHER_OPERATIONS[op].idempotency).toBe("operation_id");
      }
    }
  });

  it("answers each operation with a result of the same operation", () => {
    const resultOps = new Set(
      LauncherResult.options.flatMap((o) =>
        "shape" in o
          ? [o.shape.operation.value]
          : o.options.map((inner) => inner.shape.operation.value),
      ),
    );
    expect([...resultOps].sort()).toEqual([...operations].sort());
  });

  it("raises SandboxGoneError only for gone, and maps every error code", () => {
    expect(Object.keys(LAUNCHER_ERROR_STATUS).sort()).toEqual([...ErrorCode.options].sort());
    expect(Object.keys(LAUNCHER_ERROR_CLASS).sort()).toEqual([...ErrorCode.options].sort());
    expect(
      ErrorCode.options.filter((code) => LAUNCHER_ERROR_CLASS[code] === "sandbox_gone"),
    ).toEqual(["gone"]);
    expect(LAUNCHER_ERROR_CLASS.at_capacity).toBe("readable_refusal");
    expect(LAUNCHER_ERROR_CLASS.unavailable).toBe("unknown_outcome");
  });
});

describe("IDs and paths", () => {
  it("takes Omnigent's host IDs, uuid4().hex, and refuses the dashed form", () => {
    expect(HostId.safeParse("7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f").success).toBe(true);
    expect(HostId.safeParse("7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f").success).toBe(false);
    expect(HostId.safeParse("7F3C2A9E4B1D4E8A9C2F1A2B3C4D5E6F").success).toBe(false);
  });

  it("accepts only normalised relative paths, so no deletion leaves its roots", () => {
    for (const ok of ["a", "a/b", "...", ".x", "a/.x/..y", "notes\tand tabs.txt", "a/b\nc"]) {
      expect(RelativePath.safeParse(ok).success, ok).toBe(true);
    }
    for (const no of [
      "",
      "/a",
      "a/",
      "a//b",
      ".",
      "..",
      "a/./b",
      "a/../b",
      "../a",
      "a/..",
      "a\0b",
    ]) {
      expect(RelativePath.safeParse(no).success, JSON.stringify(no)).toBe(false);
    }
    expect(AbsolutePath.safeParse("/home/omnigent/work").success).toBe(true);
    for (const no of ["/", "home", "/home/../root", "/home//x", "/home/"]) {
      expect(AbsolutePath.safeParse(no).success, no).toBe(false);
    }
  });

  it("keeps every relative path it accepts free of '..' and '.' segments (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", ".", "..", "", "b/c", "x\0"), { maxLength: 6 }),
        (parts) => {
          const path = parts.join("/");
          if (RelativePath.safeParse(path).success) {
            expect(path.split("/").every((s) => s !== "" && s !== "." && s !== "..")).toBe(true);
            expect(path.includes("\0")).toBe(false);
          }
        },
      ),
    );
  });

  it("names R2 keys per computer (RC-25)", () => {
    const cmp = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
    expect(workspaceBackupPrefix(cmp)).toBe(`workspace/${cmp}/`);
    expect(credentialObjectKey(cmp, "ckp_01hzy5b2c3d4e5f6g7h8j9k0m1")).toBe(
      `credentials/${cmp}/ckp_01hzy5b2c3d4e5f6g7h8j9k0m1.json`,
    );
    expect(() => workspaceBackupPrefix("../other")).toThrow();
  });
});

describe("the tree index and its digest", () => {
  const vectors = load("vectors/tree-digest-v1.json") as {
    cases: { name: string; entries: IndexEntry[]; treeDigest: string }[];
  };

  it("matches the digests Python computed independently", async () => {
    for (const c of vectors.cases) expect(await treeDigest(c.entries), c.name).toBe(c.treeDigest);
  });

  it("does not depend on entry order, and tells trees apart (property)", async () => {
    const entries = vectors.cases.find((c) => c.name === "base")?.entries ?? [];
    const digest = await treeDigest(entries);
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(entries, { minLength: entries.length }),
        async (shuffled) => {
          expect(await treeDigest(shuffled)).toBe(digest);
        },
      ),
    );
    // A tab in a name cannot be confused with a field boundary.
    const a: IndexEntry = { path: "x\ty", type: "dir", mode: 0o755, uid: 0, gid: 0 };
    const b: IndexEntry = { path: "x", type: "dir", mode: 0o755, uid: 0, gid: 0 };
    expect(canonicalTreeBytes([a])).not.toEqual(canonicalTreeBytes([b]));
  });

  it("keeps the golden layer indexes consistent with their trees", async () => {
    const base = LayerIndex.parse(load("fixtures/LayerIndex/base.json"));
    const delta = LayerIndex.parse(load("fixtures/LayerIndex/delta-changes.json"));
    expect(await treeDigest(base.entries)).toBe(base.treeDigest);
    expect(delta.parentTreeDigest).toBe(base.treeDigest);
    const manifest = WorkspaceManifest.parse(
      load("fixtures/WorkspaceManifest/base-and-deltas.json"),
    );
    expect(manifest.layers[0].treeDigest).toBe(base.treeDigest);
    expect(manifest.layers[1]?.treeDigest).toBe(delta.treeDigest);
  });
});

describe("credential checkpoints", () => {
  it("publishes only a newer copy: a higher order in the generation, or a newer generation", () => {
    expect(credentialIsNewer({ generation: 3, order: 1 }, null)).toBe(true);
    expect(credentialIsNewer({ generation: 3, order: 5 }, { generation: 3, order: 4 })).toBe(true);
    expect(credentialIsNewer({ generation: 3, order: 4 }, { generation: 3, order: 4 })).toBe(false);
    expect(credentialIsNewer({ generation: 3, order: 9 }, { generation: 4, order: 1 })).toBe(false);
    expect(credentialIsNewer({ generation: 5, order: 1 }, { generation: 4, order: 99 })).toBe(true);
  });

  it("is a total order on (generation, order) (property)", () => {
    const copy = fc.record({ generation: fc.nat(10), order: fc.integer({ min: 1, max: 10 }) });
    fc.assert(
      fc.property(copy, copy, (a, b) => {
        const forward = credentialIsNewer(a, b);
        const backward = credentialIsNewer(b, a);
        const same = a.generation === b.generation && a.order === b.order;
        expect(forward && backward).toBe(false);
        expect(forward || backward || same).toBe(true);
      }),
    );
  });

  it("declares both providers' files", () => {
    expect(DeclaredCredentialPath.options).toContain(".codex/.credentials.json");
    expect(new Set(Object.values(CREDENTIAL_PROVIDER))).toEqual(new Set(["claude", "codex"]));
  });
});

describe("the checkpoint policy, version 1", () => {
  const vectors = load("vectors/checkpoint-policy-v1.json") as {
    cases: { path: string; tmpRel?: string; action: string; rule: string }[];
  };

  it("is the golden fixture, and parses", () => {
    expect(CheckpointPolicy.parse(CHECKPOINT_POLICY_V1)).toEqual(
      load("fixtures/CheckpointPolicy/v1.json"),
    );
  });

  it("decides every vector path as recorded", () => {
    for (const c of vectors.cases) {
      const decision = classifyPath(
        CHECKPOINT_POLICY_V1,
        c.path,
        c.tmpRel === undefined ? {} : { tmpRel: c.tmpRel },
      );
      expect(decision, c.path).toEqual({ action: c.action, rule: c.rule });
    }
  });

  it("never lets an earlier rule save a path a non-saving rule names (no shadowing)", () => {
    // Instantiate each pattern of every rule that does not save, and check that no earlier rule
    // saves the sample: a save rule above a secret family would leak it.
    const fill = (pattern: string) =>
      pattern.replace(/\*\*/g, "d1/d2").replace(/\*/g, "s3q").replace(/\?/g, "a");
    for (const [i, rule] of CHECKPOINT_POLICY_V1.rules.entries()) {
      if (isSaved({ action: rule.action, rule: rule.id })) continue;
      for (const pattern of rule.patterns) {
        const sample = fill(pattern);
        expect(globToRegExp(pattern).test(sample), pattern).toBe(true);
        const tmpRel = rule.root === "tmp" ? "t" : undefined;
        const path = tmpRel ? `${tmpRel}/${sample}` : sample;
        const decision = classifyPath(CHECKPOINT_POLICY_V1, path, tmpRel ? { tmpRel } : {});
        expect(isSaved(decision), `${rule.id}: ${path} -> ${decision.rule}`).toBe(false);
        const decidedBy = CHECKPOINT_POLICY_V1.rules.findIndex((r) => r.id === decision.rule);
        expect(decidedBy, path).toBeLessThanOrEqual(i);
      }
    }
  });

  it("keeps every declared credential file and its siblings out of the workspace (property)", () => {
    const suffix = fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/);
    fc.assert(
      fc.property(fc.constantFrom(...DeclaredCredentialPath.options), suffix, (path, extra) => {
        expect(classifyPath(CHECKPOINT_POLICY_V1, path).action).toBe("credential");
        expect(classifyPath(CHECKPOINT_POLICY_V1, `${path}.${extra}`).action).toBe("credential");
      }),
    );
  });

  it("matches as S6 did: '*' within a segment, '**' across them", () => {
    expect(globToRegExp("a/*").test("a/b")).toBe(true);
    expect(globToRegExp("a/*").test("a/b/c")).toBe(false);
    expect(globToRegExp("a/**").test("a/b/c")).toBe(true);
    expect(globToRegExp("a/**").test("a")).toBe(false);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a?c").test("a/c")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(classifyPath({ ...CHECKPOINT_POLICY_V1, rules: [] } as never, "x")).toEqual({
      action: "unclassified",
      rule: "none",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The lifecycle table.

const GUARD_INPUTS: readonly GuardInput[] = [
  "at_capacity",
  "attempt_current",
  "terminal_open",
  "runner_processes",
  "retries_left",
  "sleeps_refused_thrice",
  "sign_out_settled",
];

function* subsets<T>(items: readonly T[]): Generator<Set<T>> {
  for (let mask = 0; mask < 1 << items.length; mask += 1) {
    yield new Set(items.filter((_, i) => mask & (1 << i)));
  }
}

const key = (c: MachineContext) => JSON.stringify(c);

/** Every context reachable from a new computer, with every combination of guard inputs. */
function reachable(): MachineContext[] {
  const seen = new Map<string, MachineContext>([[key(INITIAL_CONTEXT), INITIAL_CONTEXT]]);
  const queue = [INITIAL_CONTEXT];
  const allInputs = [...subsets(GUARD_INPUTS)];
  while (queue.length > 0) {
    const context = queue.shift() as MachineContext;
    for (const event of LifecycleEvent.options) {
      for (const inputs of allInputs) {
        const next = step(context, event, inputs).context;
        if (!seen.has(key(next))) {
          seen.set(key(next), next);
          queue.push(next);
        }
      }
    }
  }
  return [...seen.values()];
}

const contexts = reachable();

describe("the lifecycle table", () => {
  it("reaches every state from a new computer", () => {
    expect(new Set(contexts.map((c) => c.state))).toEqual(new Set(LifecycleState.options));
  });

  it("answers every launcher call and page action in every state", () => {
    for (const state of LifecycleState.options) {
      for (const event of [...LAUNCHER_EVENTS, ...PAGE_EVENTS]) {
        expect(LIFECYCLE_TABLE[state][event], `${state} × ${event}`).toBeDefined();
      }
    }
    for (const context of contexts) {
      for (const event of [...LAUNCHER_EVENTS, ...PAGE_EVENTS]) {
        for (const inputs of subsets(GUARD_INPUTS)) {
          expect(step(context, event, inputs).reply, `${context.state} × ${event}`).toBeDefined();
        }
      }
    }
  });

  it("ends every cell with a rule that has no guard", () => {
    for (const state of LifecycleState.options) {
      for (const [event, cell] of Object.entries(LIFECYCLE_TABLE[state])) {
        const last = cell[cell.length - 1];
        expect(last?.when === undefined && last?.unless === undefined, `${state} × ${event}`).toBe(
          true,
        );
      }
    }
  });

  it("has no state for saving: a capture never changes the state (R-19)", () => {
    expect(LifecycleState.options.some((s) => s.includes("sav"))).toBe(false);
    for (const context of contexts) {
      for (const event of ["capture_started", "capture_finished"] as const) {
        expect(step(context, event).context.state).toBe(context.state);
      }
    }
  });

  it("grants a start claim only where no host process can exist (G1BR-005)", () => {
    for (const context of contexts) {
      for (const inputs of subsets(GUARD_INPUTS)) {
        const { reply, context: next } = step(context, "claim_start", inputs);
        const status = typedStatus(context);
        if (reply?.kind === "claim" && reply.granted) {
          expect(["started_no_host", "start_claimed", "host_refused"]).toContain(status);
          expect(context.removalIntent).toBe(false);
          expect(next.claimed).toBe(true);
          expect(typedStatus(next)).toBe("start_claimed");
        } else if (reply?.kind === "claim") {
          // The refusal carries the status, which the wire allows only for refusals.
          expect(ClaimStartRefused.shape.status.safeParse(status).success, status).toBe(true);
        } else {
          expect(reply).toEqual({ kind: "error", code: "gone" });
          expect(context.removalIntent).toBe(true);
        }
      }
    }
  });

  it("enters host_running only through a current start or a confirmed restore holding one", () => {
    for (const context of contexts) {
      for (const event of LifecycleEvent.options) {
        for (const inputs of subsets(GUARD_INPUTS)) {
          const { context: next } = step(context, event, inputs);
          if (next.state === "host_running" && context.state !== "host_running") {
            const viaStart =
              event === "start_host" &&
              context.state === "start_claimed" &&
              inputs.has("attempt_current");
            const viaRestore =
              event === "restore_confirmed" &&
              context.state === "restoring" &&
              context.paramsStored;
            expect(viaStart || viaRestore, `${context.state} × ${event}`).toBe(true);
            expect(context.removalIntent).toBe(false);
          }
        }
      }
    }
  });

  it("never claims or re-arms a live incarnation", () => {
    for (const context of contexts.filter((c) => c.state === "host_running")) {
      expect(step(context, "claim_start").reply).not.toEqual({ kind: "claim", granted: true });
      expect(step(context, "start_host", new Set(["attempt_current"])).context.state).toBe(
        "host_running",
      );
    }
  });

  it("refuses every wake and start once a removal intent exists (FH-29)", () => {
    for (const context of contexts.filter((c) => c.removalIntent)) {
      for (const event of ["resume", "claim_start", "start_host", "checkpoint"] as const) {
        for (const inputs of subsets(GUARD_INPUTS)) {
          expect(step(context, event, inputs).reply, `${context.state} × ${event}`).toEqual({
            kind: "error",
            code: "gone",
          });
        }
      }
    }
  });

  it("refuses a sleep while saving, with the terminal open, or with runner processes", () => {
    for (const context of contexts.filter(
      (c) =>
        ["started_no_host", "start_claimed", "host_running", "host_refused"].includes(c.state) &&
        c.stopPrep === null,
    )) {
      const capturing = step(context, "capture_started").context;
      expect(step(capturing, "suspend").reply).toEqual({
        kind: "suspend_refused",
        reason: "capture_running",
      });
      if (!context.capturing) {
        expect(step(context, "suspend", new Set(["terminal_open"])).reply).toEqual({
          kind: "suspend_refused",
          reason: "terminal_open",
        });
        expect(step(context, "suspend", new Set(["runner_processes"])).reply).toEqual({
          kind: "suspend_refused",
          reason: "runner_processes",
        });
        const sleeping = step(context, "suspend");
        expect(sleeping.reply).toEqual({ kind: "suspend", outcome: "in_progress" });
        expect(sleeping.context.state).toBe(context.state);
        expect(typedStatus(sleeping.context)).toBe("stopping");
        // A failed preparation leaves the computer as it was (refused before any stop).
        expect(step(sleeping.context, "stop_preparation_failed").context).toEqual(context);
      }
    }
  });

  it("starts once after a stop when a resume came during it", () => {
    const running = run(["resume", "container_running", "restore_confirmed"]);
    const stopping = run(["suspend", "stop_prepared"], running);
    expect(stopping.state).toBe("stopping");
    const queued = step(stopping, "resume");
    expect(queued.reply).toEqual({ kind: "resume", outcome: "after_stop" });
    const after = step(queued.context, "container_stopped");
    expect(after.context.state).toBe("waking");
    expect(after.effects).toEqual([
      "confirm_stop",
      "release_reservation",
      "reserve",
      "start_container",
    ]);
    expect(step(queued.context, "container_stopped", new Set(["at_capacity"])).context.state).toBe(
      "asleep",
    );
  });

  it("retries a start refused right after a stop, under the same generation (DC-37)", () => {
    const waking = run(["resume"]);
    const retry = step(waking, "start_refused", new Set(["retries_left"]));
    expect(retry.context.state).toBe("waking");
    expect(retry.effects).toEqual(["retry_start"]);
    const failed = step(waking, "start_refused");
    expect(failed.context.state).toBe("failed");
    expect(failed.effects).toContain("fence_start");
    // A planned stop's later "not running" is no unexpected stop; a refused next start is a
    // start failure (FH-22).
    expect(failed.effects).not.toContain("record_unexpected_stop");
  });

  it("holds start_host's parameters until the restore is confirmed, then hands them over", () => {
    const restoring = run(["resume", "container_running", "claim_start"]);
    expect(typedStatus(restoring)).toBe("start_claimed");
    const stored = step(restoring, "start_host", new Set(["attempt_current"]));
    expect(stored.reply).toEqual({ kind: "start_host" });
    expect(stored.context.state).toBe("restoring");
    const restored = step(stored.context, "restore_confirmed");
    expect(restored.context.state).toBe("host_running");
    expect(restored.effects).toEqual(["deliver_params"]);
    // A repeated start for the same attempt, or one for an older attempt, is refused.
    expect(step(stored.context, "start_host", new Set(["attempt_current"])).reply).toEqual({
      kind: "error",
      code: "conflict",
    });
    expect(step(restoring, "start_host").reply).toEqual({ kind: "error", code: "conflict" });
  });

  it("parks a refused host until a new claim, and treats an unanswered hand-out as live", () => {
    const live = run(["resume", "container_running", "restore_confirmed", "claim_start"]);
    const running = step(live, "start_host", new Set(["attempt_current"])).context;
    expect(running.state).toBe("host_running");
    const refused = step(running, "host_refused_reported").context;
    expect(typedStatus(refused)).toBe("host_refused");
    expect(step(refused, "claim_start").reply).toEqual({ kind: "claim", granted: true });
    // The supervisor answered that it never took the attempt: no incarnation, claim again.
    expect(step(running, "start_not_taken").context.state).toBe("start_claimed");
  });

  it("removes only after the sign-out is settled, and keeps credentials until then", () => {
    const asleep = run([
      "resume",
      "container_running",
      "restore_confirmed",
      "suspend",
      "stop_prepared",
      "container_stopped",
    ]);
    expect(asleep.state).toBe("asleep");
    const pending = step(asleep, "terminate");
    expect(pending.reply).toEqual({ kind: "terminate", removal: "pending" });
    expect(pending.context.state).toBe("removal_pending");
    expect(step(pending.context, "removal_resolved").reply).toEqual({
      kind: "page_refused",
      reason: "unresolved",
    });
    // A sign-out run starts the computer without a host, then stops it again.
    const signOut = step(pending.context, "sign_out_run");
    expect(signOut.context.state).toBe("waking");
    const restored = run(["container_running", "restore_confirmed"], signOut.context);
    expect(restored.state).toBe("started_no_host");
    expect(step(restored, "claim_start").reply).toEqual({ kind: "error", code: "gone" });
    const stopping = run(["removal_stop_due", "stop_prepared"], restored);
    expect(step(stopping, "container_stopped").context.state).toBe("removal_pending");
    const resolved = step(pending.context, "removal_resolved", new Set(["sign_out_settled"]));
    expect(resolved.context.state).toBe("removed");
    expect(resolved.effects).toEqual(["delete_records"]);
    expect(step(resolved.context, "terminate").reply).toEqual({
      kind: "terminate",
      removal: "resolved",
    });
  });

  it("keeps its invariants under random event sequences (property)", () => {
    const event = fc.constantFrom(...LifecycleEvent.options);
    const inputs = fc.subarray([...GUARD_INPUTS]);
    fc.assert(
      fc.property(fc.array(fc.tuple(event, inputs), { maxLength: 60 }), (events) => {
        let context = INITIAL_CONTEXT;
        for (const [e, g] of events) {
          const { context: next, reply } = step(context, e, new Set(g));
          if (context.removalIntent) expect(next.removalIntent).toBe(true);
          if (context.state === "removed") expect(next.state).toBe("removed");
          if (next.claimed || next.paramsStored || next.capturing || next.stopPrep !== null) {
            expect([
              "provisioned",
              "asleep",
              "stopped",
              "failed",
              "removal_pending",
              "removed",
            ]).not.toContain(next.state);
          }
          if (next.paramsStored) expect(next.claimed).toBe(true);
          if (typedStatus(next) === "host_running") expect(next.state).toBe("host_running");
          if ((LAUNCHER_EVENTS as readonly string[]).includes(e)) expect(reply).toBeDefined();
          context = next;
        }
      }),
    );
  });
});

function run(events: readonly (typeof LifecycleEvent.options)[number][], from = INITIAL_CONTEXT) {
  return events.reduce((context, event) => step(context, event).context, from);
}

describe("sign-out verification", () => {
  it("is undone by any published login, and verified only after the tombstones", () => {
    expect(SIGN_OUT_TABLE.none.restore_verified).toBe("none");
    expect(SIGN_OUT_TABLE.requested.restore_verified).toBe("requested");
    expect(SIGN_OUT_TABLE.tombstoned.restore_verified).toBe("verified");
    for (const phase of ["none", "requested", "tombstoned", "verified"] as const) {
      expect(SIGN_OUT_TABLE[phase].login_published).toBe("none");
    }
  });

  it("never counts unknown or possibly lost logins as signed out", () => {
    const base = {
      phase: "verified" as const,
      neverHeldLogin: false,
      loginPossiblyLost: false,
      revocationRecorded: false,
    };
    expect(signOutSettled(base)).toBe(true);
    expect(signOutSettled({ ...base, phase: "tombstoned" })).toBe(false);
    expect(signOutSettled({ ...base, loginPossiblyLost: true })).toBe(false);
    expect(signOutSettled({ ...base, loginPossiblyLost: true, revocationRecorded: true })).toBe(
      true,
    );
    expect(signOutSettled({ ...base, phase: "none", neverHeldLogin: true })).toBe(true);
  });
});

describe("the setup cards", () => {
  const manifest = load("fixtures/CredentialManifest/claude-signed-in.json") as CredentialManifest;

  it("derives each provider's card on its own (UJ8)", () => {
    expect(
      deriveSetupCard({ provider: "claude", manifest, pending: false, cli: "signed_in" }),
    ).toEqual({
      provider: "claude",
      state: "signed_in",
    });
    expect(
      deriveSetupCard({ provider: "codex", manifest, pending: false, cli: "unknown" }),
    ).toEqual({
      provider: "codex",
      state: "needs_sign_in",
      reason: "not_signed_in",
    });
    expect(
      deriveSetupCard({ provider: "claude", manifest, pending: false, cli: "expired" }),
    ).toEqual({
      provider: "claude",
      state: "needs_sign_in",
      reason: "expired",
    });
    expect(
      deriveSetupCard({ provider: "claude", manifest, pending: false, cli: "signed_out" }).reason,
    ).toBe("refused");
    expect(
      deriveSetupCard({ provider: "claude", manifest, pending: true, cli: "signed_in" }).state,
    ).toBe("saving");
    expect(
      deriveSetupCard({ provider: "codex", manifest: null, pending: false, cli: "unknown" }).reason,
    ).toBe("not_signed_in");
  });

  it("shows unknown, never signed out, when the checkpoint cannot be read", () => {
    for (const cli of ["signed_in", "signed_out", "expired", "unknown"] as const) {
      expect(
        deriveSetupCard({ provider: "claude", manifest: undefined, pending: true, cli }).state,
      ).toBe("unknown");
    }
  });
});

describe("the computer API", () => {
  it("gives every message type an idempotency rule", () => {
    const types = [
      ...SupervisorMessage.options.map((o) => ("shape" in o ? o.shape.type.value : "")),
      ...WorkspaceCommand.options.flatMap((o) =>
        "shape" in o ? [o.shape.type.value] : o.options.map((inner) => inner.shape.type.value),
      ),
    ];
    expect(new Set(Object.keys(COMPUTER_API_MESSAGES))).toEqual(new Set(types));
  });
});

describe("the controllers' RPC", () => {
  it("tolerates unknown fields from a newer caller or receiver (R-26)", () => {
    const state = load("fixtures/PagesResult/state.json") as { computer: object };
    expect(ComputerPageState.safeParse({ ...state.computer, addedLater: 1 }).success).toBe(true);
    expect(
      PagesCall.safeParse({ action: "state", interfaceVersion: 1, addedLater: true }).success,
    ).toBe(true);
  });

  it("keeps the timing budget's constraints", () => {
    expect(TIMING.startRetryDelaysS.reduce((a, b) => a + b, 0)).toBeLessThan(TIMING.onlineWaitS);
    expect(TIMING.startDeadlineS).toBeGreaterThan(TIMING.onlineWaitS);
    expect(TIMING.backstopSaveS).not.toBe(600);
    expect(TIMING.tokenRefusedExitS).toBeGreaterThan(12 * 60);
    expect(TIMING.pauseTargetS).toBeLessThanOrEqual(TIMING.pauseHardBudgetS);
    expect(TIMING.pauseHardBudgetS + 30).toBeLessThan(90);
  });
});
