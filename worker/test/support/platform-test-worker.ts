/**
 * The platform Worker as the Workers-runtime tests run it (wrangler.test.jsonc): the production
 * classes, except that OmnigentServer gets its container port, clock and timing from
 * `server-harness.ts`; WorkspaceDO (WP3.1's controller, bound as WORKSPACE_CONTROLLER) gets its
 * computer, ControlDO, bucket and clock from `workspace-harness.ts`; and the WORKSPACE binding the
 * routes and the backup gateway use (WP3.3) is a stand-in, as is WP3.2's ControlDO method, that
 * calls the fakes in `internal-harness.ts`. workerd runs this module in the tests' own isolate, so
 * a test and the Durable Objects share those registries.
 */
import { DurableObject } from "cloudflare:workers";
import type {
  ComputerCall,
  ControlCall,
  ControlResult,
  InterceptProps,
  LauncherCall,
  LauncherResult,
  PagesCall,
  PagesResult,
  ReservationState,
  SupervisorReply,
} from "@cfo/contracts";
import { WorkspaceDO as PlatformWorkspaceDO } from "../../src/computer/WorkspaceDO.ts";
import { ControlDO as PlatformControlDO } from "../../src/control/ControlDO.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../src/server/OmnigentServer.ts";
import type { ControlRpc, WorkspaceRpc, WriteCheck, WriteDecision } from "../../src/shared/rpc.ts";
import { internalFakes } from "./internal-harness.ts";
import { testServers } from "./server-harness.ts";
import { testComputers } from "./workspace-harness.ts";

export { DirectoryBackupGateway } from "../../src/egress/backups.ts";
export { default } from "../../src/index.ts";
export { ComputerApi, OmnigentRoute, PlatformInternal } from "../../src/internal/entrypoints.ts";

export class OmnigentServer extends PlatformOmnigentServer {
  protected override openContainer() {
    return testServers.container(this.ctx.id.toString());
  }

  protected override now() {
    return testServers.clock.now();
  }

  protected override timing() {
    return testServers.timing;
  }
}

export class WorkspaceDO extends PlatformWorkspaceDO {
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

  /** The production defaults the overrides above replace: no container or intercepts until they
   * are wired, R2 where CHECKPOINTS is bound, the real clock and timing. */
  defaults() {
    return {
      port: super.openPort(),
      bucket: super.checkpointBucket() === null ? null : "r2",
      intercepts: super.intercepts({
        propsVersion: 1,
        computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3",
        generation: 1,
        hostId: null,
      }),
      clockSkewMs: Math.abs(super.now() - Date.now()),
      heartbeatMs: super.timing().heartbeatMs,
      control: typeof super.controlRpc().control,
    };
  }

  /** Waits until the controller's runner has nothing left to do now (tests only). */
  async settle(): Promise<void> {
    await this.controller.idle();
  }
}

/** The scaffold ControlDO, with WP3.2's `control` method answered by the fake. */
export class ControlDO extends PlatformControlDO implements ControlRpc {
  async control(call: ControlCall): Promise<ControlResult> {
    return internalFakes.control.control(call);
  }
}

/**
 * The WORKSPACE binding as the routes' and the gateway's tests program it: WorkspaceDO's RPC
 * surface, answered by one FakeWorkspace each.
 */
export class WorkspaceStandIn extends DurableObject implements WorkspaceRpc {
  #fake() {
    if (internalFakes.loseWorkspaceCalls > 0) {
      internalFakes.loseWorkspaceCalls -= 1;
      throw new Error("Network connection lost.");
    }
    return internalFakes.workspace(this.ctx.id.name ?? "unnamed");
  }

  async launcher(call: LauncherCall): Promise<LauncherResult> {
    return this.#fake().launcher(call);
  }

  async computer(call: ComputerCall): Promise<SupervisorReply> {
    return this.#fake().computer(call);
  }

  async pages(call: PagesCall): Promise<PagesResult> {
    return this.#fake().pages(call);
  }

  async reservation(call: { readonly interfaceVersion: number }): Promise<ReservationState | null> {
    return this.#fake().reservation(call);
  }

  /**
   * WP3.1's write fence over the fake's state: the computer not fully removed (a removal intent
   * alone does not refuse: the removal's sign-out uploads its tombstones), the current generation,
   * and a credential key that is a pending upload of that generation.
   */
  async writeAllowed(check: WriteCheck): Promise<WriteDecision> {
    const name = this.ctx.id.name ?? "unnamed";
    if (internalFakes.loseWorkspaceCalls > 0) {
      internalFakes.loseWorkspaceCalls -= 1;
      throw new Error("Network connection lost.");
    }
    if (!internalFakes.has(name)) return { allowed: false, reason: "unknown_computer" };
    const fake = internalFakes.workspace(name);
    if (fake.context.state === "removed") return { allowed: false, reason: "removed" };
    if (check.generation !== fake.generation) return { allowed: false, reason: "stale_generation" };
    if (
      check.kind === "credential" &&
      internalFakes.pendingCredentialKeys.get(check.objectKey) !== check.generation
    ) {
      return { allowed: false, reason: "not_pending" };
    }
    return { allowed: true };
  }
}
