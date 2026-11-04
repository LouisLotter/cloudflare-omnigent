// WP8.4 (D50) in the Workers runtime: a computer bound to its owner through the assembled chain.
// The launcher's signed version 2 calls reach `platform.internal` (the real HMAC receiver), the
// real ControlDO and the real WorkspaceDO; the credential bundle goes through the real fenced
// gateway into local R2. WorkspaceDO is evicted after each persisted transition. Only the
// container and the clocks are simulated.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { PagePerson, PagePersonResult } from "@cfo/contracts";
import {
  type ComputerId,
  type LauncherOwner,
  signLauncherRequest,
  TERMINAL_SUBPROTOCOL,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ComputerRecord,
  NO_OWNERSHIP,
  OWNERSHIP_KEY,
  OwnershipRecord,
  RECORD_KEY,
} from "../../src/computer/record.ts";
import {
  type WorkspaceDO as ProductionWorkspaceDO,
  SqlStore,
} from "../../src/computer/WorkspaceDO.ts";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import { routePlatform } from "../../src/pages/router.ts";
import { workspaceObjectName } from "../../src/shared/rpc.ts";
import { routeAdmitted } from "../../src/web.ts";
import {
  alarm,
  type Computer,
  LAUNCHER_KEY,
  LAUNCHER_KEY_ID,
  launcherApi,
  roomyControl,
  settle,
  sleep,
  type WorkspaceStub,
  wake,
} from "../support/assembled.ts";
import { assembly } from "../support/assembly-harness.ts";
import { FakeLauncherClient, signedHttpTransport } from "../support/fake-launcher-client.ts";
import type { WorkspaceDO } from "../support/platform-test-worker.ts";

const TOKEN = "cfo-canary-launch-token-ownership-0123456789";
const TEAM = "9f8e7d6c5b4a49382716f5e4d3c2b1a0";
const ALICE_MEMBER = "0a1b2c3d4e5f40718293a4b5c6d7e8f9";
const BOB_MEMBER = "1b2c3d4e5f60718293a4b5c6d7e8f90a";
/** wrangler.test.jsonc's installation owner (`SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME`). */
const FOUNDER = "owner-canary";

const bucket = () => (env as unknown as { CHECKPOINTS: R2Bucket }).CHECKPOINTS;

beforeAll(() => roomyControl());
afterEach(() => roomyControl());

let serial = 0;
function newHost(): string {
  serial += 1;
  return `${serial.toString(16).padStart(8, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

const transport = () =>
  signedHttpTransport({
    fetch: launcherApi(),
    key: new TextEncoder().encode(LAUNCHER_KEY),
    keyId: LAUNCHER_KEY_ID,
  });

/** Provisions a computer as Omnigent names it, `managed-<host ID>`, for `owner` (or none). */
async function provisionFor(
  host: string,
  owner: LauncherOwner | undefined,
): Promise<Computer & { readonly host: string }> {
  const t = transport();
  const bootstrap = new FakeLauncherClient("", t);
  bootstrap.owner = owner;
  const operationId = crypto.randomUUID().replaceAll("-", "");
  const result = await bootstrap.send(bootstrap.provisionRequest(`managed-${host}`, operationId));
  if (result.operation !== "provision") throw new Error("provision");
  const computerId = result.computerId as ComputerId;
  const namespace = env.WORKSPACE as unknown as DurableObjectNamespace<WorkspaceDO>;
  const stub = namespace.getByName(workspaceObjectName(computerId)) as WorkspaceStub;
  const client = new FakeLauncherClient(computerId, t);
  client.owner = owner;
  return { computerId, stub, container: assembly.container(computerId), client, host };
}

/** The computer's record and its ownership, as stored. */
async function record(
  stub: WorkspaceStub,
): Promise<ComputerRecord & { readonly ownership: OwnershipRecord }> {
  return runInDurableObject(stub, (_i: ProductionWorkspaceDO, state) => {
    const store = new SqlStore(state.storage);
    const ownership = store.get(OWNERSHIP_KEY);
    return {
      ...ComputerRecord.parse(store.get(RECORD_KEY)),
      ownership: ownership === undefined ? NO_OWNERSHIP : OwnershipRecord.parse(ownership),
    };
  });
}

/** The launcher's raw answer for a request, as the server's launcher sees it over HTTP. */
async function refusal(c: Computer, request: Parameters<FakeLauncherClient["send"]>[0]) {
  return c.client.refusal(request);
}

describe("a computer bound to its owner through the assembled chain (T3, T15)", () => {
  it("binds at provisioning, survives evictions, refuses Bob at every call and serves Alice", async () => {
    const host = newHost();
    const alice: LauncherOwner = {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    };
    const bob: LauncherOwner = { userId: "bob", memberId: BOB_MEMBER, teamId: TEAM, hostId: host };
    const c = await provisionFor(host, alice);
    await evictDurableObject(c.stub);
    expect((await record(c.stub)).ownership.binding).toMatchObject({ ...alice, how: "provision" });
    await wake(c, { hostId: host, token: TOKEN });
    await evictDurableObject(c.stub);

    const asBob = new FakeLauncherClient(c.computerId, transport());
    asBob.owner = bob;
    const before = JSON.stringify(await record(c.stub));
    for (const request of [
      asBob.statusRequest(),
      asBob.admissionRequest(),
      asBob.keepAliveRequest(),
      asBob.resumeRequest(),
      asBob.claimRequest(),
      asBob.startRequest({ attempt: 1, token: TOKEN, hostId: host }),
      asBob.checkpointRequest(),
      asBob.suspendRequest(),
      asBob.terminateRequest(),
    ]) {
      expect(await asBob.refusal(request), request.operation).toBe("forbidden");
      await evictDurableObject(c.stub);
    }
    expect(JSON.stringify(await record(c.stub))).toBe(before);
    // Bob's provision under Alice's name gets her computer's refusal, not her computer.
    const bobProvision = new FakeLauncherClient("", transport());
    bobProvision.owner = bob;
    expect(await bobProvision.refusal(bobProvision.provisionRequest(`managed-${host}`))).toBe(
      "forbidden",
    );
    // The allowed neighbours, from Alice, on a fresh instance.
    expect(await c.client.send(c.client.statusRequest())).toMatchObject({ status: "host_running" });
    expect(await refusal(c, c.client.keepAliveRequest())).toBeUndefined();
    expect(await sleep(c)).toEqual({ operation: "suspend", outcome: "stopped" });
  });

  it("answers a forbidden call over HTTP as the launcher's readable refusal, with no state in it", async () => {
    const host = newHost();
    const alice: LauncherOwner = {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    };
    const c = await provisionFor(host, alice);
    const bob = new FakeLauncherClient(c.computerId, async () => {
      throw new Error("unused");
    });
    bob.owner = { ...alice, userId: "bob", memberId: BOB_MEMBER };
    const body = new TextEncoder().encode(JSON.stringify(bob.statusRequest()));
    const headers = await signLauncherRequest({
      key: new TextEncoder().encode(LAUNCHER_KEY),
      keyId: LAUNCHER_KEY_ID,
      operation: "status",
      timestamp: Math.floor(Date.now() / 1000),
      body,
    });
    const response = await launcherApi()(
      new Request("http://platform.internal/launcher/status", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden",
        message: "This computer belongs to someone else.",
        retryable: false,
      },
    });
  });

  it("adopts a computer recorded before owners for the installation's owner, and keeps it from others", async () => {
    const host = newHost();
    const c = await provisionFor(host, undefined);
    await wake(c, { hostId: host, token: TOKEN });
    await evictDurableObject(c.stub);
    expect((await record(c.stub)).ownership.binding).toBeNull();
    const alice = new FakeLauncherClient(c.computerId, transport());
    alice.owner = { userId: "alice", memberId: ALICE_MEMBER, teamId: TEAM, hostId: host };
    expect(await alice.refusal(alice.statusRequest())).toBe("forbidden");
    expect((await record(c.stub)).ownership.binding).toBeNull();
    c.client.owner = { userId: FOUNDER, memberId: null, teamId: null, hostId: host };
    expect(await c.client.send(c.client.keepAliveRequest())).toMatchObject({ renewed: true });
    await evictDurableObject(c.stub);
    expect((await record(c.stub)).ownership.binding).toMatchObject({
      userId: FOUNDER,
      how: "adopted",
    });
    // A version 1 call still acts for the installation's owner (a rollback).
    const v1 = new FakeLauncherClient(c.computerId, transport());
    expect(await v1.refusal(v1.statusRequest())).toBeUndefined();
  });

  it("stamps the credential bundle in R2 with the owner and the generation, at its existing key", async () => {
    const host = newHost();
    const alice: LauncherOwner = {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    };
    const c = await provisionFor(host, alice);
    await wake(c, { hostId: host, token: TOKEN });
    c.container.sim.sup?.signIn("claude");
    await settle(c);
    const r = await record(c.stub);
    expect(r.ownership.credential).toEqual({
      checkpointId: r.credential?.checkpointId,
      generation: r.credential?.generation,
      owner: r.ownership.binding,
    });
    const key = r.credential?.object.key ?? "";
    expect(key).toMatch(new RegExp(`^credentials/${c.computerId}/ckp_`));
    const head = await bucket().head(key);
    expect(head?.customMetadata).toEqual({
      "cfo-computer": c.computerId,
      "cfo-generation": "1",
      "cfo-owner": `member:${ALICE_MEMBER}`,
    });
    expect(JSON.stringify(head?.customMetadata)).not.toContain("alice");
  });
});

// ---------------------------------------------------------------------------------------------
// The pages through the real web Worker routes and WorkspaceDO (T3, T13), with the person seam
// answering for Alice, Bob and Carol (an administrator) as WP8.3's will. WorkspaceDO is evicted
// before the pages are used; not between page requests, whose stubs this isolate still holds (the
// eviction would wait on them, as in assembled-pages.test.ts). The launcher tests above evict
// after each persisted transition.

const ORIGIN = "https://omnigent.example.test";
const webEnv = {
  OMNIGENT: env.OMNIGENT,
  WORKSPACE: env.WORKSPACE,
  CONTROL: env.CONTROL,
} as unknown as WebEnv;

const PEOPLE = {
  alice: { kind: "member", memberId: ALICE_MEMBER, userId: "alice", role: "member" },
  bob: { kind: "member", memberId: BOB_MEMBER, userId: "bob", role: "member" },
  carol: {
    kind: "member",
    memberId: "2c3d4e5f60718293a4b5c6d7e8f90a1b",
    userId: "carol",
    role: "admin",
  },
} as const satisfies Record<string, PagePerson>;
type Who = keyof typeof PEOPLE;
const SESSIONS: Record<Who, string> = {
  alice: "a1".repeat(32),
  bob: "b2".repeat(32),
  carol: "c3".repeat(32),
};

function routeAs(who: Who, path: string, init: RequestInit = {}): Promise<Response> {
  const admitted: Admitted = {
    ok: true,
    request: new Request(`${ORIGIN}${path}`, init),
    origin: ORIGIN,
    identity: { sub: `${who}-sub`, sessionId: SESSIONS[who], issuedAt: 1, expiresAt: 2 },
  };
  return routePlatform(admitted, webEnv, {
    person: async () => PEOPLE[who],
    assets: async () => ({}),
  });
}

const post = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/** A page's status, its body read so no request is left open. */
async function statusAs(who: Who, path: string, init: RequestInit = {}): Promise<number> {
  const response = await routeAs(who, path, init);
  await response.text();
  return response.status;
}

async function intentOn(who: Who, path: string): Promise<string | null> {
  const html = await (await routeAs(who, path)).text();
  const match =
    /data-intent="([0-9a-f]{64})"/.exec(html) ?? /name="intent" value="([0-9a-f]{64})"/.exec(html);
  return match?.[1] ?? null;
}

describe("a computer's pages through the real routes and WorkspaceDO (T3, T13)", () => {
  it("shows Alice her computer, hides it from Bob, and gives Carol the fleet view and the stop", async () => {
    const host = newHost();
    const alice: LauncherOwner = {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    };
    const c = await provisionFor(host, alice);
    await wake(c, { hostId: host, token: TOKEN });
    const page = `/platform/computers/${c.computerId}`;
    await evictDurableObject(c.stub);

    // Alice: her setup page, its token, its status.
    expect(await statusAs("alice", page)).toBe(200);
    expect(await intentOn("alice", page)).toMatch(/^[0-9a-f]{64}$/);
    expect(await statusAs("alice", `${page}/status`)).toBe(200);
    expect(await (await routeAs("alice", "/platform/computers")).text()).toContain(
      `data-computer="${c.computerId}"`,
    );

    // Bob: not listed, not found, no token; a change with a token of his own making: not found.
    expect(await (await routeAs("bob", "/platform/computers")).text()).not.toContain(c.computerId);
    for (const path of [page, `${page}/state`, `${page}/status`, `${page}/do/restart`]) {
      expect(await statusAs("bob", path), path).toBe(404);
    }
    expect(
      await statusAs(
        "bob",
        `${page}/do/restart`,
        post({ intent: "0".repeat(64), op: "op_01hzy4a7b8c9d0e1f2g3h4j5k6" }),
      ),
    ).toBe(404);

    // Carol: the fleet card, never the setup page; the stop.
    const list = await (await routeAs("carol", "/platform/computers")).text();
    expect(list).toContain(`data-fleet-computer="${c.computerId}"`);
    expect(list).toContain("Belongs to alice");
    expect(await statusAs("carol", page)).toBe(404);
    expect(await statusAs("carol", `${page}/status`)).toBe(403);
    // Not offered to an administrator: 409, a page without the form.
    const setSize = await routeAs("carol", `${page}/do/set-size`);
    expect(setSize.status).toBe(409);
    const notOffered = await setSize.text();
    expect(notOffered).toContain('data-confirm="not-offered"');
    expect(notOffered).not.toContain("<form");
    // Alice's token is hers: Carol presenting it is refused, and nothing stops.
    const alicesToken = (await intentOn("alice", page)) as string;
    expect(
      await statusAs(
        "carol",
        `${page}/do/restart`,
        post({ intent: alicesToken, op: "op_01hzy4a7b8c9d0e1f2g3h4j5k7" }),
      ),
    ).toBe(403);
    expect((await record(c.stub)).lifecycle.context.state).toBe("host_running");
    const carols = (await intentOn("carol", `${page}/do/restart`)) as string;
    const stopped = await routeAs(
      "carol",
      `${page}/do/restart`,
      post({ intent: carols, op: "op_01hzy4a7b8c9d0e1f2g3h4j5k8" }),
    );
    await stopped.text();
    expect(stopped.status).toBe(303);
    // Back to the list, whose notice names it a stop (WP8.10).
    expect(stopped.headers.get("location")).toBe(
      "/platform/computers?done=restart&outcome=accepted&as=admin",
    );
    await settle(c);
    expect((await record(c.stub)).lifecycle.context.state).not.toBe("host_running");
  }, 60_000);

  it("lets Carol finish a removed member's computer without her, and never Bob", async () => {
    const host = newHost();
    const alice: LauncherOwner = {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    };
    const c = await provisionFor(host, alice);
    await wake(c, { hostId: host, token: TOKEN });
    c.container.sim.sup?.signIn("claude");
    c.container.sim.sup?.signIn("codex");
    await settle(c);
    // Omnigent removes Alice: her account is gone, so its terminate names her without a member.
    c.client.owner = { ...alice, memberId: null, teamId: null };
    expect(await c.client.send(c.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "pending",
    });
    await evictDurableObject(c.stub);
    for (
      let i = 0;
      i < 6 && (await record(c.stub)).lifecycle.context.state !== "removal_pending";
      i++
    ) {
      await alarm(c, 30_000);
    }
    expect((await record(c.stub)).lifecycle.context.state).toBe("removal_pending");
    await evictDurableObject(c.stub);
    const page = `/platform/computers/${c.computerId}`;
    const unsigned = `${page}/do/delete-without-sign-out`;

    // Never tried: Carol signs out first; deleting without one is not offered yet.
    let list = await (await routeAs("carol", "/platform/computers")).text();
    expect(list).toContain(`href="${page}/do/sign-out"`);
    expect(list).not.toContain(unsigned);
    expect(await statusAs("carol", unsigned)).toBe(409);
    // Bob learns nothing at any step.
    expect(await (await routeAs("bob", "/platform/computers")).text()).not.toContain(c.computerId);
    expect(await statusAs("bob", unsigned)).toBe(404);

    // Carol's sign-out runs and fails (a CLI's logout leaves its login).
    c.container.sim.supervisorOptions = { staggeredLogouts: true, failedLogout: "codex" };
    const signOut = await routeAs(
      "carol",
      `${page}/do/sign-out`,
      post({
        intent: (await intentOn("carol", `${page}/do/sign-out`)) as string,
        op: "op_01hzy4a7b8c9d0e1f2g3h4j5m1",
      }),
    );
    await signOut.text();
    expect(signOut.headers.get("location")).toBe(
      "/platform/computers?done=sign-out&outcome=accepted",
    );
    for (let i = 0; i < 60; i++) {
      const r = await record(c.stub);
      if (r.signOut.job === null && r.lifecycle.context.state === "removal_pending" && i > 0) break;
      await alarm(c, 5_000);
    }
    const tried = await record(c.stub);
    expect(tried.signOut).toMatchObject({ phase: "none", job: null });
    expect(tried.lifecycle.context.state).toBe("removal_pending");

    // Now offered to Carol, saying the sessions are not revoked; still nothing for Bob.
    list = await (await routeAs("carol", "/platform/computers")).text();
    expect(list).toContain(`href="${unsigned}"`);
    const confirm = await routeAs("carol", unsigned);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("The provider sessions are not revoked.");
    expect(await statusAs("bob", unsigned)).toBe(404);
    expect(
      await statusAs(
        "bob",
        unsigned,
        post({ intent: "0".repeat(64), op: "op_01hzy4a7b8c9d0e1f2g3h4j5m2" }),
      ),
    ).toBe(404);
    const deleted = await routeAs(
      "carol",
      unsigned,
      post({
        intent: (await intentOn("carol", unsigned)) as string,
        op: "op_01hzy4a7b8c9d0e1f2g3h4j5m3",
      }),
    );
    await deleted.text();
    expect(deleted.headers.get("location")).toBe(
      "/platform/computers?done=delete-without-sign-out&outcome=accepted",
    );
    const credentialKey = tried.credential?.object.key ?? "";
    expect(credentialKey).not.toBe("");
    for (let i = 0; i < 20 && (await record(c.stub)).lifecycle.context.state !== "removed"; i++) {
      await alarm(c, 30_000);
    }
    const removed = await record(c.stub);
    expect(removed.lifecycle.context.state).toBe("removed");
    expect(removed.credential).toBeNull();
    expect(await bucket().head(credentialKey)).toBeNull();
    expect(await (await routeAs("carol", "/platform/computers")).text()).not.toContain(
      `data-fleet-computer="${c.computerId}"`,
    );
  }, 120_000);

  it("refuses Bob's and Carol's terminal upgrades before the capability is looked at", async () => {
    const host = newHost();
    const alice: LauncherOwner = {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    };
    const c = await provisionFor(host, alice);
    await wake(c, { hostId: host, token: TOKEN });
    const upgrade = (who: Who) =>
      c.stub.fetch(
        new Request("https://workspace/", {
          headers: {
            upgrade: "websocket",
            "x-cfo-terminal": JSON.stringify({
              interfaceVersion: 1,
              computerId: c.computerId,
              owner: { sub: `${who}-sub`, sessionId: SESSIONS[who], person: PEOPLE[who] },
              capability: "A".repeat(43),
            }),
          },
        }),
      );
    expect((await upgrade("bob")).status).toBe(404);
    expect((await upgrade("carol")).status).toBe(404);
    expect((await upgrade("alice")).status).toBe(403); // hers: the unknown capability is refused
  });
});

// ---------------------------------------------------------------------------------------------
// WP8.3 with WP8.4: in members admission the web Worker's own route decides the person through the
// membership seam (`pages/member-seam.ts`), asking OmnigentServer which member each Access
// identity is bound to; WorkspaceDO then decides per computer as above. OmnigentServer's answer
// is simulated here (its own tests run it with the server container); the routes, the seam, the
// router and WorkspaceDO are the real ones.

describe("the pages in members admission, through the web Worker's route (WP8.3)", () => {
  const MEMBERS: Record<string, PagePersonResult> = {
    "alice-sub": {
      action: "member",
      memberId: ALICE_MEMBER,
      userId: "alice",
      role: "member",
      state: "active",
    },
    "bob-sub": {
      action: "member",
      memberId: BOB_MEMBER,
      userId: "bob",
      role: "member",
      state: "active",
    },
    "carol-sub": {
      action: "member",
      memberId: PEOPLE.carol.memberId,
      userId: "carol",
      role: "admin",
      state: "active",
    },
  };
  let answers = { ...MEMBERS };
  const membersEnv = {
    OMNIGENT: {
      getByName: () => ({
        pagePerson: async ({ subject }: { subject: string }) =>
          answers[subject] ?? { action: "none" },
      }),
    },
    WORKSPACE: env.WORKSPACE,
    CONTROL: env.CONTROL,
  } as unknown as WebEnv;

  async function statusOf(subject: string, path: string): Promise<[number, string]> {
    const admitted: Admitted = {
      ok: true,
      request: new Request(`${ORIGIN}${path}`),
      origin: ORIGIN,
      admission: "members",
      identity: {
        sub: subject,
        issuer: "https://team.cloudflareaccess.com",
        audience: "a".repeat(64),
        email: `${subject.slice(0, -4)}@example.test`,
        pin: false,
        sessionId: "d4".repeat(32),
        issuedAt: 1,
        expiresAt: 2,
      },
    };
    const response = await routeAdmitted(admitted, membersEnv, {} as ExecutionContext);
    return [response.status, await response.text()];
  }

  it("shows a member her own computer, hides it from another, and gives an admin the fleet view", async () => {
    answers = { ...MEMBERS };
    const host = newHost();
    const c = await provisionFor(host, {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    });
    await wake(c, { hostId: host, token: TOKEN });
    const page = `/platform/computers/${c.computerId}`;

    const [aliceList, aliceListed] = await statusOf("alice-sub", "/platform/computers");
    expect(aliceList).toBe(200);
    expect(aliceListed).toContain(`data-computer="${c.computerId}"`);
    expect((await statusOf("alice-sub", page))[0]).toBe(200);

    const [, bobListed] = await statusOf("bob-sub", "/platform/computers");
    expect(bobListed).not.toContain(c.computerId);
    expect((await statusOf("bob-sub", page))[0]).toBe(404);

    const [, carolListed] = await statusOf("carol-sub", "/platform/computers");
    expect(carolListed).toContain(`data-fleet-computer="${c.computerId}"`);
    expect((await statusOf("carol-sub", page))[0]).toBe(404);

    // Nobody but the installation's owner reaches the owner's own pages: the others are told
    // where their own password is changed, with no form (WP8.10).
    for (const subject of ["alice-sub", "carol-sub"]) {
      const [status, body] = await statusOf(subject, "/platform/password");
      expect(status).toBe(200);
      expect(body).toContain("data-member-password");
      expect(body).not.toContain("<form");
    }

    // Suspended, or bound to nobody: no page at all.
    answers = {
      ...MEMBERS,
      "alice-sub": { ...MEMBERS["alice-sub"], state: "suspended" } as PagePersonResult,
    };
    expect((await statusOf("alice-sub", "/platform/computers"))[0]).toBe(403);
    expect((await statusOf("alice-sub", page))[0]).toBe(403);
    expect((await statusOf("stranger-sub", "/platform/computers"))[0]).toBe(403);
    await settle(c);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Codex WP8.4 r1-1: a refused launcher call changes nothing, the setup terminal included. The
// owner check runs before the page front's hooks (a `terminate` closes the terminal, a sleep
// closes an expired window), through the signed launcher endpoint, with an open window, a
// connected stream and an issued capability not yet used.

describe("a refused launcher call leaves the owner's terminal alone (Codex r1-1)", () => {
  /** A fake ttyd on the computer's terminal port: each dial gets an open shell. */
  function fakeTtyd(c: Computer): void {
    c.container.sim.terminal = () => {
      const pair = new WebSocketPair();
      pair[1].accept();
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "sec-websocket-protocol": TERMINAL_SUBPROTOCOL },
      });
    };
  }

  async function terminalAs(who: Who, page: string, body: Record<string, string>) {
    const response = await routeAs(who, `${page}/terminal`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as { outcome?: string; capability?: string; window?: number };
  }

  /** The browser's end of a bridged stream, and whether it has closed. */
  async function stream(page: string, capability: string) {
    const response = await routeAs("alice", `${page}/terminal`, {
      headers: {
        upgrade: "websocket",
        origin: ORIGIN,
        "sec-websocket-protocol": `${TERMINAL_SUBPROTOCOL}, cfo-capability.${capability}`,
      },
    });
    const socket = response.webSocket;
    if (socket === null) return { status: response.status, closed: () => true, close: () => {} };
    socket.accept();
    let closed = false;
    socket.addEventListener("close", () => {
      closed = true;
    });
    return {
      status: response.status,
      closed: () => closed,
      close: () => {
        try {
          socket.close(1000, "test over");
        } catch {
          // already closed
        }
      },
    };
  }

  const aliceOwner = {
    sub: "alice-sub",
    sessionId: SESSIONS.alice,
    person: PEOPLE.alice,
  };

  /** What a refused call must leave as it was: the record, its ownership and the terminal. */
  async function observed(c: Computer) {
    const state = (await c.stub.pages({
      action: "state",
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      owner: aliceOwner,
    })) as { computer: { terminal?: unknown } };
    return JSON.stringify([await record(c.stub), state.computer.terminal]);
  }

  it("refuses Bob's and an owner-less call's terminate and suspend without touching the window, its streams or its capabilities; Alice's terminate closes them", async () => {
    const host = newHost();
    const alice: LauncherOwner = {
      userId: "alice",
      memberId: ALICE_MEMBER,
      teamId: TEAM,
      hostId: host,
    };
    const c = await provisionFor(host, alice);
    await wake(c, { hostId: host, token: TOKEN });
    fakeTtyd(c);
    const page = `/platform/computers/${c.computerId}`;
    const intent = (await intentOn("alice", page)) as string;
    const opened = await terminalAs("alice", page, {
      op: "op_01hzy4a7b8c9d0e1f2g3h4j5k6",
      intent,
      mode: "open",
    });
    expect(opened.outcome).toBe("accepted");
    const connected = await stream(page, opened.capability as string);
    expect(connected.status).toBe(101);
    // A second capability for the same window, issued and not yet used (a reconnect's).
    const issued = await terminalAs("alice", page, {
      op: "op_01hzy4a7b8c9d0e1f2g3h4j5k7",
      intent,
      mode: "reconnect",
      window: String(opened.window),
    });
    expect(issued.outcome).toBe("accepted");
    await settle(c);
    const before = await observed(c);
    expect(before).toContain('"open":true');

    const bob = new FakeLauncherClient(c.computerId, transport());
    bob.owner = { ...alice, userId: "bob", memberId: BOB_MEMBER };
    const ownerless = new FakeLauncherClient(c.computerId, transport());
    for (const [who, client] of [
      ["bob", bob],
      ["owner-less version 1", ownerless],
    ] as const) {
      expect(await client.refusal(client.terminateRequest()), `${who} terminate`).toBe("forbidden");
      expect(await client.refusal(client.suspendRequest()), `${who} suspend`).toBe("forbidden");
    }
    await settle(c);
    expect(await observed(c)).toBe(before);
    expect(connected.closed()).toBe(false);
    // The capability issued before the refusals still opens a stream.
    const reconnected = await stream(page, issued.capability as string);
    expect(reconnected.status).toBe(101);

    // The allowed neighbour: Alice's own terminate closes the window and every stream in it.
    expect(await c.client.send(c.client.terminateRequest())).toMatchObject({ removal: "pending" });
    await settle(c);
    const after = (await c.stub.pages({
      action: "state",
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      owner: aliceOwner,
    })) as { computer: { terminal?: { open: boolean; streams: number } } };
    expect(after.computer.terminal).toMatchObject({ open: false, streams: 0 });
    for (let i = 0; i < 200 && !(connected.closed() && reconnected.closed()); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(connected.closed()).toBe(true);
    expect(reconnected.closed()).toBe(true);
    connected.close();
    reconnected.close();
  }, 60_000);
});
