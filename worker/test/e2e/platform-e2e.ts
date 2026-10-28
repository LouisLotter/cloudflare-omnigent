/**
 * The platform Worker as the local journeys run it (WP3.5, `wrangler dev`, never deployed): the
 * production WorkspaceDO and ControlDO, with a simulated computer per WorkspaceDO whose terminal
 * port runs the fake shell (`fake-shell.ts`), an in-memory checkpoint bucket, and an
 * OmnigentServer whose outage records and replication health the scenario sets. A pump delivers
 * the fake supervisor's messages to its WorkspaceDO, as the computer API would.
 *
 * `POST /__e2e/seed` creates the journeys' computers through the real launcher and computer
 * calls, and answers their IDs. Only `web-e2e.ts` forwards to it, and only in this harness.
 */
import {
  ComputerCall,
  type ComputerId,
  type ControlCall,
  type ControlResult,
  type OutageRecord,
  type ReplicationHealth,
  type SupervisorMessage,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { CONTROLLER_TIMING, type ControllerTiming } from "../../src/computer/controller.ts";
import { WorkspaceDO as PlatformWorkspaceDO } from "../../src/computer/WorkspaceDO.ts";
import { ControlDO as PlatformControlDO } from "../../src/control/ControlDO.ts";
import type { PlatformEnv } from "../../src/env.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../src/server/OmnigentServer.ts";
import { CONTROL_OBJECT_NAME, type OmnigentServerCall } from "../../src/shared/rpc.ts";
import { HOST } from "../support/computer-sim.ts";
import { FakeBucket } from "../support/fake-bucket.ts";
import { FakeLauncherClient, rpcTransport } from "../support/fake-launcher-client.ts";
import { FakeServerContainer } from "../support/fake-server-container.ts";
import { SimulatedComputer } from "../support/fake-supervisor.ts";
import { fakeTtyd } from "./fake-shell.ts";

const call = { interfaceVersion: WORKSPACE_INTERFACE_VERSION };
const bucket = new FakeBucket();
const computers = new Map<string, SimulatedComputer>();
/** Computers whose "no contact" time is short, so they show as not connected to Omnigent. */
const lostContact = new Set<string>();
/** WP3.23: computers with an older supervisor (no page sign-in), on a staging installation, or
 * whose next capture fails (the list's "last save failed" badge). */
const legacy = new Set<string>();
const staging = new Set<string>();
const failingSaves = new Set<string>();
const scenario: { outages: OutageRecord[]; replication: ReplicationHealth } = {
  outages: [],
  replication: { state: "replicating", lastSyncAt: null, checkedAt: new Date().toISOString() },
};

export class WorkspaceDO extends PlatformWorkspaceDO {
  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    setInterval(() => void this.e2eSettle().catch(() => undefined), 200);
  }

  protected override openPort() {
    const id = this.ctx.id.toString();
    let computer = computers.get(id);
    if (computer === undefined) {
      const name = this.ctx.id.name ?? "cmp_unnamed";
      computer = new SimulatedComputer(name as ComputerId);
      computer.supervisorOptions = {
        legacy: legacy.has(name),
        failCaptures: failingSaves.has(name) ? 1 : 0,
      };
      const simulated = computer;
      computer.terminal = fakeTtyd({ onSignIn: (provider) => simulated.sup?.signIn(provider) });
      computers.set(id, computer);
    }
    return computer;
  }

  protected override checkpointBucket() {
    return bucket;
  }

  protected override intercepts(props: Parameters<PlatformWorkspaceDO["intercepts"]>[0]) {
    return [{ host: "computer.internal", target: { props } as unknown as Fetcher }];
  }

  protected override stagingChecks(): boolean {
    return staging.has(this.ctx.id.name ?? "");
  }

  protected override timing(): ControllerTiming {
    return lostContact.has(this.ctx.id.name ?? "")
      ? { ...CONTROLLER_TIMING, noContactMs: 1_000 }
      : CONTROLLER_TIMING;
  }

  /** Delivers the fake supervisor's messages through the computer API, until it is quiet. */
  async e2eSettle(): Promise<void> {
    const computer = computers.get(this.ctx.id.toString());
    for (let i = 0; i < 10; i += 1) {
      await this.controller.idle();
      const sup = computer?.sup ?? null;
      if (sup === null) return;
      // The supervisor's periodic report, which carries the CLIs' login status for the cards.
      if (sup.outbox.length === 0) sup.report();
      await sup.flush((message: SupervisorMessage) =>
        this.computer({
          ...call,
          props: {
            propsVersion: 1,
            computerId: sup.computerId,
            generation: message.generation,
            hostId: HOST,
          },
          message,
        }).catch((error: unknown) => {
          const parsed = ComputerCall.safeParse({
            ...call,
            props: {
              propsVersion: 1,
              computerId: sup.computerId,
              generation: message.generation,
              hostId: HOST,
            },
            message,
          });
          console.warn(
            `e2e: ${message.type} not delivered: ${String(error)} ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 600)}`,
          );
          throw error;
        }),
      );
      if (sup.outbox.length === 0) return;
    }
  }

  async e2eSignIn(provider: "claude" | "codex"): Promise<void> {
    computers.get(this.ctx.id.toString())?.sup?.signIn(provider);
    await this.e2eSettle();
  }

  /** What the provider's page would show the person for the running attempt (WP3.23). */
  async e2eIssued(service: "claude" | "codex") {
    return computers.get(this.ctx.id.toString())?.sup?.issued[service] ?? null;
  }

  /** Codex: the person entered the code at OpenAI. */
  async e2eApprove(): Promise<void> {
    computers.get(this.ctx.id.toString())?.sup?.approve("codex");
    await this.e2eSettle();
  }

  /** The sign-in starts the computer received, and every sign-in value issued (for scans). */
  async e2eSignIns() {
    const sups = computers.get(this.ctx.id.toString())?.supervisors ?? [];
    return {
      starts: sups.flatMap((s) => s.commands).filter((c) => c.type === "sign_in_start").length,
      issued: sups.flatMap((s) => s.issuedValues),
    };
  }
}

export class ControlDO extends PlatformControlDO {}

export class OmnigentServer extends PlatformOmnigentServer {
  protected override openContainer() {
    const fake = new FakeServerContainer();
    fake.running = true;
    return fake as never;
  }

  override async outages(): Promise<OutageRecord[]> {
    return scenario.outages;
  }

  override async replication(_call: OmnigentServerCall): Promise<ReplicationHealth> {
    return scenario.replication;
  }

  /** Omnigent's own interface, faked: the pages link to it. */
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    return new Response(`<!doctype html><title>Omnigent (fake)</title><h1>Omnigent: ${path}</h1>`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

type Env = PlatformEnv & {
  readonly WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  readonly CONTROL: DurableObjectNamespace<ControlDO>;
};

/** The e2e WorkspaceDO's methods, as the seeding route calls them. */
interface E2eStub {
  launcher: WorkspaceDO["launcher"];
  e2eSettle(): Promise<void>;
  e2eSignIn(provider: "claude" | "codex"): Promise<void>;
  e2eIssued: WorkspaceDO["e2eIssued"];
  e2eApprove(): Promise<void>;
  e2eSignIns: WorkspaceDO["e2eSignIns"];
}

async function create(env: Env, name: string) {
  const control = env.CONTROL.getByName(CONTROL_OBJECT_NAME);
  const registered = (await control.control({
    method: "register_computer",
    interfaceVersion: 1,
    operationId: `op_${name
      .padEnd(26, "0")
      .slice(0, 26)
      .replace(/[^0-9a-hjkmnp-tv-z]/g, "0")}`,
    name,
  } as ControlCall)) as ControlResult;
  if (registered.method !== "register_computer") throw new Error("register");
  const computerId = registered.computerId as ComputerId;
  const stub = env.WORKSPACE.getByName(computerId) as unknown as E2eStub;
  const client = new FakeLauncherClient(computerId, rpcTransport(stub));
  return { computerId, stub, client };
}

async function seed(env: Env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of [
    "managed-new",
    "managed-ready",
    "managed-lost",
    "managed-deleted",
    "managed-pagesignin",
    "managed-older",
    "managed-staging",
  ]) {
    const { computerId, stub, client } = await create(env, name);
    if (name === "managed-lost") lostContact.add(computerId);
    if (name === "managed-older") legacy.add(computerId);
    if (name === "managed-staging") {
      staging.add(computerId);
      failingSaves.add(computerId);
    }
    await client.send(client.provisionRequest(name));
    await client.wake({ hostId: HOST, token: `synthetic-launch-token-canary-e2e-${name}` });
    await stub.e2eSettle();
    if (name !== "managed-new") {
      await stub.e2eSignIn("claude");
      await stub.e2eSignIn("codex");
    }
    if (name === "managed-deleted") {
      await client.send(client.terminateRequest());
      for (let i = 0; i < 20; i += 1) await stub.e2eSettle();
    }
    if (name === "managed-staging") {
      // Its first save fails: the list's "last save failed" badge, and the status's saves.
      await client.send(client.checkpointRequest());
      for (let i = 0; i < 20; i += 1) await stub.e2eSettle();
    }
    out[name] = computerId;
  }
  scenario.outages = [
    {
      outageId: "out_01hzy4a7b8c9d0e1f2g3h4j5k6",
      cause: "not_answering",
      startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      detectedAt: new Date(Date.now() - 3 * 3_600_000 + 30_000).toISOString(),
      endedAt: new Date(Date.now() - 3 * 3_600_000 + 720_000).toISOString(),
      restarts: 1,
    },
  ];
  scenario.replication = {
    state: "lagging",
    lastSyncAt: new Date(Date.now() - 300_000).toISOString(),
    checkedAt: new Date().toISOString(),
  };
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__e2e/seed") {
      return Response.json({ computers: await seed(env) });
    }
    const id = url.searchParams.get("computer");
    if (request.method === "GET" && url.pathname === "/__e2e/state" && id !== null) {
      const stub = env.WORKSPACE.getByName(id);
      return Response.json(await stub.pages({ ...call, action: "state" }));
    }
    // WP3.23: the provider's side of a sign-in, played by the journeys.
    const service = url.searchParams.get("service") === "codex" ? "codex" : "claude";
    if (request.method === "GET" && url.pathname === "/__e2e/issued" && id !== null) {
      const stub = env.WORKSPACE.getByName(id) as unknown as E2eStub;
      return Response.json(await stub.e2eIssued(service));
    }
    if (request.method === "POST" && url.pathname === "/__e2e/approve" && id !== null) {
      const stub = env.WORKSPACE.getByName(id) as unknown as E2eStub;
      await stub.e2eApprove();
      return Response.json({ approved: true });
    }
    if (request.method === "GET" && url.pathname === "/__e2e/sign-ins" && id !== null) {
      const stub = env.WORKSPACE.getByName(id) as unknown as E2eStub;
      return Response.json(await stub.e2eSignIns());
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
