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
  FORWARDED_PERSON_HEADER,
  type LauncherOwner,
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
import { OWNER_SUB } from "../support/access-keys.ts";
import { HOST } from "../support/computer-sim.ts";
import { FakeBucket } from "../support/fake-bucket.ts";
import { FakeLauncherClient, rpcTransport } from "../support/fake-launcher-client.ts";
import { FakeServerContainer } from "../support/fake-server-container.ts";
import { SimulatedComputer } from "../support/fake-supervisor.ts";
import { fakeTtyd } from "./fake-shell.ts";
import {
  ASLEEP_HOST,
  FULL_HOST,
  FULL_REASON,
  MEMBER_ACCOUNT,
  MEMBER_HOST,
  MEMBER_ID,
  MEMBER_SUB,
  MEMBER_TEAM,
  OMNIGENT_SESSION_COOKIE,
  OTHER_SUB,
  OTHERS_HOST,
} from "./wake-hosts.ts";

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
/** WP3.53: a computer's Omnigent host, where it is not the shared HOST. */
const hostIds = new Map<string, string>();
const hostIdOf = (computerId: string) => hostIds.get(computerId) ?? HOST;
/**
 * WP8.15: the owner Omnigent names on every launcher call for a computer bound to a team member
 * (protocol version 2); the others are the installation owner's, named by none (version 1).
 */
const owners = new Map<string, LauncherOwner>();
/**
 * The fake Omnigent's persistent hosts (WP3.53): whose each is, its computer, the reason its wake
 * fails with (null: it wakes), its `persistent_status`, and the `POST …/start` calls it answered.
 */
interface FakeHost {
  readonly computerId: string;
  readonly owner: string;
  /** WP8.15: who else may wake it, as the fork's `may_manage_host` allows a team administrator. */
  readonly admins: readonly string[];
  readonly fail: string | null;
  state: "asleep" | "waking" | "awake" | "failed";
  failure: string | null;
  starts: number;
  requests: number;
}
const omnigentHosts = new Map<string, FakeHost>();

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
        // Its saves keep failing: the list's badge stays.
        failCaptures: failingSaves.has(name) ? 1_000 : 0,
      };
      const simulated = computer;
      computer.terminal = fakeTtyd({
        onSignIn: (provider) => simulated.sup?.signIn(provider),
        // WP3.28: the shells are kept per window, as tmux keeps them on a real computer.
        sessions: simulated.terminalSessions,
      });
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
            hostId: hostIdOf(sup.computerId),
          },
          message,
        }).catch((error: unknown) => {
          const parsed = ComputerCall.safeParse({
            ...call,
            props: {
              propsVersion: 1,
              computerId: sup.computerId,
              generation: message.generation,
              hostId: hostIdOf(sup.computerId),
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

  /**
   * The setup terminal's sessions on the computer, and the `terminal_end` commands it received
   * (WP3.28).
   */
  async e2eTerminals() {
    const computer = computers.get(this.ctx.id.toString());
    const commands = (computer?.supervisors ?? []).flatMap((s) => s.commands);
    return {
      sessions: [...(computer?.terminalSessions.sessions.keys() ?? [])],
      ends: commands.filter((c) => c.type === "terminal_end").length,
    };
  }

  /** The computer's supervisor ends every terminal session, as its reaper would (WP3.28). */
  async e2eEndTerminals(): Promise<void> {
    computers.get(this.ctx.id.toString())?.terminalSessions.endAll();
  }

  /**
   * Resets this object, as a platform shutdown or a deploy's switch does: its memory and every
   * socket it holds are gone; storage and the computer are not (FH-38, WP3.28).
   */
  async e2eReset(): Promise<void> {
    try {
      this.ctx.abort("e2e reset");
    } catch {
      // abort() throws in the calling request by design
    }
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

  /**
   * Omnigent's own interface, faked: the pages link to it, and the setup page wakes a computer
   * with its `POST /v1/hosts/{id}/start` (WP3.53).
   */
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const host = /^\/v1\/hosts\/([0-9a-f]{32})(\/start)?$/.exec(path);
    if (host !== null) {
      return fakeOmnigentHost(
        this.env as Env,
        this.ctx,
        request,
        host[1] ?? "",
        host[2] !== undefined,
      );
    }
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
  e2eTerminals: WorkspaceDO["e2eTerminals"];
  e2eEndTerminals(): Promise<void>;
  e2eReset(): Promise<void>;
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
  client.owner = owners.get(name);
  return { computerId, stub, client };
}

/**
 * A launcher client for `computerId` in the calling context (WP3.53): a stub made in one request
 * cannot be used from another, so each call gets its own. `fresh` gives a request a new operation
 * ID, as Omnigent mints them (`uuid.uuid4().hex`), so no call repeats an earlier one's ID and
 * gets that call's recorded answer back.
 */
function clientOf(env: Env, computerId: string): FakeLauncherClient {
  const stub = env.WORKSPACE.getByName(computerId) as unknown as E2eStub;
  const client = new FakeLauncherClient(computerId as ComputerId, rpcTransport(stub));
  client.owner = owners.get(computerId);
  return client;
}
const fresh = <T extends { operationId: string }>(request: T): T => ({
  ...request,
  operationId: crypto.randomUUID().replaceAll("-", ""),
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The wake journeys' computers (WP3.53): each one's Omnigent host, its owner, how a wake ends. */
const WAKE_HOSTS: Readonly<
  Record<
    string,
    {
      readonly hostId: string;
      readonly owner: string;
      readonly admins?: readonly string[];
      readonly fail: string | null;
    }
  >
> = {
  "managed-asleep": { hostId: ASLEEP_HOST, owner: OWNER_SUB, fail: null },
  "managed-full": { hostId: FULL_HOST, owner: OWNER_SUB, fail: FULL_REASON },
  "managed-others": { hostId: OTHERS_HOST, owner: OTHER_SUB, fail: null },
  // WP8.15: a member's computer, which the owner (an administrator) may wake.
  "managed-member": { hostId: MEMBER_HOST, owner: MEMBER_SUB, admins: [OWNER_SUB], fail: null },
};

/**
 * The fake Omnigent's `GET /v1/hosts/{id}` and `POST …/start` (WP3.53), with Omnigent's own
 * checks in its order: the person's Omnigent session (401), the host (404), the host's owner
 * (`resolve_host_owner`: 403). The person is the one the platform forwarded, so a call from the
 * owner's browser for someone else's host is refused. A start answers 202 while the wake runs,
 * as Omnigent's does.
 */
async function fakeOmnigentHost(
  env: Env,
  ctx: DurableObjectState,
  request: Request,
  hostId: string,
  start: boolean,
): Promise<Response> {
  const host = omnigentHosts.get(hostId);
  // Every request that reaches Omnigent for the host, refused or not: a cross-origin one never does.
  if (host !== undefined) host.requests += 1;
  const cookies = request.headers.get("cookie") ?? "";
  if (!new RegExp(`(?:^|;\\s*)${OMNIGENT_SESSION_COOKIE}=`).test(cookies)) {
    return Response.json({ detail: "Not authenticated" }, { status: 401 });
  }
  if (host === undefined) return Response.json({ detail: "host not found" }, { status: 404 });
  let person: { subject?: unknown } | null = null;
  try {
    person = JSON.parse(request.headers.get(FORWARDED_PERSON_HEADER) ?? "null");
  } catch {
    person = null;
  }
  const subject = person?.subject;
  if (subject !== host.owner && !host.admins.includes(subject as string)) {
    return Response.json({ detail: "not your host" }, { status: 403 });
  }
  const payload = () => ({
    host_id: hostId,
    persistent_status: {
      state: host.state,
      failure: host.failure,
      wake_stage: host.state === "waking" ? "starting" : null,
    },
  });
  if (!start) {
    return request.method === "GET"
      ? Response.json(payload())
      : new Response(null, { status: 405 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  host.starts += 1;
  if (host.state !== "waking" && host.state !== "awake") {
    host.state = "waking";
    host.failure = null;
    ctx.waitUntil(wakeFakeHost(env, hostId, host));
  }
  return Response.json(payload(), { status: 202 });
}

/**
 * Omnigent's wake of a persistent host (`_bring_up_typed`), through the real launcher calls:
 * `stopped` is resumed, a parked status is claimed and started, until the host runs. A host whose
 * wake fails ends `failed` with its reason, as Omnigent records it.
 */
async function wakeFakeHost(env: Env, hostId: string, host: FakeHost): Promise<void> {
  if (host.fail !== null) {
    await pause(1_500);
    host.state = "failed";
    host.failure = host.fail;
    return;
  }
  const stub = env.WORKSPACE.getByName(host.computerId) as unknown as E2eStub;
  const client = clientOf(env, host.computerId);
  try {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      const status = await client.send(fresh(client.statusRequest()));
      if (status.operation !== "status") throw new Error("status");
      if (status.status === "host_running") {
        host.state = "awake";
        return;
      }
      if (status.status === "stopped") await client.send(fresh(client.resumeRequest()));
      else if (["started_no_host", "start_claimed", "host_refused"].includes(status.status)) {
        const claim = await client.send(fresh(client.claimRequest()));
        if (claim.operation === "claim_start" && claim.granted) {
          await client.send(
            fresh(
              client.startRequest({
                attempt: claim.startAttempt,
                token: `synthetic-launch-token-canary-e2e-wake-${hostId.slice(0, 4)}`,
                hostId,
              }),
            ),
          );
        }
      }
      await stub.e2eSettle();
      await pause(300);
    }
    host.state = "failed";
    host.failure = "The computer did not come online within 60s";
  } catch (error) {
    host.state = "failed";
    host.failure = `The computer could not wake: ${String(error).slice(0, 200)}`;
  }
}

/** Omnigent's sleep of an idle computer: `suspend`, repeated with its operation until stopped. */
async function sleepComputer(env: Env, computerId: string): Promise<string> {
  const stub = env.WORKSPACE.getByName(computerId) as unknown as E2eStub;
  const client = clientOf(env, computerId);
  // A sleep in progress is asked again with its operation; a refused one (a save still running,
  // or a finished sign-in's lease until WorkspaceDO's 15 s check ends it) with a new one a second
  // later, as Omnigent's next idle sweep would.
  let suspend = fresh(client.suspendRequest());
  let outcome = "none";
  for (const deadline = Date.now() + 60_000; outcome !== "stopped" && Date.now() < deadline; ) {
    const result = await client.send(suspend);
    if (result.operation !== "suspend") throw new Error("suspend");
    outcome = result.outcome === "refused" ? `refused: ${result.reason}` : result.outcome;
    if (result.outcome === "refused") suspend = fresh(client.suspendRequest());
    await stub.e2eSettle();
    await pause(result.outcome === "refused" ? 1_000 : 100);
  }
  for (const host of omnigentHosts.values()) {
    if (host.computerId === computerId && outcome === "stopped") host.state = "asleep";
  }
  return outcome;
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
    // WP3.53: asleep computers the setup page wakes through the fake Omnigent.
    "managed-asleep",
    "managed-full",
    "managed-others",
    // WP8.15: a team member's computer, bound to the member: the owner manages it as an admin.
    "managed-member",
  ]) {
    if (name === "managed-member") {
      owners.set(name, {
        userId: MEMBER_ACCOUNT,
        memberId: MEMBER_ID,
        teamId: MEMBER_TEAM,
        hostId: MEMBER_HOST,
      });
    }
    const { computerId, stub, client } = await create(env, name);
    const owner = owners.get(name);
    if (owner !== undefined) owners.set(computerId, owner);
    const wake = WAKE_HOSTS[name];
    if (wake !== undefined) {
      hostIds.set(computerId, wake.hostId);
      omnigentHosts.set(wake.hostId, {
        computerId,
        owner: wake.owner,
        admins: wake.admins ?? [],
        fail: wake.fail,
        state: "awake",
        failure: null,
        starts: 0,
        requests: 0,
      });
    }
    if (name === "managed-lost") lostContact.add(computerId);
    if (name === "managed-older") legacy.add(computerId);
    if (name === "managed-staging") {
      staging.add(computerId);
      failingSaves.add(computerId);
    }
    await client.send(client.provisionRequest(name));
    await client.wake({
      hostId: hostIdOf(computerId),
      token: `synthetic-launch-token-canary-e2e-${name}`,
    });
    await stub.e2eSettle();
    if (wake !== undefined) {
      // Never signed in, and asleep, as the owner found it on 4 Nov.
      const slept = await sleepComputer(env, computerId);
      if (slept !== "stopped") throw new Error(`${name} did not go to sleep: ${slept}`);
      out[name] = computerId;
      continue;
    }
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
    // Two days ago: history, below the computers (WP8.10).
    {
      outageId: "out_01hzy4a7b8c9d0e1f2g3h4j5k7",
      cause: "config_changed",
      startedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      detectedAt: new Date(Date.now() - 48 * 3_600_000 + 30_000).toISOString(),
      endedAt: new Date(Date.now() - 48 * 3_600_000 + 120_000).toISOString(),
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
    // WP3.28: the terminal's sessions on the computer, a reaper's end, and a WorkspaceDO reset.
    if (request.method === "GET" && url.pathname === "/__e2e/terminals" && id !== null) {
      const stub = env.WORKSPACE.getByName(id) as unknown as E2eStub;
      return Response.json(await stub.e2eTerminals());
    }
    if (request.method === "POST" && url.pathname === "/__e2e/end-terminals" && id !== null) {
      const stub = env.WORKSPACE.getByName(id) as unknown as E2eStub;
      await stub.e2eEndTerminals();
      return Response.json({ ended: true });
    }
    // WP3.53: the fake Omnigent's view of a host, its sleep, and one sleep attempt's outcome.
    const hostId = url.searchParams.get("host");
    if (request.method === "GET" && url.pathname === "/__e2e/omnigent" && hostId !== null) {
      const host = omnigentHosts.get(hostId);
      return Response.json(
        host === undefined
          ? null
          : {
              state: host.state,
              failure: host.failure,
              starts: host.starts,
              requests: host.requests,
            },
      );
    }
    if (request.method === "POST" && url.pathname === "/__e2e/sleep" && id !== null) {
      return Response.json({ outcome: await sleepComputer(env, id) });
    }
    if (request.method === "POST" && url.pathname === "/__e2e/suspend" && id !== null) {
      const client = clientOf(env, id);
      return Response.json(await client.send(fresh(client.suspendRequest())));
    }
    if (request.method === "POST" && url.pathname === "/__e2e/reset" && id !== null) {
      const stub = env.WORKSPACE.getByName(id) as unknown as E2eStub;
      // The reset breaks the call that asked for it.
      await stub.e2eReset().catch(() => undefined);
      return Response.json({ reset: true });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
