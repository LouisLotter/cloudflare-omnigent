/**
 * A fake of the computer's supervisor (WP3.4) as WorkspaceDO sees it through the container port:
 * the command API on port 8090 and the messages it sends to WorkspaceDO. It keeps a simulated
 * workspace tree, the kept snapshot's index, staged layers, credentials with copy orders, the
 * host's start attempts and runner processes, and answers every command by the computer API's
 * rules (3.C): idempotent by operation ID or attempt, refusing another generation's commands.
 *
 * With `SimulatedBucket` (below) it also models the workspace layers' bytes in R2, so a test can
 * check that every restore reproduces the published checkpoint's tree exactly.
 */
import {
  type ComputerId,
  type CredentialBundle,
  DeclaredCredentialPath,
  type DirectoryBackupRecord,
  type IndexEntry,
  type SupervisorMessage,
  type SupervisorReply,
  type SupervisorReport,
  treeDigest,
  WorkspaceCommand,
  type WorkspaceCommandReply,
} from "@cfo/contracts";
import {
  type BackupOptions,
  NO_INSTANCE_MESSAGE,
  type RestoreOptions,
} from "../../src/shared/computer-port.ts";
import { FakeComputerContainer } from "./fake-computer-container.ts";

export type Tree = ReadonlyMap<string, string>;

/** The bytes of each uploaded layer: what R2 holds for the computer's workspace prefix. */
export interface LayerContent {
  readonly kind: "base" | "delta";
  readonly files: Tree;
  readonly deleted: readonly string[];
}

function sha(text: string): string {
  // A stable stand-in for SHA-256 (the fake never needs a real one): FNV-1a, widened to 64 hex.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(8);
}

export function indexOf(tree: Tree): IndexEntry[] {
  return [...tree].map(([path, content]) => ({
    path,
    type: "file" as const,
    mode: 0o644,
    uid: 1000,
    gid: 1000,
    size: content.length,
    sha256: sha(content),
  }));
}

export async function digestOf(tree: Tree): Promise<string> {
  return treeDigest(indexOf(tree));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function refuse(code: string, message: string, status = 409): Response {
  return json({ error: { code, message, retryable: false } }, status);
}

const LOGIN_FILES = { claude: ".claude/.credentials.json", codex: ".codex/auth.json" } as const;

export interface SupervisorOptions {
  /** Polls a restore takes before it is done. */
  restorePolls: number;
  /** Polls a capture takes before it is staged. */
  capturePolls: number;
  /** The next captures fail (the lease expired, say). */
  failCaptures: number;
  /** The next restores fail. */
  failRestores: number;
  /** `credential_snapshot` replies, but the bundle is never sent (publication blocked). */
  holdCredentials: boolean;
  /** Decline the next `start_host` (as if its own restore were not done). */
  declineStarts: number;
}

/**
 * One container's supervisor. A new instance per container start: the tree, snapshot and staged
 * layers live on the container's disk and are lost when it stops.
 */
export class FakeSupervisor {
  readonly computerId: ComputerId;
  readonly generation: number;
  readonly options: SupervisorOptions;
  /** Commands received, in order (bodies with tokens redacted). */
  readonly commands: WorkspaceCommand[] = [];
  /** Every command body as received, for the actual Python receiver's check. */
  readonly raw: unknown[] = [];
  tree = new Map<string, string>();
  /** The kept snapshot's tree: the parent of the next delta. */
  kept: Map<string, string> | null = null;
  keptDigest: string | null = null;
  runnerProcesses = 0;
  host: { state: SupervisorReport["host"]["state"]; attempt: number | null; restarts: number } = {
    state: "not_started",
    attempt: null,
    restarts: 0,
  };
  /** The token of the attempt taken: kept in memory only, as the real supervisor does. */
  token: string | null = null;
  credentials = new Map<string, string>();
  restored = false;
  /** Messages to WorkspaceDO not yet acknowledged (retried until they are). */
  readonly outbox: SupervisorMessage[] = [];
  readonly sent: SupervisorMessage[] = [];
  /** Layers restored into their directories, by directory. */
  readonly restoredDirs = new Map<string, LayerContent>();
  readonly #staged = new Map<string, { layerDir: string; content: LayerContent; tree: Tree }>();
  readonly #jobs = new Map<string, { reply: WorkspaceCommandReply; polls: number }>();
  readonly #attempts = { taken: 0, declined: 0 };
  #seq = 0;
  #order = 0;
  #fileOrder = new Map<string, number>();
  #copied = new Map<string, string | null>();
  /** The declared files as of the last acknowledged credential checkpoint (or the install). */
  #acknowledged = new Map<string, string | null>();
  #signedOut = false;
  readonly #ops = new Map<string, WorkspaceCommandReply>();

  constructor(
    computerId: ComputerId,
    generation: number,
    options: Partial<SupervisorOptions> = {},
  ) {
    this.computerId = computerId;
    this.generation = generation;
    this.options = {
      restorePolls: 0,
      capturePolls: 0,
      failCaptures: 0,
      failRestores: 0,
      holdCredentials: false,
      declineStarts: 0,
      ...options,
    };
  }

  #envelope() {
    return {
      protocolVersion: 1,
      computerId: this.computerId,
      generation: this.generation,
      operationId: `op_${(++this.#seq).toString(32).padStart(26, "0")}`,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Things that happen on the computer.

  /** A file written by the agent or a CLI. */
  write(path: string, content: string): void {
    this.tree.set(path, content);
  }

  remove(path: string): void {
    this.tree.delete(path);
  }

  /** A CLI signs in: its login file changes, and the watcher publishes a credential checkpoint. */
  signIn(provider: "claude" | "codex", content = `${provider}-login-canary-${this.#seq}`): void {
    this.credentials.set(LOGIN_FILES[provider], content);
    this.#publishCredentials();
  }

  /** A login refresh, changed but not yet published (the watcher has not settled). */
  refreshUnpublished(provider: "claude" | "codex"): void {
    this.credentials.set(LOGIN_FILES[provider], `${provider}-refreshed-${this.#seq}`);
  }

  /** The host exits with "token refused" and is parked (core change 13). */
  refuseHost(): void {
    this.host = { ...this.host, state: "refused" };
    this.report();
  }

  /** The supervisor's state, as a report and `status` carry it. */
  state(): SupervisorReport {
    const pending = DeclaredCredentialPath.options.filter(
      (path) => (this.credentials.get(path) ?? null) !== (this.#acknowledged.get(path) ?? null),
    );
    return {
      seq: ++this.#seq,
      host: {
        state: this.host.state,
        startAttempt: this.host.attempt,
        restarts: this.host.restarts,
      },
      runnerProcesses: this.runnerProcesses,
      restore: this.restored ? "confirmed" : "pending",
      capture: "idle",
      credentialsPending: pending,
      logins: {
        claude: this.credentials.has(LOGIN_FILES.claude) ? "signed_in" : "signed_out",
        codex: this.credentials.has(LOGIN_FILES.codex) ? "signed_in" : "signed_out",
      },
    };
  }

  /** The supervisor's periodic report. */
  report(): SupervisorMessage {
    const message: SupervisorMessage = {
      type: "report",
      ...this.#envelope(),
      report: this.state(),
    };
    this.outbox.push(message);
    return message;
  }

  hello(): void {
    this.outbox.push({ type: "hello", ...this.#envelope(), supervisorVersion: "fake-1" });
  }

  /** Takes a whole credential snapshot under the copy lock and queues its bundle. */
  #snapshot(): CredentialBundle {
    this.#order += 1;
    for (const path of DeclaredCredentialPath.options) {
      const now = this.credentials.get(path) ?? null;
      const copied = this.#copied.has(path) ? (this.#copied.get(path) ?? null) : undefined;
      if (copied === undefined || copied !== now) {
        this.#fileOrder.set(path, this.#order);
        this.#copied.set(path, now);
      }
    }
    const files = Object.fromEntries(
      DeclaredCredentialPath.options.map((path) => {
        const copyOrder = this.#fileOrder.get(path) ?? this.#order;
        const content = this.#copied.get(path) ?? null;
        return [
          path,
          content === null
            ? { state: "tombstone" as const, copyOrder }
            : { state: "present" as const, mode: 0o600, copyOrder, contentBase64: btoa(content) },
        ];
      }),
    ) as CredentialBundle["files"];
    const order = Math.max(...Object.values(files).map((f) => f.copyOrder));
    return {
      formatVersion: 1,
      computerId: this.computerId,
      generation: this.generation,
      order,
      files,
    };
  }

  #publishCredentials(): number {
    const bundle = this.#snapshot();
    if (!this.options.holdCredentials) {
      this.outbox.push({ type: "credential_checkpoint", ...this.#envelope(), bundle });
    }
    return bundle.order;
  }

  /** A SIGTERM: a best-effort save request. */
  sigterm(): void {
    this.outbox.push({ type: "save_request", ...this.#envelope(), reason: "sigterm" });
  }

  /**
   * Sends queued messages, in order, until one is not acknowledged (it stays queued, R-18).
   * `deliver` is the computer API route into WorkspaceDO.
   */
  async flush(deliver: (message: SupervisorMessage) => Promise<SupervisorReply>): Promise<void> {
    while (this.outbox.length > 0) {
      const message = this.outbox[0] as SupervisorMessage;
      try {
        await deliver(message);
      } catch {
        return;
      }
      this.sent.push(message);
      this.outbox.shift();
      if (message.type === "credential_checkpoint") {
        for (const path of DeclaredCredentialPath.options) {
          const file = message.bundle.files[path];
          this.#acknowledged.set(path, file.state === "present" ? atob(file.contentBase64) : null);
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The command API.

  async handle(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse("bad_request", "not JSON", 400);
    }
    this.raw.push(body);
    const parsed = WorkspaceCommand.safeParse(body);
    if (!parsed.success) return refuse("bad_request", "not a WorkspaceCommand", 400);
    const command = parsed.data;
    this.commands.push(
      command.type === "start_host"
        ? { ...command, token: "redacted-token-000000000000000000000" }
        : command,
    );
    if (command.computerId !== this.computerId || command.generation !== this.generation) {
      return refuse("stale_generation", "another computer or generation");
    }
    const recorded = this.#ops.get(command.operationId);
    if (recorded !== undefined && command.type !== "job_status" && command.type !== "status") {
      return json(recorded);
    }
    const reply = await this.#answer(command);
    if (
      command.type !== "job_status" &&
      command.type !== "status" &&
      command.type !== "capture" &&
      command.type !== "restore_workspace"
    ) {
      this.#ops.set(command.operationId, reply);
    }
    return json(reply);
  }

  async #answer(command: WorkspaceCommand): Promise<WorkspaceCommandReply> {
    switch (command.type) {
      case "install_credentials": {
        const installed: (typeof DeclaredCredentialPath.options)[number][] = [];
        const removed: (typeof DeclaredCredentialPath.options)[number][] = [];
        for (const path of DeclaredCredentialPath.options) {
          const file = command.bundle?.files[path];
          if (file?.state === "present") {
            this.credentials.set(path, atob(file.contentBase64));
            installed.push(path);
          } else if (file?.state === "tombstone") {
            this.credentials.delete(path);
            removed.push(path);
          }
        }
        const orderFloor = this.#order;
        for (const path of DeclaredCredentialPath.options) {
          this.#acknowledged.set(path, this.credentials.get(path) ?? null);
        }
        this.restored = true;
        return { type: "install_credentials", installed, removed, orderFloor };
      }
      case "restore_workspace": {
        const existing = this.#jobs.get(command.operationId);
        if (existing !== undefined) return this.#poll(command.operationId);
        let reply: WorkspaceCommandReply;
        if (this.options.failRestores > 0) {
          this.options.failRestores -= 1;
          reply = {
            type: "restore_workspace",
            job: {
              kind: "restore",
              jobOperationId: command.operationId,
              state: "failed",
              reason: "layer_corrupt",
            },
          };
        } else {
          const merged = new Map<string, string>();
          let missing = false;
          for (const dir of command.layerDirs) {
            const layer = this.restoredDirs.get(dir);
            if (layer === undefined) {
              missing = true;
              break;
            }
            if (layer.kind === "base") merged.clear();
            for (const path of layer.deleted) {
              for (const key of [...merged.keys()]) {
                if (key === path || key.startsWith(`${path}/`)) merged.delete(key);
              }
            }
            for (const [path, content] of layer.files) merged.set(path, content);
          }
          if (missing) {
            reply = {
              type: "restore_workspace",
              job: {
                kind: "restore",
                jobOperationId: command.operationId,
                state: "failed",
                reason: "layer_missing",
              },
            };
          } else {
            const digest = command.manifest === null ? null : await digestOf(merged);
            this.tree = new Map(merged);
            this.kept = new Map(merged);
            this.keptDigest = digest;
            reply = {
              type: "restore_workspace",
              job: {
                kind: "restore",
                jobOperationId: command.operationId,
                state: "done",
                treeDigest: digest,
                entries: merged.size,
                stripped: 0,
              },
            };
          }
        }
        this.#jobs.set(command.operationId, { reply, polls: this.options.restorePolls });
        return this.#poll(command.operationId);
      }
      case "start_host": {
        const attempt = command.startAttempt;
        if (attempt === this.#attempts.taken) return { type: "start_host", outcome: "taken" };
        if (attempt <= Math.max(this.#attempts.taken, this.#attempts.declined)) {
          return { type: "start_host", outcome: "superseded" };
        }
        if (this.#attempts.taken > 0 && this.host.state !== "refused") {
          return { type: "start_host", outcome: "refused_live_host" };
        }
        if (!this.restored || this.options.declineStarts > 0) {
          if (this.options.declineStarts > 0) this.options.declineStarts -= 1;
          this.#attempts.declined = attempt;
          return { type: "start_host", outcome: "declined" };
        }
        this.#attempts.taken = attempt;
        this.token = command.token;
        this.host = { state: "running", attempt, restarts: 0 };
        return { type: "start_host", outcome: "taken" };
      }
      case "capture": {
        if (this.#jobs.has(command.operationId))
          return {
            type: "capture",
            job: this.#poll(command.operationId).job,
          } as WorkspaceCommandReply;
        let job: Extract<WorkspaceCommandReply, { type: "capture" }>["job"];
        const cutAt = new Date(Date.UTC(2026, 9, 25, 12, 0, this.#seq % 60)).toISOString();
        if (this.options.failCaptures > 0) {
          this.options.failCaptures -= 1;
          job = {
            kind: "capture",
            jobOperationId: command.operationId,
            state: "failed",
            reason: "lease_expired",
            pausedMs: 40_000,
          };
        } else if (command.kind === "delta" && command.parent.treeDigest !== this.keptDigest) {
          job = {
            kind: "capture",
            jobOperationId: command.operationId,
            state: "failed",
            reason: "parent_mismatch",
            pausedMs: 0,
          };
        } else {
          const tree = new Map(this.tree);
          const parent =
            command.kind === "delta" ? (this.kept ?? new Map()) : new Map<string, string>();
          const files = new Map(
            [...tree].filter(([path, content]) => parent.get(path) !== content),
          );
          const deleted =
            command.kind === "delta" ? [...parent.keys()].filter((path) => !tree.has(path)) : [];
          if (command.kind === "delta" && files.size === 0 && deleted.length === 0) {
            job = {
              kind: "capture",
              jobOperationId: command.operationId,
              state: "unchanged",
              cutAt,
              pausedMs: 700,
            };
          } else {
            const layerDir = `/var/cfo/staged/${command.layerId}`;
            this.#staged.set(command.operationId, {
              layerDir,
              content: { kind: command.kind, files, deleted },
              tree,
            });
            const bytes = [...files.values()].reduce((sum, content) => sum + content.length, 0);
            job = {
              kind: "capture",
              jobOperationId: command.operationId,
              state: "staged",
              layerDir,
              indexSha256: sha(command.layerId),
              treeDigest: await digestOf(tree),
              entries: files.size,
              deleted: deleted.length,
              bytes,
              cutAt,
              pausedMs: 700,
            };
          }
        }
        const reply = { type: "capture" as const, job };
        this.#jobs.set(command.operationId, {
          reply,
          polls: job.state === "failed" ? 0 : this.options.capturePolls,
        });
        return {
          type: "capture",
          job: this.#poll(command.operationId).job,
        } as WorkspaceCommandReply;
      }
      case "finish_capture": {
        const staged = this.#staged.get(command.captureOperationId);
        if (staged !== undefined && command.outcome === "published") {
          this.kept = new Map(staged.tree);
          this.keptDigest = await digestOf(staged.tree);
        }
        this.#staged.delete(command.captureOperationId);
        return { type: "finish_capture", done: true };
      }
      case "job_status": {
        const job = this.#poll(command.jobOperationId).job;
        return { type: "job_status", job } as WorkspaceCommandReply;
      }
      case "status":
        return { type: "status", report: this.state() };
      case "credential_snapshot":
        return { type: "credential_snapshot", order: this.#publishCredentials() };
      case "sign_out":
        this.credentials.delete(LOGIN_FILES.claude);
        this.credentials.delete(LOGIN_FILES.codex);
        this.#signedOut = true;
        this.#publishCredentials();
        return { type: "sign_out", claude: "ok", codex: "ok" };
    }
  }

  /** A job's reply: `running` for its remaining polls, then its outcome. */
  #poll(operationId: string): Extract<WorkspaceCommandReply, { job: unknown }> & { job: never } {
    const job = this.#jobs.get(operationId);
    if (job === undefined) {
      return {
        type: "job_status",
        job: {
          kind: "capture",
          jobOperationId: operationId,
          state: "failed",
          reason: "busy",
          pausedMs: 0,
        },
      } as never;
    }
    if (job.polls > 0) {
      job.polls -= 1;
      const kind =
        "job" in job.reply ? (job.reply.job as { kind: "restore" | "capture" }).kind : "capture";
      return {
        type: job.reply.type,
        job: { kind, jobOperationId: operationId, state: "running" },
      } as never;
    }
    return job.reply as never;
  }

  /** The staged layer's content for an upload from `dir`. */
  stagedAt(dir: string): LayerContent | undefined {
    for (const staged of this.#staged.values()) if (staged.layerDir === dir) return staged.content;
    return undefined;
  }

  get signedOut(): boolean {
    return this.#signedOut;
  }
}

/**
 * The computer's container with a supervisor per start, and R2's workspace layers. Uploads copy
 * the staged layer's content into the bucket; restores copy it into the supervisor's restore
 * directory; deletions remove it.
 */
export class SimulatedComputer extends FakeComputerContainer {
  readonly computerId: ComputerId;
  readonly layers = new Map<string, LayerContent>();
  sup: FakeSupervisor | null = null;
  readonly supervisors: FakeSupervisor[] = [];
  supervisorOptions: Partial<SupervisorOptions> = {};

  constructor(computerId: ComputerId) {
    super();
    this.computerId = computerId;
    this.supervisor = (request) => {
      if (this.sup === null) throw new Error("no supervisor");
      return this.sup.handle(request);
    };
  }

  /** The next starts throw Cloudflare's refusal at once instead of returning (CF-05's other form). */
  startThrows = 0;

  override start(options: Parameters<FakeComputerContainer["start"]>[0]): void {
    if (this.startThrows > 0) {
      this.startThrows -= 1;
      this.starts.push({ instance: options.instance, env: { ...options.env }, refused: true });
      throw new Error(NO_INSTANCE_MESSAGE);
    }
    super.start(options);
    if (this.running) {
      const generation = Number(options.env.CFO_GENERATION);
      this.sup = new FakeSupervisor(this.computerId, generation, { ...this.supervisorOptions });
      this.supervisors.push(this.sup);
      this.sup.hello();
    }
  }

  /** While set, `destroy` waits for it: a stop that takes time. */
  destroyGate: Promise<void> | null = null;

  override async destroy(reason: string): Promise<void> {
    if (this.destroyGate !== null) await this.destroyGate;
    await super.destroy(reason);
    if (!this.running) this.sup = null;
  }

  override stopByPlatform(reason?: string): void {
    super.stopByPlatform(reason);
    this.sup = null;
  }

  override async backup(options: BackupOptions): Promise<DirectoryBackupRecord> {
    const content = this.sup?.stagedAt(options.dir);
    if (this.running && content === undefined) {
      throw new Error("BACKUP_STAGE: nothing staged at the directory");
    }
    const record = await super.backup(options);
    if (content !== undefined) this.layers.set(record.id, content);
    return record;
  }

  override async restore(record: DirectoryBackupRecord, options: RestoreOptions): Promise<void> {
    await super.restore(record, options);
    const content = this.layers.get(record.id);
    if (content === undefined || this.sup === null) throw new Error("BACKUP_NOT_FOUND");
    this.sup.restoredDirs.set(options.dir, content);
  }

  override async deleteBackup(
    record: DirectoryBackupRecord,
    options: { readonly prefix: string },
  ): Promise<void> {
    await super.deleteBackup(record, options);
    if (!this.backups.has(record.id)) this.layers.delete(record.id);
  }
}
