// OmnigentServer and teams (WP8.3), in workerd with a fake server container: the identity
// envelope it adds to a forwarded request when `CFO_IDENTITY_ENVELOPE` is on (and never by
// default), the client headers it strips, the page-person platform call, the admission route's
// revision kept across evictions, and the web Worker's pages in members admission asking it.
import {
  createExecutionContext,
  evictAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  EXTERNAL_IDENTITY_HEADER,
  FORWARDED_PERSON_HEADER,
  type ForwardedPerson,
  PAGE_PERSON_CALL_PATH,
  type PagePersonResult,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import { envelopeKey, signEnvelope } from "../../src/server/identity-envelope.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { FORWARD_VERSION_HEADER, OMNIGENT_SERVER_INTERFACE_VERSION } from "../../src/shared/rpc.ts";
import { routeAdmitted } from "../../src/web.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const ORIGIN = "https://omnigent.example.test";
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
const COOKIE_SECRET = "c".repeat(64);
const DURABLE = { accounts_enabled: true, needs_setup: false, enabled_connections: [] };
const ALICE: ForwardedPerson = {
  issuer: "https://example-team.cloudflareaccess.com",
  subject: "alice-sub",
  audience: "aud-tag",
  email: "alice@example.test",
  installationOwner: false,
  expiresAt: 4_000_000_000,
};

let serial = 0;
type Stub = DurableObjectStub<OmnigentServer>;

beforeEach(() => {
  testServers.clock.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
});

async function runningServer(
  vars: Record<string, string | null> = {},
): Promise<{ stub: Stub; fake: FakeServerContainer }> {
  const stub = env.OMNIGENT.getByName(`team-${++serial}`) as Stub;
  testServers.release(stub.id, {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
    ...vars,
  });
  const fake = testServers.create(stub.id);
  fake.info = DURABLE;
  await stub.bootstrapStatus(call);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const at = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  testServers.clock.advance(Math.max(0, (at as number) - testServers.clock.now()));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  return { stub, fake };
}

async function forward(stub: Stub, headers: Record<string, string>): Promise<void> {
  const response = await stub.fetch(
    new Request(`${ORIGIN}/v1/me`, {
      headers: { [FORWARD_VERSION_HEADER]: "1", ...headers },
      redirect: "manual",
    }),
  );
  await response.arrayBuffer();
}

function lastHeaders(fake: FakeServerContainer): Record<string, string> {
  return fake.forwarded().at(-1)?.headers ?? {};
}

describe("OmnigentServer: the identity envelope", () => {
  it("adds none by default: a team of one is forwarded exactly as before", async () => {
    const { stub, fake } = await runningServer();
    await forward(stub, { [FORWARDED_PERSON_HEADER]: JSON.stringify(ALICE) });
    const sent = lastHeaders(fake);
    expect(sent[EXTERNAL_IDENTITY_HEADER]).toBeUndefined();
    expect(sent[FORWARDED_PERSON_HEADER]).toBeUndefined();
  });

  it("signs the web Worker's person when on, verifiable with the derived key", async () => {
    const { stub, fake } = await runningServer({ CFO_IDENTITY_ENVELOPE: "on" });
    await forward(stub, { [FORWARDED_PERSON_HEADER]: JSON.stringify(ALICE) });
    const envelope = lastHeaders(fake)[EXTERNAL_IDENTITY_HEADER];
    expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [, payload] = (envelope ?? "").split(".");
    const claims = JSON.parse(atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims).toMatchObject({ sub: "alice-sub", iss: ALICE.issuer, owner: false });
    // The same claims signed with the key derived from the cookie secret give the same token.
    const resigned = await signEnvelope(ALICE, await envelopeKey(COOKIE_SECRET), claims.iat);
    expect(resigned).toBe(envelope);
    expect(lastHeaders(fake)[FORWARDED_PERSON_HEADER]).toBeUndefined();
  });

  it("never passes on an envelope or a malformed person a client sent", async () => {
    const { stub, fake } = await runningServer({ CFO_IDENTITY_ENVELOPE: "on" });
    await forward(stub, {
      [EXTERNAL_IDENTITY_HEADER]: "v1.forged.forged",
      [FORWARDED_PERSON_HEADER]: '{"subject":"bob"}',
    });
    expect(lastHeaders(fake)[EXTERNAL_IDENTITY_HEADER]).toBeUndefined();
    // No person (the computer route's case): no envelope either.
    await forward(stub, {});
    expect(lastHeaders(fake)[EXTERNAL_IDENTITY_HEADER]).toBeUndefined();
  });
});

describe("OmnigentServer: page person and admission", () => {
  it("asks the server with a signed call and answers its member, or unsupported", async () => {
    const { stub, fake } = await runningServer();
    const member = {
      action: "member",
      memberId: "0123456789abcdef0123456789abcdef",
      userId: "alice",
      role: "member",
      state: "active",
    };
    const answer = (person: () => Response) => (_port: number, request: Request) =>
      new URL(request.url).pathname === PAGE_PERSON_CALL_PATH
        ? person()
        : Response.json({ path: new URL(request.url).pathname });
    fake.handler = answer(() => Response.json(member));
    const asked = { ...call, issuer: ALICE.issuer, subject: "alice-sub", audience: "aud-tag" };
    // Without an installation owner configured, nobody is named it.
    expect(await stub.pagePerson(asked)).toEqual({ ...member, installationOwner: false });
    const sent = fake.forwarded().find((r) => r.url.endsWith(PAGE_PERSON_CALL_PATH));
    expect(sent?.headers["x-cfo-call-signature"]).toMatch(/^[0-9a-f]{64}$/);
    fake.handler = answer(() => new Response("{}", { status: 404 }));
    expect(await stub.pagePerson(asked)).toEqual({ action: "unsupported" });
  });

  it("keeps the applied admission revision across evictions, so a late push is stale", async () => {
    const { stub } = await runningServer();
    // Without the group's settings nothing is written, and the refusal says why.
    expect(await stub.admission({ revision: 2, emails: [], owners: [] })).toEqual({
      outcome: "refused",
      reason: "not_configured",
    });
    await runInDurableObject(stub, (_i: OmnigentServer, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)",
        "access_admission_applied",
        "5",
      );
    });
    await evictDurableObject(stub);
    // Not configured is checked first; the applied revision survives for when it is.
    const kept = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
      state.storage.sql
        .exec<{ value: string }>(
          "SELECT value FROM server_state WHERE key = ?",
          "access_admission_applied",
        )
        .toArray(),
    );
    expect(kept).toEqual([{ value: "5" }]);
  });
});

describe("the web Worker's pages in members admission, through OmnigentServer", () => {
  it("decide each person by membership, and name the installation's owner from the platform", async () => {
    const { stub, fake } = await runningServer({
      SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
    });
    const member = (userId: string, role: "owner" | "admin" | "member") => ({
      action: "member",
      memberId: "0123456789abcdef0123456789abcdef",
      userId,
      role,
      state: "active",
    });
    // The server container's answers, by Access subject. Bob's claims to be the installation's
    // owner: OmnigentServer decides that itself.
    let answers: Record<string, PagePersonResult> = {
      "owner-sub": member("owner", "owner") as PagePersonResult,
      "bob-sub": { ...member("bob", "owner"), installationOwner: true } as PagePersonResult,
      "alice-sub": member("alice", "member") as PagePersonResult,
    };
    fake.handler = async (_port: number, request: Request) => {
      if (new URL(request.url).pathname !== PAGE_PERSON_CALL_PATH) {
        return Response.json({ path: new URL(request.url).pathname });
      }
      const { subject } = (await request.json()) as { subject: string };
      return Response.json(answers[subject] ?? { action: "none" });
    };
    const call = (subject: string) =>
      stub.pagePerson({ interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION, ...person(subject) });
    const person = (subject: string) => ({
      issuer: ALICE.issuer,
      subject,
      audience: ALICE.audience,
    });
    expect(await call("owner-sub")).toMatchObject({ userId: "owner", installationOwner: true });
    expect(await call("bob-sub")).toMatchObject({ userId: "bob", installationOwner: false });
    expect(await call("alice-sub")).toMatchObject({ userId: "alice", installationOwner: false });

    const webEnv = { OMNIGENT: { getByName: () => stub } } as unknown as WebEnv;
    const at = (path: string, subject: string): Admitted => ({
      ok: true,
      identity: {
        ...person(subject),
        sub: subject,
        email: `${subject.slice(0, -4)}@example.test`,
        pin: subject === "owner-sub",
        sessionId: "e".repeat(64),
        issuedAt: 1,
        expiresAt: 2,
      },
      request: new Request(`${ORIGIN}${path}`),
      origin: ORIGIN,
      admission: "members",
    });
    // Each answer's body is read, so no stream outlives the test.
    const status = async (path: string, subject: string) => {
      const response = await routeAdmitted(at(path, subject), webEnv, createExecutionContext());
      await response.arrayBuffer();
      return response.status;
    };
    // Every active member reaches the pages; WorkspaceDO decides per computer (ownership tests).
    for (const subject of ["owner-sub", "bob-sub", "alice-sub"]) {
      expect(await status("/platform/", subject), subject).toBe(303);
    }
    // The owner's own pages are the installation owner's alone, whatever the container claims.
    expect(await status("/platform/github", "bob-sub")).toBe(404);
    expect(await status("/platform/github", "alice-sub")).toBe(404);
    expect(await status("/platform/github", "owner-sub")).not.toBe(404);
    // An unbound identity and a suspended member are refused; Omnigent is still theirs to reach.
    expect(await status("/platform/", "stranger-sub")).toBe(403);
    answers = {
      ...answers,
      "alice-sub": { ...answers["alice-sub"], state: "suspended" } as PagePersonResult,
    };
    expect(await status("/platform/", "alice-sub")).toBe(403);
    expect(await status("/v1/me", "alice-sub")).toBe(200);
  });
});
