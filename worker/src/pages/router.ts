// The platform pages' routes (WP3.5), under `/platform/`, for a request ingress admitted. Every
// answer carries the pages' security headers, framing protection included (RC-07's G3 part);
// nothing under `/platform/` is ever forwarded to Omnigent.
//
//   GET  /platform/computers                      the cloud-computers page
//   GET  /platform/computers/{id}                 "Set up this computer" (Omnigent's manage_url)
//   GET  /platform/computers/{id}/state           the page's live state (JSON)
//   GET  /platform/computers/{id}/do/{action}     a confirmation page (never the action)
//   POST /platform/computers/{id}/do/{action}     the action, guarded, then a 303
//   POST /platform/computers/{id}/terminal        open, reconnect or close the terminal window
//   GET  /platform/computers/{id}/terminal        with Upgrade: websocket, the bridged terminal
//   GET  /platform/computers/{id}/sign-in         a sign-in attempt's state (WP3.23, JSON)
//   POST /platform/computers/{id}/sign-in         start a sign-in, relay the pasted code, cancel
//   GET  /platform/computers/{id}/status          the computer's status (JSON)
//   POST /platform/computers/{id}/staging-check   staging only: RC-53's save check on or off
//   GET  /platform/assets/{name}                  the pages' own scripts and styles

import type { PageOwner } from "@cfo/contracts";
import type { WebEnv } from "../env.ts";
import type { Admitted } from "../ingress/index.ts";
import { bindingsBackend, type PagesBackend } from "./backend.ts";
import {
  actionBySlug,
  computersPage,
  confirmPage,
  notFoundPage,
  parseComputerId,
  performAction,
  refusedPage,
} from "./computers.ts";
import { COMPUTERS_PATH, PAGES_ROOT } from "./html.ts";
import { securityHeaders } from "./http.ts";
import { signInChange, signInRead, stagingChange, statusRead } from "./owner-actions.ts";
import { setupPage, stateJson, terminalChange, terminalUpgrade } from "./setup.ts";

/** One asset: its body and content type. */
export interface Asset {
  readonly body: string;
  readonly type: string;
}

export interface PlatformDeps {
  readonly backend?: PagesBackend;
  /** The assets by name: web.ts loads `assets.ts`, a runtime module, on first use. */
  readonly assets: () => Promise<Readonly<Record<string, Asset>>>;
  readonly now?: () => number;
  readonly log?: (fields: Readonly<Record<string, string>>) => void;
}

const MAX_LOGGED_PATH = 256;

/** Whether a path belongs to the platform pages. */
export function isPlatformPath(pathname: string): boolean {
  return pathname === PAGES_ROOT || pathname.startsWith(`${PAGES_ROOT}/`);
}

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed.\n", {
    status: 405,
    headers: { ...securityHeaders(), "content-type": "text/plain; charset=utf-8", allow },
  });
}

function head(request: Request, response: Response): Response {
  return request.method === "HEAD" ? new Response(null, response) : response;
}

/** Routes an admitted request under `/platform/`. */
export async function routePlatform(
  admitted: Admitted,
  env: WebEnv,
  deps: PlatformDeps,
): Promise<Response> {
  const request = admitted.request;
  const url = new URL(request.url);
  const log =
    deps.log ??
    ((fields: Readonly<Record<string, string>>) =>
      console.log(JSON.stringify({ ...fields, path: url.pathname.slice(0, MAX_LOGGED_PATH) })));
  const now = deps.now ?? Date.now;
  const owner: PageOwner = { sub: admitted.identity.sub, sessionId: admitted.identity.sessionId };
  const read = request.method === "GET" || request.method === "HEAD";
  try {
    const backend = deps.backend ?? bindingsBackend(env);
    const parts = url.pathname.split("/").slice(2); // after "", "platform"
    if (parts.length === 0 || (parts.length === 1 && parts[0] === "")) {
      if (!read) return methodNotAllowed("GET, HEAD");
      return new Response(null, {
        status: 303,
        headers: { ...securityHeaders(), location: COMPUTERS_PATH },
      });
    }
    if (parts[0] === "assets" && parts.length === 2) {
      if (!read) return methodNotAllowed("GET, HEAD");
      const asset = (await deps.assets())[parts[1] ?? ""];
      if (asset === undefined) return head(request, notFoundPage());
      return head(
        request,
        new Response(asset.body, {
          headers: {
            ...securityHeaders(),
            "content-type": asset.type,
            "cache-control": "private, max-age=300",
          },
        }),
      );
    }
    if (parts[0] !== "computers") return head(request, notFoundPage());
    if (parts.length === 1) {
      if (!read) return methodNotAllowed("GET, HEAD");
      return head(request, await computersPage(backend, owner, url, now()));
    }
    const id = parseComputerId(parts[1]);
    if (id === null) return head(request, notFoundPage());
    if (parts.length === 2) {
      if (!read) return methodNotAllowed("GET, HEAD");
      return head(request, await setupPage(backend, owner, id, url, admitted.origin, now()));
    }
    if (parts.length === 3 && parts[2] === "state") {
      if (!read) return methodNotAllowed("GET, HEAD");
      return head(request, await stateJson(backend, owner, id, now()));
    }
    if (parts.length === 3 && parts[2] === "terminal") {
      const upgrade = request.headers.get("upgrade")?.trim().toLowerCase() === "websocket";
      if (upgrade) return terminalUpgrade(backend, owner, id, request, admitted.origin, log);
      if (request.method === "POST") {
        return terminalChange(backend, owner, id, request, admitted.origin, log);
      }
      return methodNotAllowed("POST");
    }
    if (parts.length === 3 && parts[2] === "sign-in") {
      if (read) return head(request, await signInRead(backend, owner, id, url, now(), log));
      if (request.method === "POST") {
        return signInChange(backend, owner, id, request, admitted.origin, now(), log);
      }
      return methodNotAllowed("GET, HEAD, POST");
    }
    if (parts.length === 3 && parts[2] === "status") {
      if (!read) return methodNotAllowed("GET, HEAD");
      return head(request, await statusRead(backend, owner, id, now(), log));
    }
    if (parts.length === 3 && parts[2] === "staging-check") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return stagingChange(backend, owner, id, request, admitted.origin, log);
    }
    if (parts.length === 4 && parts[2] === "do") {
      const spec = actionBySlug(parts[3] ?? "");
      if (spec === undefined) return head(request, notFoundPage());
      if (read) return head(request, await confirmPage(backend, owner, id, spec, now()));
      if (request.method === "POST") {
        return performAction(backend, owner, id, spec, request, admitted.origin, log);
      }
      return methodNotAllowed("GET, HEAD, POST");
    }
    return head(request, notFoundPage());
  } catch (error) {
    log({ event: "page_failed", error: error instanceof Error ? error.name : "unknown" });
    return refusedPage(503, "The page could not be built now. Try again shortly.");
  }
}
