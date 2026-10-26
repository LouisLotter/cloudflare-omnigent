/**
 * The platform Worker as the Workers-runtime tests run it (wrangler.test.jsonc): the production
 * classes, except that OmnigentServer gets its container port, clock and timing from
 * `server-harness.ts`, and ControlDO its computers' WorkspaceDOs, clock, timing and limit settings
 * from `control-harness.ts`. workerd runs this module in the tests' own isolate, so a test and the
 * Durable Object share the harness's registry.
 */
import type { ComputerId } from "@cfo/contracts";
import { ControlDO as PlatformControlDO } from "../../src/control/ControlDO.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../src/server/OmnigentServer.ts";
import { testControl } from "./control-harness.ts";
import { testServers } from "./server-harness.ts";

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

export class ControlDO extends PlatformControlDO {
  protected override workspace(computerId: ComputerId) {
    return testControl.productionWorkspace
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
