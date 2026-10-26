/**
 * A fake of the Cloudflare launcher as Omnigent drives it (core change 13's persistent hosts, core
 * change 15's checkpoints), for WorkspaceDO's tests (WP3.1) and the launcher API's (WP3.3). It
 * builds each request as the launcher does (protocol version, Omnigent's 32-hex operation IDs),
 * and can repeat a call, send calls concurrently, lose a reply or deliver a call late.
 *
 * Two transports: straight into a `WorkspaceRpc` (`rpcTransport`), or as the signed HTTP request
 * the launcher sends to `platform.internal` (`signedHttpTransport`, with the contract's reference
 * signer), so 3.3's route can be tested with the same client.
 */
import {
  ErrorBody,
  LAUNCHER_BASE_URL,
  LAUNCHER_PROTOCOL_VERSION,
  type LauncherRequest,
  LauncherResult,
  signLauncherRequest,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { errorCodeOf, platformError } from "../../src/shared/errors.ts";

export type LauncherTransport = (request: LauncherRequest) => Promise<LauncherResult>;

export function rpcTransport(target: {
  launcher(call: { interfaceVersion: number; request: LauncherRequest }): Promise<LauncherResult>;
}): LauncherTransport {
  return (request) => target.launcher({ interfaceVersion: WORKSPACE_INTERFACE_VERSION, request });
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/** The launcher's HTTP call: compact JSON with sorted keys, signed with the HMAC envelope. */
export function signedHttpTransport(input: {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly key: Uint8Array;
  readonly keyId: string;
  readonly clock?: () => number;
}): LauncherTransport {
  return async (request) => {
    const body = new TextEncoder().encode(JSON.stringify(canonical(request)));
    const headers = await signLauncherRequest({
      key: input.key,
      keyId: input.keyId,
      operation: request.operation,
      timestamp: Math.floor((input.clock ?? Date.now)() / 1000),
      body,
    });
    const response = await input.fetch(
      new Request(`${LAUNCHER_BASE_URL}/${request.operation}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
    const json = (await response.json()) as unknown;
    if (!response.ok) {
      const error = ErrorBody.parse(json);
      throw platformError(error.error.code, error.error.message);
    }
    return LauncherResult.parse(json);
  };
}

export interface Call {
  readonly request: LauncherRequest;
  readonly result?: LauncherResult;
  readonly error?: string;
  /** The reply never reached the caller. */
  readonly lost?: boolean;
}

export class FakeLauncherClient {
  readonly computerId: string;
  readonly transport: LauncherTransport;
  readonly calls: Call[] = [];
  #next = 0;

  constructor(computerId: string, transport: LauncherTransport) {
    this.computerId = computerId;
    this.transport = transport;
  }

  /** A fresh operation ID, as Omnigent mints them (`uuid.uuid4().hex`). */
  operationId(): string {
    this.#next += 1;
    return this.#next.toString(16).padStart(32, "0");
  }

  #base(operationId = this.operationId()) {
    return { protocolVersion: LAUNCHER_PROTOCOL_VERSION, operationId, computerId: this.computerId };
  }

  provisionRequest(name: string, operationId = this.operationId()): LauncherRequest {
    return {
      operation: "provision",
      protocolVersion: LAUNCHER_PROTOCOL_VERSION,
      operationId,
      name,
    };
  }
  resumeRequest(): LauncherRequest {
    return { operation: "resume", ...this.#base() };
  }
  statusRequest(): LauncherRequest {
    return { operation: "status", ...this.#base() };
  }
  admissionRequest(): LauncherRequest {
    return { operation: "admission", ...this.#base() };
  }
  keepAliveRequest(): LauncherRequest {
    return { operation: "keep_alive", ...this.#base() };
  }
  claimRequest(operationId?: string): LauncherRequest {
    return { operation: "claim_start", ...this.#base(operationId) };
  }
  startRequest(input: {
    readonly attempt: number;
    readonly token: string;
    readonly hostId: string;
    readonly hostName?: string;
    readonly operationId?: string;
  }): LauncherRequest {
    return {
      operation: "start_host",
      ...this.#base(input.operationId),
      startAttempt: input.attempt,
      hostId: input.hostId,
      hostName: input.hostName ?? "Work computer",
      token: input.token,
      hostConfig: { runner: { idle_timeout_s: 600 } },
    };
  }
  checkpointRequest(
    reason: "turn_completed" | "long_turn" = "turn_completed",
    operationId?: string,
  ): LauncherRequest {
    return { operation: "checkpoint", ...this.#base(operationId), reason };
  }
  suspendRequest(operationId?: string): LauncherRequest {
    return { operation: "suspend", ...this.#base(operationId) };
  }
  terminateRequest(): LauncherRequest {
    return { operation: "terminate", ...this.#base() };
  }

  /** Sends a request and returns its result; an error reply is thrown with its code. */
  async send(request: LauncherRequest): Promise<LauncherResult> {
    try {
      const result = await this.transport(request);
      this.calls.push({ request, result });
      return result;
    } catch (error) {
      this.calls.push({ request, error: errorCodeOf(error) ?? String(error) });
      throw error;
    }
  }

  /** The error code a request is answered with, or undefined if it succeeds. */
  async refusal(request: LauncherRequest): Promise<string | undefined> {
    try {
      await this.send(request);
      return undefined;
    } catch (error) {
      return errorCodeOf(error) ?? String(error);
    }
  }

  /** Sends a request whose reply is lost on the way back: the effect may have happened. */
  async lose(request: LauncherRequest): Promise<void> {
    try {
      await this.transport(request);
    } catch {
      // Lost either way.
    }
    this.calls.push({ request, lost: true });
  }

  /**
   * Omnigent's wake (core change 13): `resume`, then, for a parked status, a claim and the start
   * for that attempt. Returns the attempt it started, or null if the status needs no start.
   */
  async wake(input: { readonly hostId: string; readonly token: string }): Promise<number | null> {
    await this.send(this.resumeRequest());
    const status = await this.send(this.statusRequest());
    if (status.operation !== "status") throw new Error("status");
    if (!["started_no_host", "start_claimed", "host_refused"].includes(status.status)) return null;
    const claim = await this.send(this.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) return null;
    await this.send(
      this.startRequest({ attempt: claim.startAttempt, token: input.token, hostId: input.hostId }),
    );
    return claim.startAttempt;
  }
}
