// WP8.4 (D50) in the Workers runtime: a computer bound to its owner through the assembled chain.
// The launcher's signed version 2 calls reach `platform.internal` (the real HMAC receiver), the
// real ControlDO and the real WorkspaceDO; the credential bundle goes through the real fenced
// gateway into local R2. WorkspaceDO is evicted after each persisted transition. Only the
// container and the clocks are simulated.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type ComputerId, type LauncherOwner, signLauncherRequest } from "@cfo/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ComputerRecord, RECORD_KEY } from "../../src/computer/record.ts";
import {
  type WorkspaceDO as ProductionWorkspaceDO,
  SqlStore,
} from "../../src/computer/WorkspaceDO.ts";
import { workspaceObjectName } from "../../src/shared/rpc.ts";
import {
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

async function record(stub: WorkspaceStub): Promise<ComputerRecord> {
  return runInDurableObject(stub, (_i: ProductionWorkspaceDO, state) =>
    ComputerRecord.parse(new SqlStore(state.storage).get(RECORD_KEY)),
  );
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
    expect((await record(c.stub)).owner).toMatchObject({ ...alice, how: "provision" });
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
    expect((await record(c.stub)).owner).toBeNull();
    const alice = new FakeLauncherClient(c.computerId, transport());
    alice.owner = { userId: "alice", memberId: ALICE_MEMBER, teamId: TEAM, hostId: host };
    expect(await alice.refusal(alice.statusRequest())).toBe("forbidden");
    expect((await record(c.stub)).owner).toBeNull();
    c.client.owner = { userId: FOUNDER, memberId: null, teamId: null, hostId: host };
    expect(await c.client.send(c.client.keepAliveRequest())).toMatchObject({ renewed: true });
    await evictDurableObject(c.stub);
    expect((await record(c.stub)).owner).toMatchObject({ userId: FOUNDER, how: "adopted" });
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
    expect(r.credentialOwner).toEqual(r.owner);
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
