// Pure: the platform's side of the two checkpoints (design, "Checkpoints"; 3.C's manifest
// formats, version 1).
//
// - Workspace checkpoints are layers, a base and the deltas since it. The new-base rule decides
//   the kind of the next layer; a delta is published only while the checkpoint it was computed
//   against is still the pointer; publication switches the pointer in one write, so a failed or
//   interrupted capture never changes it (FH-09, FH-10).
// - A capture that finds nothing changed publishes no layer but records a durable "verified
//   unchanged" outcome for the generation and the parent (R-04, ARR-008).
// - "Not saved" is measured from the last time the files were verified equal to a published
//   checkpoint in the current generation; once closed, saves are retried after 1, 2, then every
//   5 minutes.
// - Save requests are persisted and re-run until a published or verified-unchanged outcome covers
//   them (R-18).
// - Retention deletes a layer only when no retained checkpoint and no protected restore point
//   references it (RC-37).
// - Credential checkpoints are bundles of opaque bytes; their manifest keeps each file's state
//   without its content.
// - The capture's pause lease: a 20 s target and a 40 s hard budget, the target raised to the
//   hard budget above about 2 GB (D25).

import {
  type CheckpointId,
  type ComputerId,
  CREDENTIAL_FORMAT_VERSION,
  type CredentialBundle,
  type CredentialManifest,
  credentialObjectKey,
  DeclaredCredentialPath,
  type DirectoryBackupRecord,
  LOGIN_FILE,
  MAX_DELTAS_PER_BASE,
  NEW_BASE_DELTA_BYTES_RATIO,
  SIGN_OUT_TABLE,
  type SignOutEvent,
  type SignOutPhase,
  TIMING,
  WORKSPACE_FORMAT_VERSION,
  type WorkspaceLayer,
  WorkspaceManifest,
} from "@cfo/contracts";

// ---------------------------------------------------------------------------------------------
// Save requests (R-18).

/** Why a save was asked for: Omnigent's two reasons (core change 15), or WorkspaceDO's own. */
export type SaveReason = "turn_completed" | "long_turn" | "backstop" | "retry" | "sigterm";

export interface SaveRequest {
  /** The launcher's operation ID, or one WorkspaceDO minted. */
  readonly id: string;
  readonly reason: SaveReason;
  /** When it was accepted (ms). */
  readonly at: number;
}

/** The requests a finished save leaves pending: those it did not cover. */
export function uncovered(
  pending: readonly SaveRequest[],
  covered: readonly string[],
): readonly SaveRequest[] {
  const done = new Set(covered);
  return pending.filter((request) => !done.has(request.id));
}

// ---------------------------------------------------------------------------------------------
// The new-base rule (AR-25).

export type BaseReason =
  | "no_parent"
  | "format_version"
  | "policy_version"
  | "delta_count"
  | "delta_bytes";

export interface Parent {
  readonly checkpointId: CheckpointId;
  readonly treeDigest: string;
}

export type LayerPlan =
  | { readonly kind: "base"; readonly reason: BaseReason; readonly parent: null }
  | { readonly kind: "delta"; readonly parent: Parent };

/**
 * The kind of the next layer. A new base when no valid parent exists, when the format or policy
 * version changed, after `MAX_DELTAS_PER_BASE` deltas, or when the deltas since the base add up to
 * more than half its size; otherwise a delta against the pointer.
 */
export function nextLayer(pointer: WorkspaceManifest | null, policyVersion: number): LayerPlan {
  if (pointer === null) return { kind: "base", reason: "no_parent", parent: null };
  if (pointer.formatVersion !== WORKSPACE_FORMAT_VERSION) {
    return { kind: "base", reason: "format_version", parent: null };
  }
  if (pointer.policyVersion !== policyVersion) {
    return { kind: "base", reason: "policy_version", parent: null };
  }
  const [base, ...deltas] = pointer.layers;
  if (deltas.length >= MAX_DELTAS_PER_BASE) {
    return { kind: "base", reason: "delta_count", parent: null };
  }
  const deltaBytes = deltas.reduce((sum, layer) => sum + layer.bytes, 0);
  if (deltaBytes > NEW_BASE_DELTA_BYTES_RATIO * base.bytes) {
    return { kind: "base", reason: "delta_bytes", parent: null };
  }
  return {
    kind: "delta",
    parent: { checkpointId: pointer.checkpointId, treeDigest: pointer.treeDigest },
  };
}

// ---------------------------------------------------------------------------------------------
// The pause lease (D7, R-14, D25).

/** Above this many bytes of declared directories the target is the hard budget (D25). */
export const LARGE_WORKSPACE_BYTES = TIMING.largeWorkspaceBytes;

export function pauseLease(workspaceBytes: number | null): {
  readonly targetMs: number;
  readonly hardMs: number;
} {
  const hardMs = TIMING.pauseHardBudgetS * 1000;
  const large = workspaceBytes !== null && workspaceBytes > LARGE_WORKSPACE_BYTES;
  return { targetMs: large ? hardMs : TIMING.pauseTargetS * 1000, hardMs };
}

// ---------------------------------------------------------------------------------------------
// Publication.

/** What the supervisor staged for one capture (`CaptureJob`, state `staged`). */
export interface StagedLayer {
  readonly layerDir: string;
  readonly indexSha256: string;
  readonly treeDigest: string;
  readonly entries: number;
  readonly deleted: number;
  readonly bytes: number;
  readonly cutAt: string;
}

export interface Publication {
  readonly pointer: WorkspaceManifest | null;
  readonly plan: { readonly layerId: string } & LayerPlan;
  readonly staged: StagedLayer;
  readonly backup: DirectoryBackupRecord;
  readonly checkpointId: CheckpointId;
  readonly computerId: ComputerId;
  readonly generation: number;
  readonly policyVersion: number;
  readonly roots: readonly string[];
  /** Now (ms). */
  readonly now: number;
}

export type PublishOutcome =
  | { readonly outcome: "published"; readonly manifest: WorkspaceManifest }
  | { readonly outcome: "discarded"; readonly reason: "parent_changed" | "invalid" };

/**
 * The manifest a finished upload would publish, or why it is discarded. A delta is published only
 * while its parent is still the pointer: otherwise the next save starts afresh. The new manifest
 * is checked against the contract before it can become the pointer.
 */
export function publish(input: Publication): PublishOutcome {
  const { pointer, plan, staged } = input;
  if (
    plan.kind === "delta" &&
    (pointer === null ||
      pointer.checkpointId !== plan.parent.checkpointId ||
      pointer.treeDigest !== plan.parent.treeDigest)
  ) {
    return { outcome: "discarded", reason: "parent_changed" };
  }
  const layer: WorkspaceLayer = {
    layerId: plan.layerId,
    kind: plan.kind,
    backup: input.backup,
    indexSha256: staged.indexSha256,
    treeDigest: staged.treeDigest,
    entries: staged.entries,
    deleted: staged.deleted,
    bytes: staged.bytes,
  };
  const cut = Date.parse(staged.cutAt);
  const created = new Date(Math.max(input.now, Number.isNaN(cut) ? input.now : cut)).toISOString();
  const parsed = WorkspaceManifest.safeParse({
    formatVersion: WORKSPACE_FORMAT_VERSION,
    checkpointId: input.checkpointId,
    computerId: input.computerId,
    generation: input.generation,
    policyVersion: input.policyVersion,
    parentCheckpointId: pointer?.checkpointId ?? null,
    cutAt: staged.cutAt,
    createdAt: created,
    roots: input.roots,
    layers: plan.kind === "base" || pointer === null ? [layer] : [...pointer.layers, layer],
    treeDigest: staged.treeDigest,
  });
  if (!parsed.success) return { outcome: "discarded", reason: "invalid" };
  return { outcome: "published", manifest: parsed.data };
}

/**
 * A capture that found nothing changed since its parent (R-04): no layer, but a durable outcome
 * tied to the generation and the parent checkpoint.
 */
export interface UnchangedOutcome {
  readonly generation: number;
  readonly parentCheckpointId: CheckpointId;
  readonly cutAt: string;
  readonly at: number;
}

/** Whether an unchanged outcome still verifies the files against the pointer. */
export function unchangedHolds(
  outcome: UnchangedOutcome,
  pointer: WorkspaceManifest | null,
  generation: number,
): boolean {
  return (
    outcome.generation === generation &&
    pointer !== null &&
    pointer.checkpointId === outcome.parentCheckpointId
  );
}

// ---------------------------------------------------------------------------------------------
// The "not saved" measure (R-04, ARR-008).

/**
 * The last time the files were verified equal to a published checkpoint: a confirmed restore, a
 * published save or a verified-unchanged capture. Only one in the current generation counts.
 */
export interface Verified {
  readonly generation: number;
  readonly at: number;
  readonly how: "restore" | "published" | "unchanged";
}

/** Milliseconds since the files were last verified in `generation`; null if never in it. */
export function unverifiedFor(
  verified: Verified | null,
  generation: number,
  now: number,
): number | null {
  if (verified === null || verified.generation !== generation) return null;
  return Math.max(0, now - verified.at);
}

/** Whether "not saved" should close admission now (more than 30 minutes unverified). */
export function notSavedDue(
  verified: Verified | null,
  generation: number,
  now: number,
  thresholdMs: number = TIMING.notSavedS * 1000,
): boolean {
  const age = unverifiedFor(verified, generation, now);
  return age !== null && age > thresholdMs;
}

/** The delay before retry number `retries` (0-based): 1, 2, then every 5 minutes. */
export function retryDelayMs(
  retries: number,
  scheduleMs: readonly number[] = TIMING.notSavedRetryS.map((s) => s * 1000),
): number {
  const last = scheduleMs[scheduleMs.length - 1] ?? 0;
  return scheduleMs[Math.max(0, retries)] ?? last;
}

// ---------------------------------------------------------------------------------------------
// Retention by reference (RC-37).

/** Every layer a set of retained checkpoints and restore points references, by backup ID. */
export function referencedBackups(manifests: readonly WorkspaceManifest[]): ReadonlySet<string> {
  return new Set(manifests.flatMap((m) => m.layers.map((layer) => layer.backup.id)));
}

/** The candidates no retained checkpoint or restore point references: safe to delete. */
export function unreferenced(
  candidates: readonly DirectoryBackupRecord[],
  retained: readonly WorkspaceManifest[],
): readonly DirectoryBackupRecord[] {
  const keep = referencedBackups(retained);
  const seen = new Set<string>();
  return candidates.filter((record) => {
    if (keep.has(record.id) || seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

/** The layers of `before` that `after` no longer holds (a new base replaces the chain). */
export function droppedLayers(
  before: WorkspaceManifest | null,
  after: WorkspaceManifest | null,
): readonly DirectoryBackupRecord[] {
  if (before === null) return [];
  const kept = new Set(after?.layers.map((layer) => layer.backup.id) ?? []);
  return before.layers.filter((layer) => !kept.has(layer.backup.id)).map((layer) => layer.backup);
}

// ---------------------------------------------------------------------------------------------
// Restore.

/** Where each layer is restored before the supervisor merges them (3.C's fixtures). */
export const RESTORE_ROOT = "/var/cfo/restore";

/** One restored directory per layer, in the manifest's order: base first. */
export function restoreDirs(manifest: WorkspaceManifest | null): readonly string[] {
  return manifest?.layers.map((layer) => `${RESTORE_ROOT}/${layer.layerId}`) ?? [];
}

// ---------------------------------------------------------------------------------------------
// Credential checkpoints.

function bytesOf(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The object a credential bundle is stored as: its JSON, exactly as stored and read back. */
export function bundleObject(bundle: CredentialBundle): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(bundle));
}

/**
 * The pointer's record of a published bundle: the object and, per declared file, its state
 * without its content. Platform code never parses the files themselves.
 */
export async function credentialManifestOf(input: {
  readonly bundle: CredentialBundle;
  readonly checkpointId: CheckpointId;
  readonly object: Uint8Array;
  readonly now: number;
}): Promise<CredentialManifest> {
  const { bundle } = input;
  const files = {} as Record<
    DeclaredCredentialPath,
    CredentialManifest["files"][DeclaredCredentialPath]
  >;
  for (const path of DeclaredCredentialPath.options) {
    const file = bundle.files[path];
    if (file.state === "tombstone") {
      files[path] = { state: "tombstone", copyOrder: file.copyOrder };
    } else {
      const content = bytesOf(file.contentBase64);
      files[path] = {
        state: "present",
        size: content.byteLength,
        sha256: await sha256Hex(content),
        copyOrder: file.copyOrder,
      };
    }
  }
  return {
    formatVersion: CREDENTIAL_FORMAT_VERSION,
    checkpointId: input.checkpointId,
    computerId: bundle.computerId,
    generation: bundle.generation,
    order: bundle.order,
    createdAt: new Date(input.now).toISOString(),
    object: {
      key: credentialObjectKey(bundle.computerId, input.checkpointId),
      size: input.object.byteLength,
      sha256: await sha256Hex(input.object),
    },
    files,
  };
}

/** Whether the bytes read back are the object the manifest names. */
export async function objectMatches(
  manifest: CredentialManifest,
  object: Uint8Array,
): Promise<boolean> {
  return (
    object.byteLength === manifest.object.size &&
    (await sha256Hex(object)) === manifest.object.sha256
  );
}

type FileStates = Readonly<Record<DeclaredCredentialPath, { readonly state: string }>>;

/** Whether either provider's login file is present. */
export function holdsLogin(files: FileStates): boolean {
  return Object.values(LOGIN_FILE).some((path) => files[path].state === "present");
}

/** Whether no declared file is present: a restore would install none (sign-out verification). */
export function noDeclaredFile(files: FileStates): boolean {
  return DeclaredCredentialPath.options.every((path) => files[path].state === "tombstone");
}

/**
 * The sign-out event a published bundle means: a login present undoes any sign-out; otherwise
 * both providers' login files are tombstoned.
 */
export function signOutEventOf(files: FileStates): SignOutEvent {
  return holdsLogin(files) ? "login_published" : "tombstones_published";
}

/**
 * Whether a bundle was published while a sign-out run's logouts and snapshot are still under
 * way: in the run's generation, before its snapshot's order is known, or below it. Such a bundle
 * is an in-between state, never a sign-out undone: the CLIs log out one after the other, and the
 * supervisor's credential watcher publishes between them (Claude's login tombstoned, Codex's still
 * present), which on 28 Oct left the phase `none` after a sign-out that tombstoned everything. The
 * run's snapshot decides instead (`signOutDecided`).
 */
export function midSignOut(
  job: { readonly generation: number; readonly order: number | null } | null,
  bundle: { readonly generation: number; readonly order: number },
): boolean {
  return (
    job !== null &&
    job.generation === bundle.generation &&
    (job.order === null || bundle.order < job.order)
  );
}

/** The sign-out phase once a bundle is published: as the table says, except mid-run (above). */
export function signOutOnPublish(
  phase: SignOutPhase,
  files: FileStates,
  midRun: boolean,
): SignOutPhase {
  const event = signOutEventOf(files);
  return midRun && event === "login_published" ? phase : SIGN_OUT_TABLE[phase][event];
}

/**
 * The phase a sign-out run settles on once its snapshot (or anything newer) is the published
 * pointer: tombstones advance it, a login undoes it (a logout that failed, or a login written
 * meanwhile).
 */
export function signOutDecided(phase: SignOutPhase, pointer: FileStates | null): SignOutPhase {
  return pointer === null ? phase : SIGN_OUT_TABLE[phase][signOutEventOf(pointer)];
}

/**
 * The phase when a sign-out run ends any other way (given up, its container gone): a login it set
 * aside while its logouts ran counts now. A run still `requested` stays so: asked for, not
 * confirmed, which the page offers to run again.
 */
export function signOutAbandoned(phase: SignOutPhase, pointer: FileStates | null): SignOutPhase {
  return phase !== "requested" && pointer !== null && holdsLogin(pointer)
    ? SIGN_OUT_TABLE[phase].login_published
    : phase;
}
