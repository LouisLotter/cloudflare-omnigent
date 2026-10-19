// Local harness for the S1 Worker under wrangler dev: the real S1Server, HostRoute and
// S1Computer (its intercept registration and props) from ../../src/index.js, plus dev-only
// routes. The computer container is started held: its own host never starts, because Docker's
// bridge cannot reach workerd on the laptop where this ran. It has to run so that its egress
// listener exists; a client on the laptop then reaches HostRoute through that listener with
// relay.py, as the container would.
import * as s1 from "../../src/index.js";

export { DirectoryBackupGateway, HostRoute, S1Control, S1Server } from "../../src/index.js";

export class S1Computer extends s1.S1Computer {
  /** Starts the container held, with the route registered in `mode` (none: no stored mode). */
  async devStart(mode) {
    if (mode) await this.ctx.storage.put("wsMode", mode);
    else await this.ctx.storage.delete("wsMode");
    if (this.ctx.container.running) await this.ctx.container.destroy();
    await this.intercept("dev", 1);
    this.ctx.container.start({ enableInternet: true, env: { S1_HOLD_HOST: "1" } });
    await this.intercept("dev", 1);
    await this.ctx.container.setInactivityTimeout(30 * 60_000);
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    return { running: this.ctx.container.running, wsMode: mode };
  }

  // Keeps this object, and so its container, alive while the harness runs.
  async alarm() {
    if (this.ctx.container.running) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const server = env.SERVER.get(env.SERVER.idFromName("server"));
    if (url.pathname === "/__up") return Response.json(await server.ensureUp());
    if (url.pathname === "/__computer/start") {
      const computer = env.COMPUTER.get(env.COMPUTER.idFromName("computer-1"));
      return Response.json(await computer.devStart(url.searchParams.get("mode")));
    }
    // Everything else goes to the server through S1Server, for host status polling.
    return server.fetch(request);
  },
};
