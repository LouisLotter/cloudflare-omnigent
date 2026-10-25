// Unit and property tests for WorkspaceDO's pure modules: sizing, reservations, the idle rules,
// checkpoints and the lifecycle wrapper.
import {
  type DirectoryBackupRecord,
  type GuardInput,
  INITIAL_CONTEXT,
  LIFECYCLE_TABLE,
  LifecycleEvent,
  type LifecycleState,
  MAX_DELTAS_PER_BASE,
  RESTORED_STATES,
  TIMING,
  type WorkspaceManifest,
  WorkspaceManifest as WorkspaceManifestSchema,
} from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bundleObject,
  credentialManifestOf,
  droppedLayers,
  holdsLogin,
  nextLayer,
  noDeclaredFile,
  notSavedDue,
  objectMatches,
  pauseLease,
  publish,
  restoreDirs,
  retryDelayMs,
  signOutEventOf,
  unchangedHolds,
  uncovered,
  unreferenced,
  unverifiedFor,
} from "../../src/computer/checkpoints.ts";
import {
  admissionOf,
  backstopDue,
  closeNotSaved,
  noContact,
  retriedNotSaved,
  sleepInputs,
} from "../../src/computer/idle.ts";
import { randomId } from "../../src/computer/ids.ts";
import {
  expectsContainer,
  guardInputs,
  INITIAL_LIFECYCLE,
  restored,
  statusOf,
  transition,
  withoutHost,
  wouldReserve,
} from "../../src/computer/machine.ts";
import {
  fence,
  mayStart,
  releasable,
  releasing,
  reservationState,
  reserved,
  running,
  starting,
} from "../../src/computer/reservations.ts";
import {
  chooseSize,
  clampSize,
  INITIAL_SIZE,
  sizeForStart,
  workspaceSizeWarning,
} from "../../src/computer/sizing.ts";

const CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
const D = (n: number) => n.toString(16).padStart(64, "0");

function backup(n: number, size = 1000): DirectoryBackupRecord {
  return {
    id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    dir: `/var/cfo/staged/lyr_${String(n).padStart(26, "0")}`,
    size,
    name: `lyr_${String(n).padStart(26, "0")}`,
    sha256: D(n),
    format: "tar+zstd/1",
  };
}

function manifest(
  deltas: number,
  opts: { baseBytes?: number; deltaBytes?: number } = {},
): WorkspaceManifest {
  const layers = Array.from({ length: deltas + 1 }, (_, i) => ({
    layerId: `lyr_${String(i).padStart(26, "0")}`,
    kind: i === 0 ? ("base" as const) : ("delta" as const),
    backup: backup(i),
    indexSha256: D(100 + i),
    treeDigest: D(200 + i),
    entries: 1,
    deleted: 0,
    bytes: i === 0 ? (opts.baseBytes ?? 1000) : (opts.deltaBytes ?? 10),
  }));
  return WorkspaceManifestSchema.parse({
    formatVersion: 1,
    checkpointId: `ckp_${String(deltas).padStart(26, "0")}`,
    computerId: CMP,
    generation: 1,
    policyVersion: 1,
    parentCheckpointId: null,
    cutAt: "2026-10-25T09:00:00.000Z",
    createdAt: "2026-10-25T09:00:01.000Z",
    roots: ["work"],
    layers,
    treeDigest: D(200 + deltas),
  });
}

describe("sizing", () => {
  it("starts at standard-2 and applies a chosen size only at the next start", () => {
    expect(INITIAL_SIZE).toEqual({ size: "standard-2", nextSize: null });
    const chosen = chooseSize(INITIAL_SIZE, "standard-4");
    expect(chosen).toEqual({ size: "standard-2", nextSize: "standard-4" });
    expect(chooseSize(chosen, "standard-2")).toEqual({ size: "standard-2", nextSize: null });
    expect(sizeForStart(chosen, null)).toEqual({
      instance: "standard-4",
      setting: { size: "standard-4", nextSize: null },
    });
  });

  it("caps a size at the installation's maximum, never below what was asked", () => {
    expect(clampSize("standard-4", "standard-1")).toBe("standard-1");
    expect(clampSize("basic", "standard-1")).toBe("basic");
    expect(clampSize("standard-3", null)).toBe("standard-3");
    expect(
      sizeForStart({ size: "standard-2", nextSize: "standard-4" }, "standard-3").instance,
    ).toBe("standard-3");
  });

  it("warns above 1.5 GB of declared directories (the size budget)", () => {
    expect(workspaceSizeWarning(null)).toBe(false);
    expect(workspaceSizeWarning(1_500_000_000)).toBe(false);
    expect(workspaceSizeWarning(1_500_000_001)).toBe(true);
  });
});

describe("reservations", () => {
  it("moves reserved → starting → running → releasing for one generation", () => {
    const r = reserved(3);
    expect(mayStart(r, 3)).toBe(true);
    expect(mayStart(r, 4)).toBe(false);
    expect(mayStart(null, 3)).toBe(false);
    const s = starting(r);
    expect(starting(s).phase).toBe("starting");
    const live = running(s);
    expect(mayStart(live, 3)).toBe(false);
    const rel = releasing(live);
    expect(releasable(rel, { containerRunning: false, stopConfirmed: true })).toBe(true);
    expect(releasable(rel, { containerRunning: true, stopConfirmed: true })).toBe(false);
    expect(releasable(rel, { containerRunning: false, stopConfirmed: false })).toBe(false);
    expect(releasable(live, { containerRunning: false, stopConfirmed: true })).toBe(false);
  });

  it("fences an abandoned start before its capacity can be released (FH-02, FH-03)", () => {
    expect(() => releasing(reserved(1))).toThrow();
    expect(() => releasing(starting(reserved(1)))).toThrow();
    const fenced = fence(starting(reserved(1)));
    expect(mayStart(fenced, 1)).toBe(false);
    expect(() => starting(fenced)).toThrow();
    expect(() => running(fenced)).toThrow();
    const rel = releasing(fenced);
    expect(releasable(rel, { containerRunning: false, stopConfirmed: false })).toBe(true);
    expect(releasable(rel, { containerRunning: true, stopConfirmed: false })).toBe(false);
  });

  it("reports the current generation's phase to ControlDO, and nothing for another", () => {
    const state = reservationState({
      computerId: CMP,
      generation: 2,
      reservation: fence(reserved(2)),
      containerRunning: false,
    });
    expect(state).toEqual({
      computerId: CMP,
      generation: 2,
      phase: "reserved",
      fenced: true,
      containerRunning: false,
    });
    expect(
      reservationState({
        computerId: CMP,
        generation: 3,
        reservation: reserved(2),
        containerRunning: null,
      }),
    ).toMatchObject({ phase: null, fenced: false, containerRunning: null });
  });
});

describe("the idle rules", () => {
  it("refuses a sleep with the terminal open or runner processes, and counts unknown runners as live", () => {
    expect(sleepInputs({ terminalOpen: false, runnerProcesses: 0 })).toEqual([]);
    expect(sleepInputs({ terminalOpen: true, runnerProcesses: 0 })).toEqual(["terminal_open"]);
    expect(sleepInputs({ terminalOpen: false, runnerProcesses: 2 })).toEqual(["runner_processes"]);
    expect(sleepInputs({ terminalOpen: false, runnerProcesses: null })).toEqual([
      "runner_processes",
    ]);
  });

  it("saves as a backstop after 15 minutes without a request, only while runners exist (R-21)", () => {
    const m = 60_000;
    expect(backstopDue({ runnerProcesses: 1, lastRequestAt: 0, now: 15 * m })).toBe(true);
    expect(backstopDue({ runnerProcesses: 1, lastRequestAt: 0, now: 15 * m - 1 })).toBe(false);
    expect(backstopDue({ runnerProcesses: 0, lastRequestAt: 0, now: 60 * m })).toBe(false);
    expect(backstopDue({ runnerProcesses: null, lastRequestAt: 0, now: 60 * m })).toBe(false);
    expect(TIMING.backstopSaveS).not.toBe(600);
  });

  it("closes admission as not saved and retries after 1, 2, then every 5 minutes", () => {
    const closed = closeNotSaved(1000);
    expect(closed).toEqual({ since: 1000, retries: 0, nextRetryAt: 61_000 });
    const second = retriedNotSaved(closed, 61_000);
    expect(second.nextRetryAt).toBe(61_000 + 120_000);
    const third = retriedNotSaved(second, 181_000);
    expect(third.nextRetryAt).toBe(181_000 + 300_000);
    expect(retriedNotSaved(third, 500_000).nextRetryAt).toBe(800_000);
    expect(admissionOf(null)).toEqual({ admitting: true });
    expect(admissionOf(closed)).toMatchObject({ admitting: false, reason: "not_saved" });
  });

  it("shows no contact after 60 minutes without a launcher call", () => {
    expect(noContact(null, 10 ** 9)).toBe(false);
    expect(noContact(0, 3_600_000)).toBe(true);
    expect(noContact(0, 3_599_999)).toBe(false);
  });
});

describe("checkpoints", () => {
  it("takes a new base with no parent, on a version change, after 20 deltas, or past half the base", () => {
    expect(nextLayer(null, 1)).toMatchObject({ kind: "base", reason: "no_parent" });
    expect(nextLayer({ ...manifest(1), policyVersion: 2 }, 1)).toMatchObject({
      reason: "policy_version",
    });
    expect(nextLayer({ ...manifest(1), formatVersion: 2 }, 1)).toMatchObject({
      reason: "format_version",
    });
    expect(nextLayer(manifest(MAX_DELTAS_PER_BASE), 1)).toMatchObject({ reason: "delta_count" });
    expect(nextLayer(manifest(MAX_DELTAS_PER_BASE - 1), 1)).toMatchObject({ kind: "delta" });
    expect(nextLayer(manifest(2, { baseBytes: 100, deltaBytes: 26 }), 1)).toMatchObject({
      reason: "delta_bytes",
    });
    expect(nextLayer(manifest(2, { baseBytes: 100, deltaBytes: 25 }), 1)).toEqual({
      kind: "delta",
      parent: { checkpointId: manifest(2).checkpointId, treeDigest: D(202) },
    });
  });

  it("never lets a manifest grow past a base and 20 deltas (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_DELTAS_PER_BASE }),
        fc.nat(10_000),
        (deltas, bytes) => {
          const plan = nextLayer(manifest(deltas, { deltaBytes: bytes }), 1);
          if (plan.kind === "delta") expect(deltas).toBeLessThan(MAX_DELTAS_PER_BASE);
        },
      ),
    );
  });

  it("publishes a delta only against the current pointer, and a base whatever it is", () => {
    const pointer = manifest(1);
    const staged = {
      layerDir: "/var/cfo/staged/x",
      indexSha256: D(9),
      treeDigest: D(10),
      entries: 1,
      deleted: 0,
      bytes: 5,
      cutAt: "2026-10-25T10:00:00.000Z",
    };
    const common = {
      staged,
      backup: backup(50),
      checkpointId: "ckp_0000000000000000000000new0" as const,
      computerId: CMP,
      generation: 2,
      policyVersion: 1,
      roots: ["work"],
      now: Date.parse("2026-10-25T10:00:05.000Z"),
    };
    const delta = { layerId: "lyr_0000000000000000000000new0", kind: "delta" as const };
    const ok = publish({
      ...common,
      pointer,
      plan: {
        ...delta,
        parent: { checkpointId: pointer.checkpointId, treeDigest: pointer.treeDigest },
      },
    });
    expect(ok.outcome).toBe("published");
    if (ok.outcome === "published") {
      expect(ok.manifest.layers).toHaveLength(3);
      expect(ok.manifest.parentCheckpointId).toBe(pointer.checkpointId);
      expect(ok.manifest.treeDigest).toBe(D(10));
    }
    expect(
      publish({
        ...common,
        pointer,
        plan: {
          ...delta,
          parent: {
            checkpointId: "ckp_0000000000000000000000old0",
            treeDigest: pointer.treeDigest,
          },
        },
      }),
    ).toEqual({ outcome: "discarded", reason: "parent_changed" });
    expect(
      publish({
        ...common,
        pointer: null,
        plan: {
          ...delta,
          parent: { checkpointId: pointer.checkpointId, treeDigest: pointer.treeDigest },
        },
      }),
    ).toEqual({ outcome: "discarded", reason: "parent_changed" });
    const base = publish({
      ...common,
      pointer,
      plan: {
        layerId: "lyr_0000000000000000000000new0",
        kind: "base",
        reason: "delta_count",
        parent: null,
      },
    });
    expect(base.outcome === "published" && base.manifest.layers.map((l) => l.kind)).toEqual([
      "base",
    ]);
    // A cut after the Worker's clock still gives a valid manifest (created at the cut).
    const skewed = publish({
      ...common,
      now: 0,
      pointer: null,
      plan: {
        layerId: "lyr_0000000000000000000000new0",
        kind: "base",
        reason: "no_parent",
        parent: null,
      },
    });
    expect(skewed.outcome).toBe("published");
    // A layer ID the contract refuses is never published.
    expect(
      publish({
        ...common,
        pointer: null,
        plan: { layerId: "bad", kind: "base", reason: "no_parent", parent: null },
      }),
    ).toEqual({
      outcome: "discarded",
      reason: "invalid",
    });
  });

  it("keeps a verified-unchanged outcome only for its generation and parent", () => {
    const pointer = manifest(0);
    const outcome = {
      generation: 2,
      parentCheckpointId: pointer.checkpointId,
      cutAt: "2026-10-25T10:00:00.000Z",
      at: 1,
    };
    expect(unchangedHolds(outcome, pointer, 2)).toBe(true);
    expect(unchangedHolds(outcome, pointer, 3)).toBe(false);
    expect(unchangedHolds(outcome, manifest(1), 2)).toBe(false);
    expect(unchangedHolds(outcome, null, 2)).toBe(false);
  });

  it("measures not saved from the last verification in the current generation (R-04)", () => {
    const v = { generation: 2, at: 1000, how: "restore" as const };
    expect(unverifiedFor(null, 2, 5000)).toBeNull();
    expect(unverifiedFor(v, 3, 5000)).toBeNull();
    expect(unverifiedFor(v, 2, 5000)).toBe(4000);
    expect(unverifiedFor(v, 2, 0)).toBe(0);
    expect(notSavedDue(v, 2, 1000 + 30 * 60_000)).toBe(false);
    expect(notSavedDue(v, 2, 1001 + 30 * 60_000)).toBe(true);
    expect(notSavedDue(v, 3, 10 ** 12)).toBe(false);
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(1)).toBe(120_000);
    expect(retryDelayMs(7)).toBe(300_000);
    expect(retryDelayMs(-1)).toBe(60_000);
    expect(retryDelayMs(3, [])).toBe(0);
  });

  it("covers only the requests a save began with (R-18)", () => {
    const pending = [
      { id: "a", reason: "turn_completed" as const, at: 1 },
      { id: "b", reason: "long_turn" as const, at: 2 },
    ];
    expect(uncovered(pending, ["a"])).toEqual([pending[1]]);
    expect(uncovered(pending, [])).toEqual(pending);
  });

  it("deletes a layer only when no retained checkpoint or restore point references it", () => {
    const pointer = manifest(2);
    const restorePoint = manifest(1);
    const candidates = [backup(0), backup(1), backup(2), backup(7), backup(7)];
    expect(unreferenced(candidates, [pointer, restorePoint]).map((b) => b.id)).toEqual([
      backup(7).id,
    ]);
    expect(unreferenced(candidates, []).map((b) => b.id)).toEqual(
      [0, 1, 2, 7].map((n) => backup(n).id),
    );
    expect(droppedLayers(pointer, manifest(0)).map((b) => b.id)).toEqual([
      backup(1).id,
      backup(2).id,
    ]);
    expect(droppedLayers(null, pointer)).toEqual([]);
    expect(droppedLayers(pointer, null)).toHaveLength(3);
  });

  it("restores each layer into its own directory, base first", () => {
    expect(restoreDirs(null)).toEqual([]);
    expect(restoreDirs(manifest(1))).toEqual([
      "/var/cfo/restore/lyr_00000000000000000000000000",
      "/var/cfo/restore/lyr_00000000000000000000000001",
    ]);
  });

  it("raises the pause target to the hard budget above about 2 GB (D25)", () => {
    expect(pauseLease(null)).toEqual({ targetMs: 20_000, hardMs: 40_000 });
    expect(pauseLease(2_000_000_000)).toEqual({ targetMs: 20_000, hardMs: 40_000 });
    expect(pauseLease(2_000_000_001)).toEqual({ targetMs: 40_000, hardMs: 40_000 });
  });

  it("records a credential bundle's files without their content, and checks it read back", async () => {
    const bundle = {
      formatVersion: 1,
      computerId: CMP,
      generation: 2,
      order: 3,
      files: {
        ".claude/.credentials.json": {
          state: "present" as const,
          mode: 0o600,
          copyOrder: 3,
          contentBase64: btoa("claude-canary"),
        },
        ".claude/.device-keys.json": { state: "tombstone" as const, copyOrder: 1 },
        ".codex/auth.json": { state: "tombstone" as const, copyOrder: 2 },
        ".codex/.credentials.json": { state: "tombstone" as const, copyOrder: 1 },
      },
    };
    const object = bundleObject(bundle);
    const m = await credentialManifestOf({
      bundle,
      checkpointId: "ckp_01hzy5b2c3d4e5f6g7h8j9k0m1",
      object,
      now: 0,
    });
    expect(m.object.key).toBe(`credentials/${CMP}/ckp_01hzy5b2c3d4e5f6g7h8j9k0m1.json`);
    expect(m.files[".claude/.credentials.json"]).toMatchObject({
      state: "present",
      size: 13,
      copyOrder: 3,
    });
    expect(JSON.stringify(m)).not.toContain("claude-canary");
    expect(await objectMatches(m, object)).toBe(true);
    expect(await objectMatches(m, new TextEncoder().encode("tampered"))).toBe(false);
    expect(holdsLogin(m.files)).toBe(true);
    expect(signOutEventOf(m.files)).toBe("login_published");
    expect(noDeclaredFile(m.files)).toBe(false);
    const out = {
      ...m.files,
      ".claude/.credentials.json": { state: "tombstone" as const, copyOrder: 4 },
    };
    expect(signOutEventOf(out)).toBe("tombstones_published");
    expect(noDeclaredFile(out)).toBe(true);
  });

  it("mints IDs the contract accepts", () => {
    expect(randomId("op")).toMatch(/^op_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(randomId("ckp")).toMatch(/^ckp_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(randomId("lyr")).toMatch(/^lyr_[0-9a-hjkmnp-tv-z]{26}$/);
  });
});

describe("the lifecycle wrapper (3.C's table)", () => {
  const events = LifecycleEvent.options;
  const inputs: GuardInput[] = [
    "at_capacity",
    "attempt_current",
    "terminal_open",
    "runner_processes",
    "retries_left",
    "sleeps_refused_thrice",
    "sign_out_settled",
  ];

  it("maps facts to the table's guard inputs", () => {
    expect([...guardInputs({})]).toEqual([]);
    expect([
      ...guardInputs({
        atCapacity: true,
        attemptCurrent: true,
        terminalOpen: true,
        runnerProcesses: true,
        retriesLeft: true,
        sleepsRefusedThrice: true,
        signOutSettled: true,
      }),
    ]).toEqual(inputs);
  });

  it("needs a newer generation for every reservation", () => {
    expect(wouldReserve(INITIAL_LIFECYCLE, "resume", new Set())).toBe(true);
    expect(wouldReserve(INITIAL_LIFECYCLE, "resume", new Set(["at_capacity"]))).toBe(true);
    expect(wouldReserve(INITIAL_LIFECYCLE, "claim_start", new Set())).toBe(false);
    expect(() => transition(INITIAL_LIFECYCLE, "resume", new Set())).toThrow();
    expect(() => transition(INITIAL_LIFECYCLE, "resume", new Set(), 0)).toThrow();
    const t = transition(INITIAL_LIFECYCLE, "resume", new Set(), 1);
    expect(t.lifecycle.generation).toBe(1);
    expect(t.lifecycle.context.state).toBe("waking");
    expect(transition(INITIAL_LIFECYCLE, "resume", new Set(["at_capacity"])).reply).toEqual({
      kind: "error",
      code: "at_capacity",
    });
  });

  it("classifies the states the controller acts on", () => {
    const states = Object.keys(LIFECYCLE_TABLE) as LifecycleState[];
    for (const state of states) {
      expect(restored(state)).toBe(RESTORED_STATES.includes(state));
      if (expectsContainer(state)) expect(["waking", "provisioned"]).not.toContain(state);
    }
    expect(withoutHost("host_running")).toBe(false);
    expect(withoutHost("waking")).toBe(true);
    expect(statusOf(INITIAL_LIFECYCLE)).toEqual({ status: "stopped", running: false });
  });

  it("keeps its bookkeeping under random event orders (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            event: fc.constantFrom(...events),
            inputs: fc.subarray(inputs),
          }),
          { maxLength: 80 },
        ),
        (sequence) => {
          let lifecycle = INITIAL_LIFECYCLE;
          for (const { event, inputs: chosen } of sequence) {
            const set = new Set(chosen);
            const reserve = wouldReserve(lifecycle, event, set);
            const t = transition(
              lifecycle,
              event,
              set,
              reserve ? lifecycle.generation + 1 : undefined,
            );
            // A generation changes only with a reservation, and only upwards.
            if (t.effects.includes("reserve"))
              expect(t.lifecycle.generation).toBe(lifecycle.generation + 1);
            else expect(t.lifecycle.generation).toBe(lifecycle.generation);
            // An attempt is recorded exactly when a claim is granted.
            const granted = t.reply?.kind === "claim" && t.reply.granted;
            expect(t.lifecycle.attempt).toBe(lifecycle.attempt + (granted ? 1 : 0));
            // The typed status is host_running only in host_running.
            const { status, running: live } = statusOf(t.lifecycle);
            if (status === "host_running") expect(t.lifecycle.context.state).toBe("host_running");
            if (live)
              expect([
                "waking",
                "provisioned",
                "asleep",
                "stopped",
                "failed",
                "removal_pending",
                "removed",
              ]).not.toContain(t.lifecycle.context.state);
            // A removal intent is permanent.
            if (lifecycle.context.removalIntent)
              expect(t.lifecycle.context.removalIntent).toBe(true);
            lifecycle = t.lifecycle;
          }
        },
      ),
      { numRuns: 300 },
    );
    expect(INITIAL_CONTEXT.state).toBe("provisioned");
  });
});

describe("WorkspaceDO's schema", () => {
  it("is one forward migration the runner accepts", async () => {
    const { WORKSPACE_MIGRATIONS } = await import("../../src/computer/schema.ts");
    const { planMigrations } = await import("../../src/shared/migrations.ts");
    expect(planMigrations(0, WORKSPACE_MIGRATIONS).map((m) => m.name)).toEqual(["workspace_kv"]);
    expect(planMigrations(1, WORKSPACE_MIGRATIONS)).toEqual([]);
  });
});

describe("the R2 adapter for credential bundles", () => {
  it("stores, reads back and deletes bytes, and reads a missing object as null", async () => {
    const { r2Bucket } = await import("../../src/computer/bucket.ts");
    const objects = new Map<string, Uint8Array>();
    const bucket = r2Bucket({
      put: async (key, body) => objects.set(key, body),
      get: async (key) => {
        const body = objects.get(key);
        return body === undefined ? null : { arrayBuffer: async () => body.slice().buffer };
      },
      delete: async (key) => {
        objects.delete(key);
      },
    });
    await bucket.put("credentials/a.json", new TextEncoder().encode("bundle"));
    expect(
      new TextDecoder().decode((await bucket.get("credentials/a.json")) ?? new Uint8Array()),
    ).toBe("bundle");
    await bucket.delete("credentials/a.json");
    expect(await bucket.get("credentials/a.json")).toBeNull();
  });
});
