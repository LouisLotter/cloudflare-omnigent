/**
 * Drives assembled computers through the real chain (WP3.18), for the Workers-runtime tests:
 * the launcher's signed HTTP calls into `platform.internal` (PlatformInternal, the real HMAC
 * receiver), which reaches the real ControlDO and the real WorkspaceDO; the supervisor's messages
 * through the `computer.internal` intercept WorkspaceDO registered; the workspace layers and
 * credential bundles through the real fenced backup gateway into local R2. Only the container
 * (`runtime-container.ts`) and the clocks are simulated.
 */
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  type ComputerId,
  type InterceptProps,
  type LauncherResult,
  type PagesCall,
  type PagesResult,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { CONTROL_OBJECT_NAME, workspaceObjectName } from "../../src/shared/rpc.ts";
import { assembly } from "./assembly-harness.ts";
import { testControl } from "./control-harness.ts";
import { FakeLauncherClient, signedHttpTransport } from "./fake-launcher-client.ts";
import type { WorkspaceDO } from "./platform-test-worker.ts";
import type { FakeRuntimeContainer } from "./runtime-container.ts";

export type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

/** The launcher's current key, as wrangler.test.jsonc sets it (a synthetic canary). */
export const LAUNCHER_KEY = "cfo-canary-launcher-key-current-0000000000";
export const LAUNCHER_KEY_ID = "k-test-current";

type Factory = (options: { props: unknown }) => Fetcher;
/** The platform Worker's entrypoints, as loopback bindings made in the caller's context. */
export const entry = exports as unknown as Record<
  "OmnigentRoute" | "ComputerApi" | "PlatformInternal",
  Factory
>;

/** The launcher API as the server container reaches it: `platform.internal`, signed. */
export function launcherApi(): (request: Request) => Promise<Response> {
  const api = entry.PlatformInternal({ props: { propsVersion: 1, caller: "omnigent-server" } });
  return (request) => api.fetch(request);
}

const signed = () =>
  signedHttpTransport({
    fetch: launcherApi(),
    key: new TextEncoder().encode(LAUNCHER_KEY),
    keyId: LAUNCHER_KEY_ID,
  });

let serial = 0;

/** A fresh host ID for a test (32 hex). */
export function hostId(): string {
  serial += 1;
  return `${serial.toString(16).padStart(8, "0")}${"a1b2c3d4e5f60718293a4b5c".slice(0, 24)}`;
}

/** The production-named ControlDO: real logic, with room for every computer a file creates. */
export function roomyControl(maxInstanceSize = "standard-4"): void {
  testControl.setSettings(CONTROL_OBJECT_NAME, {
    CFO_MAX_AWAKE_COMPUTERS: "1000",
    CFO_MAX_INSTANCE_SIZE: maxInstanceSize,
  });
}

export interface Computer {
  readonly computerId: ComputerId;
  readonly stub: WorkspaceStub;
  readonly container: FakeRuntimeContainer;
  readonly client: FakeLauncherClient;
}

/** Provisions a computer through the launcher API: ControlDO registers it, WorkspaceDO records it. */
export async function provision(): Promise<Computer> {
  serial += 1;
  const name = `managed-${serial.toString(16).padStart(8, "0")}${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
  const transport = signed();
  const bootstrap = new FakeLauncherClient("", transport);
  // Omnigent's operation IDs are unique per call: ControlDO journals `register_computer` by it.
  const operationId = crypto.randomUUID().replaceAll("-", "");
  const result = await bootstrap.send(bootstrap.provisionRequest(name, operationId));
  if (result.operation !== "provision") throw new Error("provision");
  const computerId = result.computerId as ComputerId;
  const namespace = env.WORKSPACE as unknown as DurableObjectNamespace<WorkspaceDO>;
  const stub = namespace.getByName(workspaceObjectName(computerId)) as WorkspaceStub;
  return {
    computerId,
    stub,
    container: assembly.container(computerId),
    client: new FakeLauncherClient(computerId, transport),
  };
}

/**
 * Lets the controller's runner finish what it can now, delivering the supervisor's messages
 * through the registered `computer.internal` intercept in between.
 */
export async function settle(c: Computer): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await c.stub.settle();
    const delivered = await c.container.deliver((send) => runInDurableObject(c.stub, () => send()));
    if (delivered === 0) {
      await c.stub.settle();
      return;
    }
  }
}

/** Advances WorkspaceDO's clock and runs its alarm, then settles. */
export async function alarm(c: Computer, ms: number): Promise<void> {
  assembly.advance(ms);
  await runDurableObjectAlarm(c.stub);
  await settle(c);
}

/** Omnigent's wake: resume, then claim and start the host with this ID and token. */
export async function wake(
  c: Computer,
  host: { readonly hostId: string; readonly token: string },
): Promise<number> {
  const resumed = await c.client.send(c.client.resumeRequest());
  if (resumed.operation !== "resume") throw new Error("resume");
  await settle(c);
  const claim = await c.client.send(c.client.claimRequest());
  if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
  await c.client.send(
    c.client.startRequest({ attempt: claim.startAttempt, token: host.token, hostId: host.hostId }),
  );
  await settle(c);
  return claim.startAttempt;
}

/** Omnigent's sleep: one `suspend` operation, repeated until it reports its outcome. */
export async function sleep(c: Computer): Promise<LauncherResult> {
  if (c.container.sim.sup) c.container.sim.sup.runnerProcesses = 0;
  const request = c.client.suspendRequest();
  let result = await c.client.send(request);
  for (
    let i = 0;
    i < 10 && result.operation === "suspend" && result.outcome === "in_progress";
    i++
  ) {
    await settle(c);
    result = await c.client.send(request);
  }
  return result;
}

/** The props WorkspaceDO registered its intercepts with last (its current generation's). */
export function currentProps(c: Computer): InterceptProps {
  const props = c.container.props.at(-1);
  if (props === undefined) throw new Error("no intercepts registered");
  return props;
}

/** The computer's identity as its route reads it. */
export function identityOf(c: Computer) {
  return c.stub.identity({ interfaceVersion: WORKSPACE_INTERFACE_VERSION });
}

/** The admitted owner the tests' page changes come from (synthetic). */
export const PAGE_OWNER = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) } as const;

/**
 * A page change as the web Worker's pages send it (WP3.5's page front): the owner's session's
 * request-intent token, read from the page state, with the owner. Without them WorkspaceDO
 * refuses the change before any effect.
 */
export async function pageChange(
  c: Pick<Computer, "stub">,
  change: Exclude<PagesCall, { action: "state" }>,
): Promise<PagesResult> {
  const state = (await c.stub.pages({
    action: "state",
    interfaceVersion: WORKSPACE_INTERFACE_VERSION,
    owner: PAGE_OWNER,
  })) as PagesResult;
  const intent = state.action === "state" ? state.intentToken : undefined;
  if (intent === undefined) throw new Error("no intent token in the page state");
  return (await c.stub.pages({ ...change, owner: PAGE_OWNER, intent })) as PagesResult;
}
