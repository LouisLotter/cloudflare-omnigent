/**
 * The platform Worker as the Workers-runtime tests run it (wrangler.test.jsonc): the production
 * classes, except that OmnigentServer gets its container port, clock and timing from
 * `server-harness.ts`, and WorkspaceDO its computer, ControlDO, bucket and clock from
 * `workspace-harness.ts`. workerd runs this module in the tests' own isolate, so a test and the
 * Durable Object share the harness's registry.
 */
import type { InterceptProps } from "@cfo/contracts";
import { WorkspaceDO as PlatformWorkspaceDO } from "../../src/computer/WorkspaceDO.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../src/server/OmnigentServer.ts";
import type { ControlRpc } from "../../src/shared/rpc.ts";
import { testServers } from "./server-harness.ts";
import { testComputers } from "./workspace-harness.ts";

export { ControlDO } from "../../src/control/ControlDO.ts";
export { default } from "../../src/index.ts";
export { PlatformInternal } from "../../src/server/platform-internal.ts";

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

  /** The production defaults the overrides above replace: no container, bucket or intercepts
   * until WP3.3 wires them, the real clock and timing. */
  defaults() {
    return {
      port: super.openPort(),
      bucket: super.checkpointBucket(),
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
