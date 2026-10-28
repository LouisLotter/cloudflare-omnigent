/**
 * The platform Worker as the Workers-runtime tests run it (wrangler.test.jsonc): the production
 * classes, with these seams:
 *   - OmnigentServer gets its container port, clock, timing and any release a test made from
 *     `server-harness.ts`, of its environment or of its image;
 *   - WorkspaceDO, bound as WORKSPACE (the binding the routes, the backup gateway and ControlDO
 *     use), is the assembled production class (WP3.18): only its runtime container, its clock and
 *     a lost-connection seam come from `assembly-harness.ts`; its container port, intercepts,
 *     checkpoint bucket and ControlDO are the production wiring;
 *   - WorkspaceUnderFakes, bound as WORKSPACE_CONTROLLER, is WP3.1's controller with every
 *     dependency faked from `workspace-harness.ts`: a port-level simulated computer, a fake
 *     ControlDO and an in-memory bucket, for the controller's own Workers-runtime tests;
 *   - ControlDO gets its clock, timing and limit settings per object name from
 *     `control-harness.ts`; objects other than the production-named one reach their computers
 *     through that harness's fakes, while the production-named one (the routes', the launcher
 *     API's and WorkspaceDO's) reaches the real WorkspaceDOs through WORKSPACE.
 * workerd runs this module in the tests' own isolate, so a test and the Durable Objects share
 * those registries.
 */
import type {
  ComputerCall,
  ComputerId,
  InterceptProps,
  LauncherCall,
  LauncherResult,
  PageFrontCall,
  PageFrontResult,
  PageReadCall,
  PageReadResult,
  PagesCall,
  PagesResult,
  SupervisorReply,
} from "@cfo/contracts";
import { WorkspaceDO as PlatformWorkspaceDO } from "../../src/computer/WorkspaceDO.ts";
import { ControlDO as PlatformControlDO } from "../../src/control/ControlDO.ts";
import { FencedBackupGateway } from "../../src/egress/backups.ts";
import type { PlatformEnv } from "../../src/env.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../src/server/OmnigentServer.ts";
import {
  CONTROL_OBJECT_NAME,
  type ControlRpc,
  type WorkspaceIdentity,
  type WriteCheck,
  type WriteDecision,
} from "../../src/shared/rpc.ts";
import { assembly } from "./assembly-harness.ts";
import { testControl } from "./control-harness.ts";
import { testServers } from "./server-harness.ts";
import { testComputers } from "./workspace-harness.ts";

/**
 * The production fenced gateway, with two fault seams: a part fails as R2's lost connection did
 * on staging, answered as the SDK's gateway answers an R2 failure (502 and R2's message)
 * (`assembly.failParts`); a completion's reply is lost after R2 completed the object
 * (`assembly.loseCompletions`). Everything else, and everything once the seams are spent, is
 * production's.
 */
export class DirectoryBackupGateway extends FencedBackupGateway {
  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx.props ?? {}) as { readonly mode?: unknown };
    if (props.mode !== "write" || request.method !== "PUT") return super.fetch(request);
    assembly.partsSeen += 1;
    if (assembly.failParts === 0) return super.fetch(request);
    assembly.failParts -= 1;
    await request.body?.cancel().catch(() => undefined);
    return new Response("Network connection lost.", { status: 502 });
  }

  /** The completion seam (`assembly.loseCompletions`): R2 completes the object, the reply is lost. */
  override async completeUpload(
    uploadId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<number> {
    const size = await super.completeUpload(uploadId, parts);
    if (assembly.loseCompletions === 0) return size;
    assembly.loseCompletions -= 1;
    throw new Error("Network connection lost.");
  }
}
export { default } from "../../src/index.ts";
export { ComputerApi, OmnigentRoute, PlatformInternal } from "../../src/internal/entrypoints.ts";

export class OmnigentServer extends PlatformOmnigentServer {
  // A release the test made (`testServers.release`) reaches every new instance, as a new Worker
  // version's environment does.
  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, testServers.envFor(ctx.id, env));
  }

  protected override openContainer() {
    return testServers.container(this.ctx.id.toString());
  }

  // A release of another image (`testServers.releaseImage`) reaches every new instance, as a new
  // Worker version's `images` map does.
  protected override serverImage() {
    return testServers.imageFor(this.ctx.id);
  }

  protected override now() {
    return testServers.clock.now();
  }

  protected override timing() {
    return testServers.timing;
  }
}

/**
 * The assembled WorkspaceDO (WP3.18): the production class, with a simulated runtime container,
 * the test clock, a lost-connection seam and shortened upload retry delays. Nothing else is
 * replaced.
 */
export class WorkspaceDO extends PlatformWorkspaceDO {
  protected override runtimeContainer() {
    const name = this.ctx.id.name;
    return name === undefined
      ? null
      : (assembly.container(name as ComputerId) as unknown as Container);
  }

  protected override now() {
    return assembly.now();
  }

  /** The upload retry's delays, shortened (WP3.22); every other timing is production's. */
  protected override timing() {
    return { ...super.timing(), uploadRetryDelaysMs: assembly.uploadRetryDelaysMs };
  }

  /** Records the props the intercepts are built with (observation only), then builds them. */
  protected override intercepts(props: InterceptProps) {
    const name = this.ctx.id.name;
    if (name !== undefined) assembly.container(name as ComputerId).props.push(props);
    return super.intercepts(props);
  }

  override launcher(call: LauncherCall): Promise<LauncherResult> {
    assembly.maybeLose();
    return super.launcher(call);
  }

  override computer(call: ComputerCall): Promise<SupervisorReply> {
    assembly.maybeLose();
    return super.computer(call);
  }

  override pages(
    call: PagesCall | PageFrontCall | PageReadCall,
  ): Promise<PagesResult | PageFrontResult | PageReadResult> {
    assembly.maybeLose();
    return super.pages(call);
  }

  override writeAllowed(call: WriteCheck): Promise<WriteDecision> {
    assembly.maybeLose();
    return super.writeAllowed(call);
  }

  override identity(call: {
    readonly interfaceVersion: number;
  }): Promise<WorkspaceIdentity | null> {
    assembly.maybeLose();
    return super.identity(call);
  }

  /** Waits until the controller's runner has nothing left to do now (tests only). */
  async settle(): Promise<void> {
    await this.controller.idle();
  }
}

/** WP3.1's controller under fakes (WORKSPACE_CONTROLLER): every dependency from the harness. */
export class WorkspaceUnderFakes extends PlatformWorkspaceDO {
  protected override openPort() {
    return testComputers.computer(this.ctx.id.toString());
  }

  protected override controlRpc(): ControlRpc {
    return testComputers.control;
  }

  protected override checkpointBucket() {
    return testComputers.bucket;
  }

  protected override intercepts(props: InterceptProps) {
    return [{ host: "computer.internal", target: { props } as unknown as Fetcher }];
  }

  protected override now() {
    return testComputers.now();
  }

  /** The setup terminal's checks run every few milliseconds, so a test need not wait (WP3.5). */
  protected override terminalTiming() {
    return testComputers.terminalTiming;
  }

  /** A staging installation where the test says so (WP3.23); production otherwise. */
  protected override stagingChecks() {
    return testComputers.staging.has(this.ctx.id.name ?? "") || super.stagingChecks();
  }

  /** The production hooks the overrides above replace, as this test configuration wires them:
   * no container (the test configuration has none), R2 behind the fence where CHECKPOINTS is
   * bound, the two computer intercepts, the real clock and timing, and ControlDO's binding. */
  defaults() {
    return {
      port: super.openPort(),
      bucket: super.checkpointBucket() === null ? null : "r2",
      intercepts: super
        .intercepts({
          propsVersion: 1,
          computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3",
          generation: 1,
          hostId: null,
        })
        .map((t) => t.host),
      clockSkewMs: Math.abs(super.now() - Date.now()),
      heartbeatMs: super.timing().heartbeatMs,
      control: typeof super.controlRpc().control,
      stagingChecks: super.stagingChecks(),
    };
  }

  /** Waits until the controller's runner has nothing left to do now (tests only). */
  async settle(): Promise<void> {
    await this.controller.idle();
  }
}

export class ControlDO extends PlatformControlDO {
  /** The production-named object reaches the real WorkspaceDOs; the others, the harness's fakes. */
  protected override workspace(computerId: ComputerId) {
    return testControl.productionWorkspace || this.ctx.id.name === CONTROL_OBJECT_NAME
      ? super.workspace(computerId)
      : testControl.workspace(computerId);
  }

  protected override settings() {
    return testControl.settings(this.ctx.id.name) ?? super.settings();
  }

  protected override now() {
    return testControl.now();
  }

  protected override timing() {
    return testControl.timing;
  }

  /** The production defaults the overrides above replace (tests only). */
  defaults() {
    return {
      settings: super.settings(),
      timing: super.timing(),
      clockSkewMs: Math.abs(super.now() - Date.now()),
    };
  }
}
