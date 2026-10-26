/**
 * In-memory fake of one WorkspaceDO (WP3.1's), for the packages that call it before it exists:
 * the launcher API and the computer API routes (WP3.3), ControlDO's reconciliation (WP3.2) and the
 * pages (WP3.5). It answers by the contract's own lifecycle table (`step`), so its replies are the
 * ones the real controller must give:
 *   - launcher calls, with their idempotency: a repeated operation ID returns the recorded
 *     outcome, errors included, and a sleep's outcome is recorded once it is known;
 *   - `gone` after a removal intent, `at_capacity` when a test sets that guard, `conflict` for a
 *     superseded or repeated start;
 *   - the computer API's replies, refusing a message whose props name another computer or
 *     generation;
 *   - the pages' actions, through the same table.
 * A test drives the computer's own events (the container started, the restore confirmed, the
 * stop confirmed, ...) with `fire`, and sets outside facts (`at_capacity`, `terminal_open`,
 * `runner_processes`, ...) in `inputs`. Every call is parsed with the contract and its interface
 * version checked, as WorkspaceDO does.
 */
import {
  ComputerCall,
  type ComputerId,
  type ComputerPageState,
  type CredentialBundle,
  containerMayRun,
  credentialIsNewer,
  type Effect,
  type ErrorCode,
  type GuardInput,
  type HostId,
  INITIAL_CONTEXT,
  LAUNCHER_OPERATIONS,
  LauncherCall,
  type LauncherRequest,
  type LauncherResult,
  type LifecycleEvent,
  type MachineContext,
  PagesCall,
  type PagesResult,
  type Reply,
  type ReservationState,
  ruleFor,
  SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS,
  SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS,
  type SupervisorReply,
  step,
  typedStatus,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { platformError } from "../../src/shared/errors.ts";
import { type WorkspaceRpc, WriteCheck, type WriteDecision } from "../../src/shared/rpc.ts";
import { OperationJournal } from "./operation-journal.ts";

type Recorded = { readonly result: LauncherResult } | { readonly error: ErrorCode };

export const FAKE_WORKSPACE_PATH = "/home/omnigent/work";

function checkVersion(interfaceVersion: number): void {
  if (interfaceVersion > WORKSPACE_INTERFACE_VERSION) {
    throw platformError("unsupported_version", `interface version ${interfaceVersion}`);
  }
}

/** A mutating call's operation ID; read-only calls have none. */
function operationIdOf(call: object): string | undefined {
  const id = (call as { readonly operationId?: unknown }).operationId;
  return typeof id === "string" ? id : undefined;
}

export class FakeWorkspace implements WorkspaceRpc {
  context: MachineContext = INITIAL_CONTEXT;
  /** Outside facts the next events see. */
  readonly inputs = new Set<GuardInput>();
  generation = 0;
  /** The latest claimed start attempt. */
  attempt = 0;
  hostId: HostId | null = null;
  hostName: string | null = null;
  /** "Not saved": admission closed by WorkspaceDO (design, Admission). */
  notSaved = false;
  reservationState: ReservationState | null = null;
  credentialPointer: CredentialBundle | null = null;
  readonly launcherCalls: LauncherRequest[] = [];
  readonly computerCalls: ComputerCall[] = [];
  readonly pageCalls: PagesCall[] = [];
  readonly effects: Effect[] = [];
  /** Launcher operations recorded by operation ID, each bound to its request when it began. */
  readonly #operations = new OperationJournal<Recorded>();
  readonly #pageOperations = new OperationJournal<PagesResult>();
  /** The order floor of this generation's credential install, if one was simulated. */
  #orderFloor: { readonly generation: number; readonly floor: number } | null = null;
  /** Every operation waiting on the sleep in progress: they share its outcome. */
  readonly #sleepOperations = new Set<string>();

  readonly computerId: ComputerId;

  constructor(computerId: ComputerId) {
    this.computerId = computerId;
  }

  /**
   * Simulates `install_credentials` in the current generation: the supervisor's reply gives the
   * order floor, and a bundle of this generation at or below it predates the restored
   * credentials, so it is `superseded`, never published.
   */
  installCredentials(orderFloor: number): void {
    this.#orderFloor = { generation: this.generation, floor: orderFloor };
  }

  /** Applies one of the computer's own events, as WorkspaceDO's steps would. */
  fire(event: LifecycleEvent, extra: readonly GuardInput[] = []): Reply | undefined {
    const before = this.context;
    const { context, reply, effects } = step(before, event, new Set([...this.inputs, ...extra]));
    this.context = context;
    this.effects.push(...effects);
    if (effects.includes("start_container")) this.generation += 1;
    if (this.#sleepOperations.size > 0) {
      let outcome: Recorded | null = null;
      if (
        event === "stop_preparation_failed" &&
        before.stopPrep !== null &&
        context.stopPrep === null
      ) {
        outcome = {
          result: { operation: "suspend", outcome: "refused", reason: "checkpoint_failed" },
        };
      } else if (!containerMayRun(context.state) || context.state === "waking") {
        outcome = { result: { operation: "suspend", outcome: "stopped" } };
      }
      if (outcome) {
        for (const operationId of this.#sleepOperations)
          this.#operations.settle(operationId, outcome);
        this.#sleepOperations.clear();
      }
    }
    return reply;
  }

  async launcher(raw: LauncherCall): Promise<LauncherResult> {
    const parsed = LauncherCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a LauncherCall");
    checkVersion(parsed.data.interfaceVersion);
    const request = parsed.data.request;
    if (
      !(SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS as readonly number[]).includes(request.protocolVersion)
    ) {
      throw platformError("unsupported_version", `launcher protocol ${request.protocolVersion}`);
    }
    this.launcherCalls.push(request);
    const byOperationId = LAUNCHER_OPERATIONS[request.operation].idempotency === "operation_id";
    const recorded = byOperationId
      ? this.#operations.begin(request.operationId, request)
      : undefined;
    if (recorded) {
      if ("error" in recorded) throw platformError(recorded.error, "recorded outcome");
      return recorded.result;
    }
    let outcome: Recorded;
    try {
      outcome = { result: this.#answer(request) };
    } catch (error) {
      const code = /^\[([a-z_]+)\] /.exec((error as Error).message)?.[1] as ErrorCode | undefined;
      if (!code) throw error;
      outcome = { error: code };
    }
    const settled = !(
      "result" in outcome &&
      outcome.result.operation === "suspend" &&
      outcome.result.outcome === "in_progress"
    );
    if (byOperationId && settled) this.#operations.settle(request.operationId, outcome);
    if (!settled) this.#sleepOperations.add(request.operationId);
    if ("error" in outcome) throw platformError(outcome.error, `${request.operation} refused`);
    return outcome.result;
  }

  #event(event: LifecycleEvent, extra: readonly GuardInput[] = []): Reply {
    const before = this.context;
    const reply = this.fire(event, extra);
    if (!reply) throw new Error(`no reply for ${before.state} × ${event}`);
    if (reply.kind === "error") throw platformError(reply.code, `${event} in ${before.state}`);
    return reply;
  }

  #answer(request: LauncherRequest): LauncherResult {
    const status = typedStatus(this.context);
    switch (request.operation) {
      case "prepare":
        return {
          operation: "prepare",
          supportedProtocolVersions: [...SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS],
        };
      case "provision":
        return { operation: "provision", computerId: this.computerId };
      case "status":
        if (this.context.removalIntent) throw platformError("gone", "removed");
        return {
          operation: "status",
          running: containerMayRun(this.context.state) && this.context.state !== "waking",
          status,
          generation: this.generation,
        };
      case "admission":
        if (this.context.removalIntent) throw platformError("gone", "removed");
        return this.notSaved
          ? {
              operation: "admission",
              admitting: false,
              reason: "not_saved",
              status,
              generation: this.generation,
            }
          : { operation: "admission", admitting: true, status, generation: this.generation };
      case "keep_alive":
        return { operation: "keep_alive", renewed: status !== "stopped" };
      case "resume": {
        const reply = this.#event("resume");
        if (reply.kind !== "resume") throw new Error("resume");
        return { operation: "resume", outcome: reply.outcome, generation: this.generation };
      }
      case "claim_start": {
        const reply = this.#event("claim_start");
        if (reply.kind !== "claim") throw new Error("claim");
        if (!reply.granted) {
          return {
            operation: "claim_start",
            granted: false,
            status: status as "stopped" | "host_running" | "stopping",
          };
        }
        this.attempt += 1;
        return { operation: "claim_start", granted: true, startAttempt: this.attempt };
      }
      case "start_host": {
        if (this.hostId !== null && request.hostId !== this.hostId) {
          throw platformError("conflict", "another host already uses this computer");
        }
        const current = request.startAttempt === this.attempt ? (["attempt_current"] as const) : [];
        this.#event("start_host", current);
        this.hostId = request.hostId;
        this.hostName = request.hostName;
        return { operation: "start_host", workspacePath: FAKE_WORKSPACE_PATH };
      }
      case "checkpoint": {
        const reply = this.#event("checkpoint");
        if (reply.kind === "checkpoint_refused") {
          return { operation: "checkpoint", outcome: "refused", reason: reply.reason };
        }
        if (reply.kind !== "checkpoint") throw new Error("checkpoint");
        return { operation: "checkpoint", outcome: "accepted", folded: reply.folded };
      }
      case "suspend": {
        const reply = this.#event("suspend");
        if (reply.kind === "suspend_refused") {
          return { operation: "suspend", outcome: "refused", reason: reply.reason };
        }
        if (reply.kind !== "suspend") throw new Error("suspend");
        return { operation: "suspend", outcome: reply.outcome };
      }
      case "terminate": {
        const reply = this.#event("terminate");
        if (reply.kind !== "terminate") throw new Error("terminate");
        return { operation: "terminate", removal: reply.removal };
      }
    }
  }

  async computer(raw: ComputerCall): Promise<SupervisorReply> {
    const parsed = ComputerCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a ComputerCall");
    checkVersion(parsed.data.interfaceVersion);
    const { props, message } = parsed.data;
    this.computerCalls.push(parsed.data);
    if (
      props.computerId !== this.computerId ||
      message.computerId !== props.computerId ||
      message.generation !== props.generation ||
      props.generation !== this.generation
    ) {
      throw platformError("stale_generation", "another computer or an older generation");
    }
    if (
      !(SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS as readonly number[]).includes(
        message.protocolVersion,
      )
    ) {
      throw platformError("unsupported_version", `supervisor protocol ${message.protocolVersion}`);
    }
    switch (message.type) {
      case "hello":
        return { type: "hello", protocolVersion: message.protocolVersion };
      case "report":
        return { type: "report", appliedSeq: message.report.seq };
      case "credential_checkpoint": {
        // The lifecycle decides first: no checkpoint before the restore is confirmed (R-19).
        const rule = ruleFor(this.context, "credential_checkpoint", this.inputs);
        if (!rule.effects?.includes("publish_credentials")) {
          throw platformError("conflict", `no credential checkpoint in ${this.context.state}`);
        }
        const floor = this.#orderFloor;
        const predatesInstall =
          floor !== null &&
          floor.generation === message.bundle.generation &&
          message.bundle.order <= floor.floor;
        if (predatesInstall || !credentialIsNewer(message.bundle, this.credentialPointer)) {
          return { type: "credential_checkpoint", outcome: "superseded", checkpointId: null };
        }
        this.credentialPointer = message.bundle;
        this.fire("credential_checkpoint");
        return {
          type: "credential_checkpoint",
          outcome: "published",
          checkpointId: "ckp_01hzy5b2c3d4e5f6g7h8j9k0m1",
        };
      }
      case "save_request":
        return {
          type: "save_request",
          outcome: containerMayRun(this.context.state) ? "accepted" : "refused",
        };
    }
  }

  /** What the page shows; a test may override any field. */
  page: Partial<ComputerPageState> = {};

  async pages(raw: PagesCall): Promise<PagesResult> {
    const parsed = PagesCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a PagesCall");
    checkVersion(parsed.data.interfaceVersion);
    const call = parsed.data;
    this.pageCalls.push(call);
    const operationId = operationIdOf(call);
    const recorded =
      operationId === undefined ? undefined : this.#pageOperations.begin(operationId, call);
    if (recorded) return recorded;
    const result = this.#page(call);
    if (operationId !== undefined) this.#pageOperations.settle(operationId, result);
    return result;
  }

  #page(call: PagesCall): PagesResult {
    const event = {
      restart: "restart",
      stop_without_saving: "stop_without_saving",
      sign_out: "sign_out_run",
      resolve_removal: "removal_resolved",
    } as const;
    switch (call.action) {
      case "state":
        return { action: "state", computer: this.#pageState() };
      case "set_size":
        return { action: "set_size", appliesAt: "next_start" };
      case "record_revocation":
        return { action: "record_revocation", recorded: true };
      default: {
        const reply = this.fire(event[call.action]);
        if (reply?.kind === "page_refused") {
          return { action: call.action, outcome: "refused", reason: reply.reason };
        }
        return { action: call.action, outcome: "accepted" };
      }
    }
  }

  #pageState(): ComputerPageState {
    const removal =
      this.context.state === "removed"
        ? "resolved"
        : this.context.removalIntent
          ? "pending"
          : "none";
    return {
      computerId: this.computerId,
      hostName: this.hostName,
      hostId: this.hostId,
      size: "standard-2",
      nextSize: null,
      lifecycle: this.context.state,
      status: typedStatus(this.context),
      generation: this.generation,
      admission: this.notSaved ? { admitting: false, reason: "not_saved" } : { admitting: true },
      saving: this.context.capturing,
      lastSavedAt: null,
      verifiedAt: null,
      workspaceBytes: null,
      lastContactAt: null,
      lastKeepAliveAt: null,
      restoredTo: null,
      unexpectedStopAt: null,
      refusedSleeps: 0,
      setupCards: [
        { provider: "claude", state: "unknown" },
        { provider: "codex", state: "unknown" },
      ],
      removal: {
        state: removal,
        signOut: "none",
        loginPossiblyLost: false,
        revocationRecorded: false,
      },
      ...this.page,
    };
  }

  /** The backup gateway's fence: this computer, no removal intent, the running generation, and
   * for a credential bundle a key under this computer's prefix (the fake keeps no upload list). */
  async writeAllowed(raw: WriteCheck): Promise<WriteDecision> {
    const parsed = WriteCheck.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a WriteCheck");
    checkVersion(parsed.data.interfaceVersion);
    const call = parsed.data;
    if (call.computerId !== this.computerId) return { allowed: false, reason: "unknown_computer" };
    if (this.context.removalIntent) return { allowed: false, reason: "removed" };
    const live = containerMayRun(this.context.state) && this.context.state !== "waking";
    if (!live || call.generation !== this.generation) {
      return { allowed: false, reason: "stale_generation" };
    }
    const prefix =
      call.kind === "credential"
        ? `credentials/${this.computerId}/`
        : `workspace/${this.computerId}/`;
    if (!call.objectKey.startsWith(prefix)) return { allowed: false, reason: "foreign_key" };
    return { allowed: true };
  }

  async reservation(call: { readonly interfaceVersion: number }): Promise<ReservationState | null> {
    checkVersion(call.interfaceVersion);
    return this.reservationState;
  }
}
