// The member group's port to Cloudflare's API (WP8.3): GET and PUT of exactly one Access group,
// `accounts/<account>/access/groups/<group>`, with the platform Worker's own token. The URL is
// built once, from the installation's recorded account and group IDs, so no call can name
// another group, an application or the organization. The token is sent only to
// api.cloudflare.com, in the Authorization header, and never logged or put in an error.
//
// Unverified against the live API (the lead's staging check, with WP8.12): the shape of the
// group's read and of its replacement follows Cloudflare's published API reference.

import type { AccessGroup, AccessGroupPort } from "./access-admission.ts";

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/**
 * Local end-to-end runs only (worker/test/e2e/team-move-e2e.ts): Cloudflare's API stand-in on
 * `http://127.0.0.1:<port>`. Ignored in any other form, so a stray value cannot redirect the
 * token anywhere; a deployed Worker cannot reach the loopback address at all.
 */
export const ACCESS_API_LOCAL_ONLY_VAR = "CFO_ACCESS_API_LOCAL_ONLY";
const LOCAL_API = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const API_TIMEOUT_MS = 15_000;

/** The platform Worker's settings for it: the recorded IDs and the token secret. */
export const ACCESS_ADMISSION_VARS = {
  accountId: "CFO_ACCESS_ACCOUNT_ID",
  groupId: "CFO_ACCESS_GROUP_ID",
  token: "CFO_ACCESS_GROUP_TOKEN",
} as const;

/** Cloudflare refused or failed the call. Carries the status only. */
export class AccessApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Cloudflare's Access API answered ${status}`);
    this.status = status;
  }
}

function list(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** The port, or undefined when a setting is missing or malformed (fail closed). */
export function accessGroupPortFrom(
  vars: Readonly<Record<string, unknown>>,
  fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) =>
    fetch(input, init),
): AccessGroupPort | undefined {
  const accountId = vars[ACCESS_ADMISSION_VARS.accountId];
  const groupId = vars[ACCESS_ADMISSION_VARS.groupId];
  const token = vars[ACCESS_ADMISSION_VARS.token];
  if (
    typeof accountId !== "string" ||
    !ACCOUNT_ID.test(accountId) ||
    typeof groupId !== "string" ||
    !GROUP_ID.test(groupId) ||
    typeof token !== "string" ||
    token.length < 20
  ) {
    return undefined;
  }
  const local = vars[ACCESS_API_LOCAL_ONLY_VAR];
  const api = typeof local === "string" && LOCAL_API.test(local) ? local : CLOUDFLARE_API;
  const url = `${api}/accounts/${accountId}/access/groups/${groupId}`;
  const call = async (method: "GET" | "PUT", body?: AccessGroup): Promise<Response> =>
    fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  return {
    groupId,
    async read() {
      const response = await call("GET");
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AccessApiError(response.status);
      }
      const data = (await response.json()) as { result?: Record<string, unknown> } | null;
      const result = data?.result;
      const include = list(result?.include);
      if (result === undefined || include === undefined || typeof result.name !== "string") {
        throw new AccessApiError(502);
      }
      return {
        name: result.name,
        include,
        exclude: list(result.exclude),
        require: list(result.require),
      };
    },
    async write(group) {
      const response = await call("PUT", group);
      await response.body?.cancel();
      if (!response.ok) throw new AccessApiError(response.status);
    },
  };
}
