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
  SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS,
  SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS,
  type SupervisorReply,
  step,
  typedStatus,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { platformError } from "../../src/shared/errors.ts";
import type { WorkspaceRpc } from "../../src/shared/rpc.ts";

type Recorded = { readonly result: LauncherResult } | { readonly error: ErrorCode };

export const FAKE_WORKSPACE_PATH = "/home/omnigent/work";

function checkVersion(interfaceVersion: number): void {
  if (interfaceVersion > WORKSPACE_INTERFACE_VERSION) {
    throw platformError("unsupported_version", `interface version ${interfaceVersion}`);
  }
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
  credentialPointer: { generation: number; order: number } | null = null;
  readonly launcherCalls: LauncherRequest[] = [];
  readonly computerCalls: ComputerCall[] = [];
  readonly pageCalls: PagesCall[] = [];
  readonly effects: Effect[] = [];
  readonly #outcomes = new Map<string, Recorded>();
  #sleepOperation: string | null = null;

  readonly computerId: ComputerId;

  constructor(computerId: ComputerId) {
    this.computerId = computerId;
  }

  /** Applies one of the computer's own events, as WorkspaceDO's steps would. */
  fire(event: LifecycleEvent, extra: readonly GuardInput[] = []): Reply | undefined {
    const before = this.context;
    const { context, reply, effects } = step(before, event, new Set([...this.inputs, ...extra]));
    this.context = context;
    this.effects.push(...effects);
    if (effects.includes("start_container")) this.generation += 1;
    if (this.#sleepOperation) {
      if (event === "stop_preparation_failed" && before.stopPrep === "sleep") {
        this.#record(this.#sleepOperation, {
          result: { operation: "suspend", outcome: "refused", reason: "checkpoint_failed" },
        });
        this.#sleepOperation = null;
      } else if (!containerMayRun(context.state) || context.state === "waking") {
        this.#record(this.#sleepOperation, {
          result: { operation: "suspend", outcome: "stopped" },
        });
        this.#sleepOperation = null;
      }
    }
    return reply;
  }

  #record(operationId: string, outcome: Recorded): void {
    this.#outcomes.set(operationId, outcome);
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
    const recorded = byOperationId ? this.#outcomes.get(request.operationId) : undefined;
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
    if (byOperationId && settled) this.#record(request.operationId, outcome);
    if (!settled) this.#sleepOperation ??= request.operationId;
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
        if (!credentialIsNewer(message.bundle, this.credentialPointer)) {
          return { type: "credential_checkpoint", outcome: "superseded", checkpointId: null };
        }
        this.credentialPointer = {
          generation: message.bundle.generation,
          order: message.bundle.order,
        };
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

  async reservation(call: { readonly interfaceVersion: number }): Promise<ReservationState | null> {
    checkVersion(call.interfaceVersion);
    return this.reservationState;
  }
}
