// Teams behind Access (WP8.3): ingress's admission modes, the person the forwarding path passes
// on, the pages' guard in `members` admission, and the membership-aware person seam. Each
// forbidden case sits next to its allowed neighbour; a team of one on today's defaults behaves
// as before.

import {
  EXTERNAL_IDENTITY_HEADER,
  FORWARDED_PERSON_HEADER,
  ForwardedPerson,
  type PagePersonCall,
  type PagePersonResult,
} from "@cfo/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import {
  type Admitted,
  createIngress,
  type IngressConfig,
  type OwnerIdentity,
  parseIngressEnv,
} from "../../src/ingress/index.ts";
import { RateLimiter } from "../../src/ingress/limits.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { bindingsPagePersonBackend, memberSeam } from "../../src/pages/member-seam.ts";
import { forwardToServer } from "../../src/server/forward.ts";
import { forwardedPersonOf, proxyToOmnigent } from "../../src/server/proxy.ts";
import { routeAdmitted } from "../../src/web.ts";
import {
  AUD,
  claims,
  HOST,
  ISSUER,
  makeKey,
  OWNER_EMAIL,
  OWNER_SUB,
  SALT,
  sign,
  staticKeys,
  TEAM,
  type TestKey,
} from "../support/access-keys.ts";

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const ORIGIN = `https://${HOST}`;
const ALICE_SUB = "00000000-0000-4000-8000-00000000a11c";

let key: TestKey;
let pin: string;

beforeAll(async () => {
  key = await makeKey("kid-current");
  pin = await makeOwnerPin(OWNER_EMAIL, SALT);
});

function config(admission?: string): IngressConfig {
  const parsed = parseIngressEnv({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: pin,
    ...(admission === undefined ? {} : { TEAM_ADMISSION: admission }),
  });
  if (parsed === undefined) throw new Error("test configuration did not parse");
  return parsed;
}

async function admit(cfg: IngressConfig, payload: Record<string, unknown>) {
  const ingress = createIngress(cfg, {
    keys: staticKeys([key]),
    limiter: new RateLimiter(() => NOW_MS),
    nowMs: () => NOW_MS,
    log: () => undefined,
  });
  const assertion = await sign(key, payload);
  return ingress.admit(
    new Request(`${ORIGIN}/v1/me`, { headers: { "cf-access-jwt-assertion": assertion } }),
  );
}

const alice = (now: number) =>
  claims(now, { sub: ALICE_SUB, email: "Alice@Example.Invalid", identity_nonce: "n" });

describe("ingress admission", () => {
  it("defaults to the owner alone, and anything unrecognised means the owner alone", () => {
    expect(config().admission).toBe("owner");
    expect(config("everyone").admission).toBe("owner");
    expect(config("members").admission).toBe("members");
  });

  it("refuses Alice in owner admission and admits the owner, as before teams", async () => {
    const refused = await admit(config(), alice(NOW));
    expect(refused.ok ? "admitted" : refused.reason).toBe("not_owner");
    const owner = await admit(config(), claims(NOW));
    expect(owner.ok).toBe(true);
    if (owner.ok) expect(owner.identity.pin).toBe(true);
  });

  it("admits Alice in members admission, marked as not the owner, with her claims", async () => {
    const result = await admit(config("members"), alice(NOW));
    if (!result.ok) throw new Error(result.reason);
    expect(result.identity).toMatchObject({
      sub: ALICE_SUB,
      issuer: ISSUER,
      audience: AUD,
      email: "alice@example.invalid",
      pin: false,
    });
    const owner = await admit(config("members"), claims(NOW));
    if (!owner.ok) throw new Error(owner.reason);
    expect(owner.identity.pin).toBe(true);
  });

  it("still refuses a bad assertion in members admission", async () => {
    const expired = await admit(config("members"), alice(NOW - 3600));
    expect(expired.ok ? "admitted" : expired.reason).toBe("expired");
    const foreign = await admit(config("members"), { ...alice(NOW), aud: ["b".repeat(64)] });
    expect(foreign.ok ? "admitted" : foreign.reason).toBe("wrong_audience");
  });
});

function identity(overrides: Partial<OwnerIdentity> = {}): OwnerIdentity {
  return {
    sub: ALICE_SUB,
    issuer: ISSUER,
    audience: AUD,
    email: "alice@example.invalid",
    pin: false,
    sessionId: "e".repeat(64),
    issuedAt: NOW - 10,
    expiresAt: NOW + 600,
    ...overrides,
  };
}

function recordingBinding() {
  const seen: Request[] = [];
  return {
    seen,
    binding: {
      getByName: () => ({
        fetch: async (request: Request) => {
          seen.push(request);
          return new Response("ok");
        },
      }),
    },
  };
}

describe("the forwarded person", () => {
  it("names the Access identity and whether it is the owner", () => {
    const person = forwardedPersonOf(identity());
    expect(ForwardedPerson.parse(person)).toEqual({
      issuer: ISSUER,
      subject: ALICE_SUB,
      audience: AUD,
      email: "alice@example.invalid",
      installationOwner: false,
      expiresAt: NOW + 600,
    });
    expect(forwardedPersonOf(identity({ pin: true }))?.installationOwner).toBe(true);
    // An identity built without its claims is never forwarded as a person.
    const { issuer: _issuer, ...withoutIssuer } = identity();
    expect(forwardedPersonOf(withoutIssuer)).toBeUndefined();
  });

  it("replaces whatever a client sent and is the only person header the server gets", async () => {
    const { seen, binding } = recordingBinding();
    const forged = new Request(`${ORIGIN}/v1/me`, {
      headers: {
        [FORWARDED_PERSON_HEADER]: JSON.stringify({ subject: "bob" }),
        [EXTERNAL_IDENTITY_HEADER]: "v1.forged.forged",
      },
    });
    await forwardToServer(forged, binding, forwardedPersonOf(identity()));
    const sent = seen[0];
    expect(sent?.headers.get(EXTERNAL_IDENTITY_HEADER)).toBeNull();
    expect(JSON.parse(sent?.headers.get(FORWARDED_PERSON_HEADER) ?? "{}").subject).toBe(ALICE_SUB);
    await forwardToServer(forged, binding);
    expect(seen[1]?.headers.get(FORWARDED_PERSON_HEADER)).toBeNull();
  });

  it("goes with every request the web Worker forwards", async () => {
    const { seen, binding } = recordingBinding();
    const admitted: Admitted = {
      ok: true,
      identity: identity(),
      request: new Request(`${ORIGIN}/v1/sessions`),
      origin: ORIGIN,
    };
    await proxyToOmnigent(admitted, { OMNIGENT: binding });
    expect(seen[0]?.headers.get(FORWARDED_PERSON_HEADER)).toContain(ALICE_SUB);
  });
});

describe("the pages in members admission", () => {
  it("are refused to anyone but the owner until the person seam is wired", async () => {
    const { seen, binding } = recordingBinding();
    const env = { OMNIGENT: binding } as unknown as WebEnv;
    const ctx = {} as ExecutionContext;
    const at = (path: string, pinned: boolean): Admitted => ({
      ok: true,
      identity: identity({ pin: pinned }),
      request: new Request(`${ORIGIN}${path}`),
      origin: ORIGIN,
    });
    const refused = await routeAdmitted(at("/platform/computers", false), env, ctx);
    expect(refused.status).toBe(403);
    expect(seen).toHaveLength(0);
    // Omnigent itself is reached, with the person for the server to bind.
    const forwarded = await routeAdmitted(at("/v1/me", false), env, ctx);
    expect(forwarded.status).toBe(200);
    expect(seen[0]?.headers.get(FORWARDED_PERSON_HEADER)).toContain('"installationOwner":false');
  });
});

describe("the member seam", () => {
  function backend(answer: PagePersonResult | Error) {
    const calls: PagePersonCall[] = [];
    return {
      calls,
      pagePerson: async (call: PagePersonCall) => {
        calls.push(call);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }
  const admitted = (overrides: Partial<OwnerIdentity> = {}): Admitted => ({
    ok: true,
    identity: identity(overrides),
    request: new Request(`${ORIGIN}/platform/computers`),
    origin: ORIGIN,
  });
  const active: PagePersonResult = {
    action: "member",
    memberId: "0123456789abcdef0123456789abcdef",
    userId: "alice",
    role: "member",
    state: "active",
  };

  it("answers the pinned owner without asking the server", async () => {
    const b = backend(new Error("must not be called"));
    expect(await memberSeam(b)(admitted({ pin: true, sub: OWNER_SUB }))).toEqual({
      kind: "installation_owner",
    });
    expect(b.calls).toHaveLength(0);
  });

  it("answers Alice as her own active membership, asked by her own identity", async () => {
    const b = backend(active);
    expect(await memberSeam(b)(admitted())).toEqual({
      kind: "member",
      memberId: active.memberId,
      userId: "alice",
      role: "member",
    });
    expect(b.calls[0]).toMatchObject({ issuer: ISSUER, subject: ALICE_SUB, audience: AUD });
  });

  it.each<[string, PagePersonResult | Error]>([
    ["suspended", { ...active, state: "suspended" } as PagePersonResult],
    ["unbound", { action: "none" }],
    ["an Omnigent without teams", { action: "unsupported" }],
    ["a server that does not answer", { action: "unavailable" }],
    ["an RPC error", new TypeError("no such method")],
  ])("refuses %s", async (_name, answer) => {
    expect(await memberSeam(backend(answer))(admitted())).toBeNull();
  });

  it("refuses an identity without its claims", async () => {
    const { issuer: _issuer, ...withoutIssuer } = identity();
    const bare: Admitted = { ...admitted(), identity: withoutIssuer };
    expect(await memberSeam(backend(active))(bare)).toBeNull();
  });
});

describe("the member seam's binding", () => {
  it("asks OmnigentServer's singleton object", async () => {
    const names: string[] = [];
    const answer: PagePersonResult = { action: "none" };
    const backend = bindingsPagePersonBackend({
      OMNIGENT: {
        getByName: (name: string) => {
          names.push(name);
          return { pagePerson: async () => answer };
        },
      },
    });
    const logged: Readonly<Record<string, string>>[] = [];
    const seam = memberSeam(backend, (fields) => logged.push(fields));
    const admitted: Admitted = {
      ok: true,
      identity: identity(),
      request: new Request(`${ORIGIN}/platform/computers`),
      origin: ORIGIN,
    };
    expect(await seam(admitted)).toBeNull();
    expect(names).toEqual(["omnigent-server"]);
    expect(logged).toEqual([{ event: "page_person", outcome: "none" }]);
  });
});
