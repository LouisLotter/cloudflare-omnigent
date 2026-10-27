import { describe, expect, it } from "vitest";
import {
  exitCodeOf,
  isNoInstanceError,
  isNotListeningError,
  nativeServerContainer,
  SERVER_IMAGE_KEY,
  serverContainerOf,
  serverImageOf,
  serverStartOptions,
} from "../../src/server/container-port.ts";
import { SERVER_INSTANCE } from "../../src/server/server-env.ts";

const IMAGE = `registry.example.test/acct/x-omnigentserver-server@sha256:${"a".repeat(64)}`;

/** A recording stand-in for the runtime's `ctx.container`. */
function runtimeContainer(monitor: Promise<void>) {
  const calls: unknown[][] = [];
  const port = {
    fetch: async (request: Request) => {
      calls.push(["port.fetch", request.url]);
      return new Response("from port");
    },
  };
  const container = {
    running: false,
    start(options: unknown) {
      calls.push(["start", options]);
      this.running = true;
    },
    monitor: () => monitor,
    getTcpPort(n: number) {
      calls.push(["getTcpPort", n]);
      return port;
    },
    destroy: async (reason: string) => {
      calls.push(["destroy", reason]);
    },
    signal: (signo: number) => {
      calls.push(["signal", signo]);
    },
    setInactivityTimeout: async (ms: number) => {
      calls.push(["setInactivityTimeout", ms]);
    },
    interceptOutboundHttp: async (host: string, target: unknown) => {
      calls.push(["interceptOutboundHttp", host, target]);
    },
  };
  return { container, calls };
}

describe("the server's container port", () => {
  it("maps each operation onto the runtime's container API", async () => {
    const { container, calls } = runtimeContainer(new Promise(() => undefined));
    const port = nativeServerContainer(container as unknown as Container);
    const env = { A: "1" };
    expect(port.running).toBe(false);
    port.start(env, IMAGE);
    env.A = "changed";
    expect(port.running).toBe(true);
    const response = await port.fetch(8000, new Request("http://omnigent/health"));
    expect(await response.text()).toBe("from port");
    await port.destroy("why");
    port.signal(15);
    await port.setInactivityTimeout(3_600_000);
    const target = { fetch: () => undefined } as unknown as Fetcher;
    await port.interceptOutboundHttp("platform.internal", target);
    expect(calls).toEqual([
      ["start", { enableInternet: true, env: { A: "1" }, instance: SERVER_INSTANCE, image: IMAGE }],
      ["getTcpPort", 8000],
      ["port.fetch", "http://omnigent/health"],
      ["destroy", "why"],
      ["signal", 15],
      ["setInactivityTimeout", 3_600_000],
      ["interceptOutboundHttp", "platform.internal", target],
    ]);
  });

  it("starts with the image this version maps and the server's size, always explicit (WP3.19)", () => {
    // D30: a custom instance, within the runtime's rules (at least 1 vCPU, 3 GiB per vCPU).
    expect(SERVER_INSTANCE).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 8000 });
    if (typeof SERVER_INSTANCE === "object") {
      expect(SERVER_INSTANCE.vcpu).toBeGreaterThanOrEqual(1);
      expect(SERVER_INSTANCE.memoryMib).toBeGreaterThanOrEqual(3072 * SERVER_INSTANCE.vcpu);
    }
    expect(serverStartOptions({ A: "1" }, IMAGE)).toEqual({
      enableInternet: true,
      env: { A: "1" },
      instance: SERVER_INSTANCE,
      image: IMAGE,
    });
    // No image mapped: the size is still explicit, and no image is named.
    expect(serverStartOptions({}, null)).toEqual({
      enableInternet: true,
      env: {},
      instance: SERVER_INSTANCE,
    });
  });

  it("reads the server's image from this version's images map, or none", () => {
    const withImages = (images: unknown) =>
      ({ container: { images } }) as unknown as { container: Container };
    expect(SERVER_IMAGE_KEY).toBe("server");
    expect(serverImageOf(withImages({ server: IMAGE, other: "x" }))).toBe(IMAGE);
    expect(serverImageOf(withImages({ computer: IMAGE }))).toBeNull();
    expect(serverImageOf(withImages({ server: "" }))).toBeNull();
    expect(serverImageOf({})).toBeNull();
    // A class under the default policy has no images map: the getter throws.
    const noMap = {
      container: {
        get images(): Record<string, string> {
          throw new Error("no images under the default policy");
        },
      },
    } as unknown as { container: Container };
    expect(serverImageOf(noMap)).toBeNull();
  });

  it("reports a container's end: a clean exit or the error", async () => {
    const clean = nativeServerContainer(runtimeContainer(Promise.resolve()).container as never);
    const failed = nativeServerContainer(
      runtimeContainer(Promise.reject(new Error("refused"))).container as never,
    );
    const exits = await Promise.all(
      [clean, failed].map((port) => new Promise((resolve) => port.watch(resolve))),
    );
    expect(exits).toEqual([{ error: null }, { error: new Error("refused") }]);
  });

  it("finds the object's container, or none", () => {
    expect(serverContainerOf({} as DurableObjectState)).toBeNull();
    const { container } = runtimeContainer(new Promise(() => undefined));
    expect(serverContainerOf({ container } as unknown as DurableObjectState)?.running).toBe(false);
  });

  it("recognises Cloudflare's refusal after a stop (DC-37) and a port with no listener", () => {
    expect(
      isNoInstanceError(
        new Error(
          "There is no container instance that can be provided to this Durable Object, try again later",
        ),
      ),
    ).toBe(true);
    expect(isNoInstanceError("network down")).toBe(false);
    expect(
      isNotListeningError(
        new Error("The container is not listening on the TCP address 10.0.0.1:8000"),
      ),
    ).toBe(true);
    expect(isNotListeningError(new Error("Network connection lost."))).toBe(false);
  });
});

describe("exitCodeOf", () => {
  it("reads the container's exit code from monitor()'s outcome", () => {
    expect(exitCodeOf({ error: null })).toBe(0);
    expect(exitCodeOf({ error: new Error("Container exited with unexpected exit code: 78") })).toBe(
      78,
    );
    expect(exitCodeOf({ error: new Error("container exited with unexpected exit code: 75") })).toBe(
      75,
    );
    expect(
      exitCodeOf({ error: new Error("Runtime signalled the container to exit: 15") }),
    ).toBeNull();
    expect(exitCodeOf({ error: new Error("exited with unexpected exit code: 999") })).toBeNull();
    expect(exitCodeOf({ error: "network down" })).toBeNull();
  });
});
