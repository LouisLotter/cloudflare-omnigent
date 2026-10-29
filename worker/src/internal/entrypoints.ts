// The platform Worker's entrypoints for its private virtual hosts, reachable only through
// container interception (design, "Internal bridges"): each wires the Worker's bindings to a
// pure handler and does nothing else.
//   - `PlatformInternal`: `platform.internal`, the server container's only intercept: the
//     launcher API (`platform-api.ts`) under `/launcher/`, and core change 19's key service for
//     Omnigent's credential store (`key-service.ts`) under `/key-service/v1/` (WP5.9).
//   - `OmnigentRoute`: `omnigent.internal`, a computer's live connection (`omnigent-route.ts`).
//   - `ComputerApi`: `computer.internal`, a computer's supervisor (`computer-api.ts`).
// Props are trusted: only the Durable Object that owns a container registers its intercepts.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ComputerCall,
  type ComputerId,
  ComputerPageState,
  type ControlCall,
  type ControlResult,
  type LauncherCall,
  type LauncherResult,
  type PagesCall,
  type PagesResult,
  type SupervisorReply,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import type { PlatformEnv } from "../env.ts";
import { RateLimiter } from "../ingress/limits.ts";
import { isServerProps, type PlatformInternalProps } from "../server/platform-internal.ts";
import { logEvent } from "../server/responses.ts";
import {
  CONTROL_OBJECT_NAME,
  OMNIGENT_SERVER_OBJECT_NAME,
  WorkspaceIdentity,
  workspaceObjectName,
} from "../shared/rpc.ts";
import { COMPUTER_API_LIMITS, handleSupervisorMessage, INBOUND_RETRY } from "./computer-api.ts";
import {
  handleKeyServiceRequest,
  KEY_SERVICE_BASE_PATH,
  keyServiceError,
  keyServiceKeysFrom,
} from "./key-service.ts";
import {
  type ComputerIdentity,
  handleComputerRequest,
  normalizeBasePath,
  ROUTE_HTTP_LIMITS,
  ROUTE_UPGRADE_LIMITS,
} from "./omnigent-route.ts";
import { handleLauncherRequest, launcherError, signingKeysFrom } from "./platform-api.ts";
import { serverUpgradeAnswer } from "./upgrade-answer.ts";

/** WorkspaceDO as these entrypoints call it (`shared/rpc.ts` `WorkspaceRpc`). */
interface WorkspaceStub {
  launcher(call: LauncherCall): Promise<LauncherResult>;
  computer(call: ComputerCall): Promise<SupervisorReply>;
  pages(call: PagesCall): Promise<PagesResult>;
  identity(call: { readonly interfaceVersion: number }): Promise<unknown>;
}

/** The runtime's answer when a stub's object has no such RPC method (an older version). */
function isMissingMethod(error: unknown): boolean {
  return /does not implement|not a function/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * The computer's identity for its route: WorkspaceDO's narrow `identity` read (WP3.18). During a
 * deploy, new Worker code can meet a WorkspaceDO still on the version before `identity` existed
 * (about 300 s, R-26): only then the page state is read instead.
 */
async function readIdentity(env: InternalEnv, computerId: ComputerId): Promise<ComputerIdentity> {
  const stub = workspace(env, computerId);
  let answer: unknown;
  try {
    answer = await stub.identity({ interfaceVersion: WORKSPACE_INTERFACE_VERSION });
  } catch (error) {
    if (!isMissingMethod(error)) throw error;
    const state = await stub.pages({
      action: "state",
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
    });
    if (state.action !== "state") throw new Error("unexpected answer");
    answer = ComputerPageState.parse(state.computer);
  }
  if (answer === null) throw new Error("no such computer");
  const identity = WorkspaceIdentity.parse(answer);
  if (identity.computerId !== computerId) throw new Error("another computer's identity");
  return { generation: identity.generation, hostId: identity.hostId };
}

/** The bindings these entrypoints use. */
export interface InternalEnv {
  readonly OMNIGENT?: { getByName(name: string): { fetch(request: Request): Promise<Response> } };
  readonly WORKSPACE?: { getByName(name: string): WorkspaceStub };
  readonly CONTROL?: {
    getByName(name: string): { control(call: ControlCall): Promise<ControlResult> };
  };
}

function internalEnv(env: PlatformEnv): InternalEnv {
  return env as unknown as InternalEnv;
}

function workspace(env: InternalEnv, computerId: string): WorkspaceStub {
  if (!env.WORKSPACE) throw new Error("no WORKSPACE binding");
  return env.WORKSPACE.getByName(workspaceObjectName(computerId as ComputerId));
}

/** Whether a `platform.internal` path is the key service's rather than the launcher API's. */
function isKeyServicePath(pathname: string): boolean {
  return pathname === KEY_SERVICE_BASE_PATH || pathname.startsWith(`${KEY_SERVICE_BASE_PATH}/`);
}

/** `platform.internal`. Its props say who registered it: only OmnigentServer does. */
export class PlatformInternal extends WorkerEntrypoint<PlatformEnv, PlatformInternalProps> {
  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const keyService = isKeyServicePath(pathname);
    if (!isServerProps(this.ctx.props)) {
      logEvent(keyService ? "key_service" : "launcher_api", "refused", {
        path: pathname.slice(0, 64),
        status: 503,
        refused: "props",
      });
      return keyService
        ? keyServiceError("unavailable")
        : launcherError("unavailable", "This platform service is not available.");
    }
    if (keyService) {
      return handleKeyServiceRequest(request, {
        keys: keyServiceKeysFrom(this.env as unknown as Record<string, unknown>),
        nowSeconds: () => Math.floor(Date.now() / 1000),
        log: (event, fields) => logEvent("key_service", event, fields),
      });
    }
    const env = internalEnv(this.env);
    return handleLauncherRequest(request, {
      keys: signingKeysFrom(this.env as unknown as Record<string, unknown>),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      launcher: (computerId, call) => workspace(env, computerId).launcher(call),
      control: (call) => {
        if (!env.CONTROL) throw new Error("no CONTROL binding");
        return env.CONTROL.getByName(CONTROL_OBJECT_NAME).control(call);
      },
      log: (event, fields) => logEvent("launcher_api", event, fields),
    });
  }
}

// Per isolate: a coarse brake, not a global quota (as ingress's limits).
const httpLimiter = new RateLimiter(() => Date.now(), ROUTE_HTTP_LIMITS);
const upgradeLimiter = new RateLimiter(() => Date.now(), ROUTE_UPGRADE_LIMITS);
const messageLimiter = new RateLimiter(() => Date.now(), COMPUTER_API_LIMITS);

/**
 * `omnigent.internal`, with the computer's `InterceptProps`. The computer's identity is read
 * from WorkspaceDO's `identity` for every request: its generation and, for a host tunnel, the
 * host ID bound at the first `start_host`.
 */
export class OmnigentRoute extends WorkerEntrypoint<PlatformEnv> {
  override async fetch(request: Request): Promise<Response> {
    const env = internalEnv(this.env);
    return handleComputerRequest(request, this.ctx.props, {
      // Omnigent strips this prefix before routing (BasePathMiddleware), so the route matches
      // its rules with and without it. The server reads it from the same Worker secret.
      basePath: normalizeBasePath(
        (this.env as unknown as Record<string, string | undefined>)
          .SERVER_ENV_OMNIGENT_WEB_BASE_PATH,
      ),
      httpLimiter,
      upgradeLimiter,
      readIdentity: (computerId) => readIdentity(env, computerId),
      forward: (forwarded) => {
        if (!env.OMNIGENT) throw new Error("no OMNIGENT binding");
        return env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME).fetch(forwarded);
      },
      answerUpgrade: serverUpgradeAnswer,
      log: (event, fields) => logEvent("computer_route", event, fields),
    });
  }
}

/** `computer.internal`, with the computer's `InterceptProps`. */
export class ComputerApi extends WorkerEntrypoint<PlatformEnv> {
  override async fetch(request: Request): Promise<Response> {
    const env = internalEnv(this.env);
    return handleSupervisorMessage(request, this.ctx.props, {
      computer: (computerId, call) => workspace(env, computerId).computer(call),
      limiter: messageLimiter,
      retry: INBOUND_RETRY,
      log: (event, fields) => logEvent("computer_api", event, fields),
    });
  }
}
