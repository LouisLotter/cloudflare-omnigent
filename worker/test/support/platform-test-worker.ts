/**
 * The platform Worker as the Workers-runtime tests run it (wrangler.test.jsonc): the production
 * classes, except that OmnigentServer gets its container port, clock and timing from
 * `server-harness.ts`. workerd runs this module in the tests' own isolate, so a test and the
 * Durable Object share the harness's registry.
 */
import { OmnigentServer as PlatformOmnigentServer } from "../../src/server/OmnigentServer.ts";
import { testServers } from "./server-harness.ts";

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
