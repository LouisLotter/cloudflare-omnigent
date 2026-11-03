// Who Access admits (WP8.3): the reconciler writes only the recorded member group's include list,
// refuses a list without a current owner or a widened group, ignores a lower revision and repairs
// drift at an equal one; the API port can name only that group's URL; the private route takes only
// the server's admission signature.

import {
  type AccessAdmissionCall,
  type AccessAdmissionResult,
  ADMISSION_PATH,
  admissionStringToSign,
  launcherStringToSign,
  sha256Hex,
} from "@cfo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleAdmissionRequest,
  isAdmissionPath,
  MAX_ADMISSION_BODY_BYTES,
} from "../../src/internal/admission-api.ts";
import type { SigningKeys } from "../../src/internal/platform-api.ts";
import {
  type AccessGroup,
  type AccessGroupPort,
  AdmissionUnconfirmed,
  applyAdmission,
} from "../../src/server/access-admission.ts";
import { accessGroupPortFrom, CLOUDFLARE_API } from "../../src/server/access-group-api.ts";

const OWNER = "owner@example.test";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const GROUP = "11111111-2222-4333-8444-555555555555";
const TOKEN = "synthetic-canary-token-value-0000000000";
const SECOND_OWNER = "second-owner@example.test";

class FakeGroup implements AccessGroupPort {
  readonly groupId = GROUP;
  writes: AccessGroup[] = [];
  /** Access drops the next write, as a lost or ignored PUT would. */
  dropNextWrite = false;
  group: AccessGroup | undefined;
  constructor(group: AccessGroup | undefined) {
    this.group = group;
  }
  async read() {
    return this.group;
  }
  async write(group: AccessGroup) {
    this.writes.push(group);
    if (this.dropNextWrite) {
      this.dropNextWrite = false;
      return;
    }
    this.group = group;
  }
}

const emailRule = (email: string) => ({ email: { email } });

function deps(port: FakeGroup | undefined, applied: number | null = null) {
  const logs: Record<string, string | number>[] = [];
  const state = { applied };
  return {
    logs,
    state,
    deps: {
      port,
      appliedRevision: () => state.applied,
      recordApplied: (revision: number) => {
        state.applied = revision;
      },
      log: (fields: Readonly<Record<string, string | number>>) => logs.push({ ...fields }),
    },
  };
}

const call = (
  revision: number,
  emails: string[],
  owners: string[] = [OWNER],
): AccessAdmissionCall => ({ revision, emails, owners });

describe("the member group's reconciler", () => {
  it("writes the list into include and keeps the group's other rules", async () => {
    const group = new FakeGroup({
      name: "web--members--n",
      include: [emailRule(OWNER)],
      exclude: [{ geo: { country_code: "XX" } }],
      require: [],
    });
    const { deps: d, state, logs } = deps(group);
    const result = await applyAdmission(call(4, ["alice@example.test", OWNER]), d);
    expect(result).toEqual({ outcome: "applied", revision: 4 });
    expect(group.group).toEqual({
      name: "web--members--n",
      include: [emailRule("alice@example.test"), emailRule(OWNER)],
      exclude: [{ geo: { country_code: "XX" } }],
      require: [],
    });
    expect(state.applied).toBe(4);
    expect(JSON.stringify(logs)).not.toContain("alice@example.test");
    expect(logs.at(-1)).toMatchObject({ group: GROUP, revision: 4, count: 2 });
  });

  it("ignores a lower revision, and applies an equal or newer one", async () => {
    const group = new FakeGroup({ name: "g", include: [emailRule(OWNER)] });
    const { deps: d } = deps(group, 7);
    expect(await applyAdmission(call(6, [OWNER, "bob@example.test"]), d)).toEqual({
      outcome: "stale",
      appliedRevision: 7,
    });
    expect(group.writes).toHaveLength(0);
    // The same revision again, Access unchanged: compared, nothing written.
    expect(await applyAdmission(call(7, [OWNER]), d)).toEqual({ outcome: "applied", revision: 7 });
    expect(group.writes).toHaveLength(0);
    expect((await applyAdmission(call(8, [OWNER, "bob@example.test"]), d)).outcome).toBe("applied");
  });

  it("repairs a group changed outside the team page at the applied revision", async () => {
    // The applied revision as the server object keeps it across a restart.
    const group = new FakeGroup({ name: "g", include: [emailRule(OWNER)] });
    const { deps: d, state, logs } = deps(group, 5);
    group.group = { name: "g", include: [emailRule(OWNER), emailRule("mallory@example.test")] };
    expect(await applyAdmission(call(5, [OWNER]), d)).toEqual({ outcome: "applied", revision: 5 });
    expect(group.group.include).toEqual([emailRule(OWNER)]);
    expect(logs.at(-1)).toMatchObject({ outcome: "applied", revision: 5, repaired: 1 });
    expect(state.applied).toBe(5);
    // A repair Access does not keep is not recorded either: the next push tries again.
    group.group = { name: "g", include: [] };
    group.dropNextWrite = true;
    await expect(applyAdmission(call(5, [OWNER]), d)).rejects.toThrow(AdmissionUnconfirmed);
    expect((await applyAdmission(call(5, [OWNER]), d)).outcome).toBe("applied");
    expect(group.group.include).toEqual([emailRule(OWNER)]);
  });

  it("refuses a list naming no current owner, or an owner it does not admit", async () => {
    const group = new FakeGroup({ name: "g", include: [emailRule(OWNER)] });
    const { deps: d, state } = deps(group);
    for (const refused of [
      call(1, ["alice@example.test"], []),
      call(1, ["alice@example.test"], [OWNER]),
      call(1, [OWNER, "alice@example.test"], [OWNER, SECOND_OWNER]),
    ]) {
      expect(await applyAdmission(refused, d)).toEqual({
        outcome: "refused",
        reason: "owner_missing",
      });
    }
    expect(group.writes).toHaveLength(0);
    expect(state.applied).toBeNull();
  });

  it("follows the team's current owners, not the address the installation was planned with", async () => {
    // Two owners; the founding owner is then suspended, so only the second is listed.
    const group = new FakeGroup({
      name: "g",
      include: [emailRule(OWNER), emailRule(SECOND_OWNER)],
    });
    const { deps: d, state } = deps(group, 3);
    const result = await applyAdmission(
      call(4, ["alice@example.test", SECOND_OWNER], [SECOND_OWNER]),
      d,
    );
    expect(result).toEqual({ outcome: "applied", revision: 4 });
    expect(group.group?.include).toEqual([
      emailRule("alice@example.test"),
      emailRule(SECOND_OWNER),
    ]);
    expect(state.applied).toBe(4);
  });

  it("refuses a widened group as it is, and writes one made only of addresses", async () => {
    for (const rule of [{ everyone: {} }, { email_domain: { domain: "example.test" } }]) {
      const group = new FakeGroup({ name: "g", include: [emailRule(OWNER), rule] });
      const { deps: d } = deps(group);
      expect(await applyAdmission(call(1, [OWNER]), d)).toEqual({
        outcome: "refused",
        reason: "foreign_rules",
      });
      expect(group.writes).toHaveLength(0);
    }
  });

  it("refuses a missing group or configuration", async () => {
    expect(await applyAdmission(call(1, [OWNER]), deps(new FakeGroup(undefined)).deps)).toEqual({
      outcome: "refused",
      reason: "group_missing",
    });
    expect(await applyAdmission(call(1, [OWNER]), deps(undefined).deps)).toEqual({
      outcome: "refused",
      reason: "not_configured",
    });
  });

  it("does not record a list Access did not keep, so the adapter retries", async () => {
    const group = new FakeGroup({ name: "g", include: [emailRule(OWNER)] });
    group.dropNextWrite = true;
    const { deps: d, state } = deps(group);
    await expect(applyAdmission(call(2, [OWNER, "bob@example.test"]), d)).rejects.toThrow(
      AdmissionUnconfirmed,
    );
    expect(state.applied).toBeNull();
    expect((await applyAdmission(call(2, [OWNER, "bob@example.test"]), d)).outcome).toBe("applied");
  });

  it("applies an unchanged list without writing", async () => {
    const group = new FakeGroup({ name: "g", include: [emailRule(OWNER)] });
    const { deps: d, state } = deps(group);
    expect((await applyAdmission(call(3, [OWNER]), d)).outcome).toBe("applied");
    expect(group.writes).toHaveLength(0);
    expect(state.applied).toBe(3);
  });
});

describe("the member group's API port", () => {
  function recorder(answers: Response[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    return {
      calls,
      fetcher: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answers.shift() ?? new Response("{}", { status: 500 });
      },
    };
  }
  const vars = {
    CFO_ACCESS_ACCOUNT_ID: ACCOUNT,
    CFO_ACCESS_GROUP_ID: GROUP,
    CFO_ACCESS_GROUP_TOKEN: TOKEN,
  };

  it("reads and writes exactly the recorded group, with the token only in its header", async () => {
    const r = recorder([
      Response.json({ result: { name: "g", include: [emailRule(OWNER)], exclude: [] } }),
      Response.json({ result: {} }),
    ]);
    const port = accessGroupPortFrom(vars, r.fetcher);
    if (port === undefined) throw new Error("port");
    expect(await port.read()).toEqual({
      name: "g",
      include: [emailRule(OWNER)],
      exclude: [],
      require: undefined,
    });
    await port.write({ name: "g", include: [emailRule(OWNER)], exclude: [], require: [] });
    const url = `${CLOUDFLARE_API}/accounts/${ACCOUNT}/access/groups/${GROUP}`;
    expect(r.calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", url],
      ["PUT", url],
    ]);
    for (const c of r.calls) {
      expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(String(c.init.body ?? "")).not.toContain(TOKEN);
    }
  });

  it("always calls Cloudflare's API: no setting points the token anywhere else", async () => {
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      return Response.json({ result: { name: "g", include: [] } });
    };
    const path = `/accounts/${ACCOUNT}/access/groups/${GROUP}`;
    for (const local of ["http://127.0.0.1:8787", "https://evil.example", undefined]) {
      seen.length = 0;
      const settings = { ...vars, CFO_ACCESS_API_LOCAL_ONLY: local, CFO_ACCESS_API: local };
      await accessGroupPortFrom(settings, fetcher)?.read();
      expect(seen).toEqual([`${CLOUDFLARE_API}${path}`]);
    }
  });

  it("is absent for a missing or malformed setting, so admission fails closed", () => {
    expect(accessGroupPortFrom({ ...vars, CFO_ACCESS_GROUP_ID: "../organizations" })).toBe(
      undefined,
    );
    expect(accessGroupPortFrom({ ...vars, CFO_ACCESS_ACCOUNT_ID: undefined })).toBeUndefined();
    expect(accessGroupPortFrom({ ...vars, CFO_ACCESS_GROUP_TOKEN: "" })).toBeUndefined();
  });

  it("reads a deleted group as missing and an error without the token", async () => {
    const r = recorder([new Response(null, { status: 404 }), new Response(null, { status: 403 })]);
    const port = accessGroupPortFrom(vars, r.fetcher);
    expect(await port?.read()).toBeUndefined();
    const failure = await port?.read().catch((error: Error) => error);
    expect(String(failure)).toContain("403");
    expect(String(failure)).not.toContain(TOKEN);
  });
});

describe("the admission route", () => {
  const secret = new TextEncoder().encode("k".repeat(32));
  const keys: SigningKeys = { current: { id: "key-1", secret }, previous: null };
  const NOW = 1_800_000_000;

  async function hmacHex(message: string): Promise<string> {
    const k = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function signed(body: string, sign: (sha: string) => string, timestamp = NOW) {
    return new Request(`http://platform.internal${ADMISSION_PATH}`, {
      method: "POST",
      body,
      headers: {
        "X-Omnigent-Signing-Key-Id": "key-1",
        "X-Omnigent-Timestamp": String(timestamp),
        "X-Omnigent-Signature": await hmacHex(
          sign(await sha256Hex(new TextEncoder().encode(body))),
        ),
      },
    });
  }

  function route(answer: AccessAdmissionResult | Error) {
    const admitted: AccessAdmissionCall[] = [];
    return {
      admitted,
      handle: (request: Request) =>
        handleAdmissionRequest(request, {
          keys,
          nowSeconds: () => NOW,
          admit: async (c) => {
            admitted.push(c);
            if (answer instanceof Error) throw answer;
            return answer;
          },
          log: () => undefined,
        }),
    };
  }

  const body = JSON.stringify({ emails: [OWNER], owners: [OWNER], revision: 3 });
  const admission = (sha: string) =>
    admissionStringToSign({ keyId: "key-1", timestamp: String(NOW), bodySha256: sha });

  it("applies a call the server signed for admission", async () => {
    const r = route({ outcome: "applied", revision: 3 });
    const response = await r.handle(await signed(body, admission));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "applied", revision: 3 });
    expect(r.admitted).toEqual([{ emails: [OWNER], owners: [OWNER], revision: 3 }]);
  });

  it("refuses a launcher signature over the same body, and a stale one", async () => {
    const r = route({ outcome: "applied", revision: 3 });
    const launcher = (sha: string) =>
      launcherStringToSign({
        operation: "access",
        keyId: "key-1",
        timestamp: String(NOW),
        bodySha256: sha,
      });
    expect((await r.handle(await signed(body, launcher))).status).toBe(401);
    const old = (sha: string) =>
      admissionStringToSign({ keyId: "key-1", timestamp: String(NOW - 600), bodySha256: sha });
    expect((await r.handle(await signed(body, old, NOW - 600))).status).toBe(401);
    expect(r.admitted).toHaveLength(0);
  });

  it("refuses a body that is not an admission list", async () => {
    const r = route({ outcome: "applied", revision: 3 });
    const bad = JSON.stringify({ revision: 3, emails: ["*"], groupId: "another" });
    expect((await r.handle(await signed(bad, admission))).status).toBe(400);
    expect(r.admitted).toHaveLength(0);
  });

  it("answers a refusal 409 and an unconfirmed write 503", async () => {
    const refused = route({ outcome: "refused", reason: "owner_missing" });
    expect((await refused.handle(await signed(body, admission))).status).toBe(409);
    const lost = route(new AdmissionUnconfirmed("not kept"));
    expect((await lost.handle(await signed(body, admission))).status).toBe(503);
  });
});

describe("the admission route's refusals", () => {
  const secret = new TextEncoder().encode("k".repeat(32));
  const previous = new TextEncoder().encode("p".repeat(32));
  const keys: SigningKeys = {
    current: { id: "key-2", secret },
    previous: { id: "key-1", secret: previous },
  };
  const NOW = 1_800_000_000;
  const logs: [string, Readonly<Record<string, unknown>>][] = [];
  const handle = (request: Request, withKeys: SigningKeys | null = keys) =>
    handleAdmissionRequest(request, {
      keys: withKeys,
      nowSeconds: () => NOW,
      admit: async (c) => ({ outcome: "applied", revision: c.revision }),
      log: (event, fields) => logs.push([event, fields]),
    });
  async function signedWith(
    keyId: string,
    key: Uint8Array,
    body: BodyInit,
    bytes: Uint8Array,
  ): Promise<Request> {
    const k = await crypto.subtle.importKey(
      "raw",
      key as Uint8Array<ArrayBuffer>,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const message = admissionStringToSign({
      keyId,
      timestamp: String(NOW),
      bodySha256: await sha256Hex(bytes),
    });
    const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
    return new Request(`http://platform.internal${ADMISSION_PATH}`, {
      method: "POST",
      body,
      headers: {
        "X-Omnigent-Signing-Key-Id": keyId,
        "X-Omnigent-Timestamp": String(NOW),
        "X-Omnigent-Signature": [...new Uint8Array(mac)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      },
    });
  }

  it("knows its one path", () => {
    expect(isAdmissionPath(ADMISSION_PATH)).toBe(true);
    expect(isAdmissionPath(`${ADMISSION_PATH}/x`)).toBe(false);
  });

  it("refuses another path or method, and everything without keys", async () => {
    const url = `http://platform.internal${ADMISSION_PATH}`;
    expect((await handle(new Request("http://platform.internal/access/v1/other"))).status).toBe(
      404,
    );
    expect((await handle(new Request(url))).status).toBe(400);
    expect((await handle(new Request(url, { method: "POST", body: "{}" }), null)).status).toBe(503);
    expect((await handle(new Request(url, { method: "POST", body: "{}" }))).status).toBe(401);
  });

  it("accepts the previous key during a rotation, and refuses an unknown one", async () => {
    const text = JSON.stringify({ emails: [OWNER], owners: [OWNER], revision: 1 });
    const bytes = new TextEncoder().encode(text);
    expect((await handle(await signedWith("key-1", previous, text, bytes))).status).toBe(200);
    expect((await handle(await signedWith("key-9", previous, text, bytes))).status).toBe(401);
  });

  it("refuses a body that is not JSON or too large", async () => {
    const notJson = "not json";
    expect(
      (await handle(await signedWith("key-2", secret, notJson, new TextEncoder().encode(notJson))))
        .status,
    ).toBe(400);
    const huge = "x".repeat(MAX_ADMISSION_BODY_BYTES + 1);
    expect(
      (await handle(await signedWith("key-2", secret, huge, new TextEncoder().encode(huge))))
        .status,
    ).toBe(400);
    expect(logs.some(([, fields]) => JSON.stringify(fields).includes(OWNER))).toBe(false);
  });
});

describe("the member group's API port with the global fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the Worker's own fetch by default", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return new Response(null, { status: 404 });
    });
    const port = accessGroupPortFrom({
      CFO_ACCESS_ACCOUNT_ID: ACCOUNT,
      CFO_ACCESS_GROUP_ID: GROUP,
      CFO_ACCESS_GROUP_TOKEN: TOKEN,
    });
    expect(await port?.read()).toBeUndefined();
    expect(seen).toEqual([`${CLOUDFLARE_API}/accounts/${ACCOUNT}/access/groups/${GROUP}`]);
  });

  it("refuses a group answer without its rules, and a failed write", async () => {
    const answers = [Response.json({ result: { name: "g" } }), new Response(null, { status: 409 })];
    const port = accessGroupPortFrom(
      { CFO_ACCESS_ACCOUNT_ID: ACCOUNT, CFO_ACCESS_GROUP_ID: GROUP, CFO_ACCESS_GROUP_TOKEN: TOKEN },
      async () => answers.shift() ?? new Response(null, { status: 500 }),
    );
    await expect(port?.read()).rejects.toThrow("502");
    await expect(port?.write({ name: "g", include: [] })).rejects.toThrow("409");
  });
});
