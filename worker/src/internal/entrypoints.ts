// The platform Worker's entrypoints for its private virtual hosts, reachable only through
// container interception (design, "Internal bridges"): each wires the Worker's bindings to a
// pure handler and does nothing else.
//   - `PlatformInternal`: `platform.internal`, the server container's only intercept: the
//     launcher API (`platform-api.ts`). Core change 19's key service (WP3.14) joins it there.
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
  workspaceObjectName,
} from "../shared/rpc.ts";
import { COMPUTER_API_LIMITS, handleSupervisorMessage, INBOUND_RETRY } from "./computer-api.ts";
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
}

/** The bindings these entrypoints use. `WORKSPACE` arrives with WP3.1's WorkspaceDO. */
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

/** `platform.internal`. Its props say who registered it: only OmnigentServer does. */
export class PlatformInternal extends WorkerEntrypoint<PlatformEnv, PlatformInternalProps> {
  override async fetch(request: Request): Promise<Response> {
    if (!isServerProps(this.ctx.props)) {
      logEvent("launcher_api", "refused", {
        path: new URL(request.url).pathname.slice(0, 64),
        status: 503,
        refused: "props",
      });
      return launcherError("unavailable", "This platform service is not available.");
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
 * from WorkspaceDO's page state for every request: its generation and, for a host tunnel, the
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
      readIdentity: async (computerId): Promise<ComputerIdentity> => {
        const state = await workspace(env, computerId).pages({
          action: "state",
          interfaceVersion: WORKSPACE_INTERFACE_VERSION,
        });
        if (state.action !== "state") throw new Error("unexpected answer");
        const computer = ComputerPageState.parse(state.computer);
        if (computer.computerId !== computerId) throw new Error("another computer's state");
        return { generation: computer.generation, hostId: computer.hostId };
      },
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
