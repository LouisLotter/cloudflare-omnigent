import type { ComputerId, DirectoryBackupRecord } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_IMAGE_KEY,
  nativeComputerContainer,
  observeStart,
  type RuntimeContainer,
  runtimeStartOptions,
} from "../../src/computer/container-port.ts";
import {
  BACKUP_GATEWAY_HOST,
  COMPUTER_INTERCEPTS,
  type InterceptExports,
  interceptHostAllowed,
  interceptProps,
  interceptTargets,
  refreshIntercepts,
  registerIntercepts,
  startWithIntercepts,
} from "../../src/computer/network.ts";
import { NO_INSTANCE_MESSAGE } from "../../src/shared/computer-port.ts";
import { defined } from "../support/defined.ts";
import { FakeComputerContainer } from "../support/fake-computer-container.ts";

const COMPUTER = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3" as ComputerId;
const HOST = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** `ctx.exports` stand-in: each call records the props and returns a tagged Fetcher. */
function exportsRecorder() {
  const made: { entrypoint: string; props: unknown }[] = [];
  const factory = (entrypoint: string) => (options: { props: unknown }) => {
    made.push({ entrypoint, props: options.props });
    return { entrypoint } as unknown as Fetcher;
  };
  const exports = {
    OmnigentRoute: factory("OmnigentRoute"),
    ComputerApi: factory("ComputerApi"),
  } as InterceptExports;
  return { exports, made };
}

describe("computer intercepts", () => {
  it("builds WorkspaceDO's targets: each computer host bound to the checked props (WP3.18)", () => {
    const { exports, made } = exportsRecorder();
    const props = interceptProps(COMPUTER, 4, HOST);
    const targets = interceptTargets(exports, props);
    expect(targets.map((t) => t.host)).toEqual(["omnigent.internal", "computer.internal"]);
    expect(made).toEqual([
      { entrypoint: "OmnigentRoute", props },
      { entrypoint: "ComputerApi", props },
    ]);
    expect(targets.map((t) => (t.target as unknown as { entrypoint: string }).entrypoint)).toEqual([
      "OmnigentRoute",
      "ComputerApi",
    ]);
    // Props the contract refuses never reach an entrypoint.
    expect(() => interceptTargets(exports, { ...props, generation: -1 })).toThrow();
    expect(made).toHaveLength(2);
  });

  it("registers exactly omnigent.internal and computer.internal: no catch-all, no other host", () => {
    expect(COMPUTER_INTERCEPTS.map((i) => i.host)).toEqual([
      "omnigent.internal",
      "computer.internal",
    ]);
    for (const host of [
      "*",
      "",
      "*.internal",
      "platform.internal",
      BACKUP_GATEWAY_HOST,
      "evil.example",
      "omnigent.internal:8001",
      "a/b",
    ]) {
      expect(interceptHostAllowed(host), host).toBe(false);
    }
    expect(interceptHostAllowed("OMNIGENT.internal")).toBe(true);
  });

  it("builds versioned props from the contract, and refuses malformed ones", () => {
    expect(interceptProps(COMPUTER, 3, null)).toEqual({
      propsVersion: 1,
      computerId: COMPUTER,
      generation: 3,
      hostId: null,
    });
    expect(() => interceptProps("cmp_bad" as ComputerId, 3, null)).toThrow();
    expect(() => interceptProps(COMPUTER, -1, null)).toThrow();
    expect(() => interceptProps(COMPUTER, 3, "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")).toThrow();
  });

  it("registers the intercepts before every start, with this generation's props", async () => {
    const port = new FakeComputerContainer();
    const { exports, made } = exportsRecorder();
    await startWithIntercepts(port, exports, interceptProps(COMPUTER, 7, null), {
      instance: "standard-2",
      env: {},
    });
    expect(port.ops).toEqual([
      "intercept:omnigent.internal",
      "intercept:computer.internal",
      "start",
    ]);
    expect(made.every((m) => (m.props as { generation: number }).generation === 7)).toBe(true);
  });

  it("starts nothing if a registration fails", async () => {
    const port = new FakeComputerContainer();
    port.registerIntercept = async () => {
      throw new Error("interceptOutboundHttp failed");
    };
    const { exports } = exportsRecorder();
    await expect(
      startWithIntercepts(port, exports, interceptProps(COMPUTER, 1, null), {
        instance: "standard-2",
        env: {},
      }),
    ).rejects.toThrow();
    expect(port.starts).toHaveLength(0);
  });

  it("refreshes props in a new instance only while the container runs, never the backup host", async () => {
    const port = new FakeComputerContainer();
    const { exports, made } = exportsRecorder();
    expect(await refreshIntercepts(port, exports, interceptProps(COMPUTER, 2, null))).toBe(false);
    expect(port.ops).toEqual([]);
    port.start({ instance: "standard-2", env: {} });
    expect(await refreshIntercepts(port, exports, interceptProps(COMPUTER, 2, HOST))).toBe(true);
    expect(port.intercepts.map((i) => i.host)).toEqual(["omnigent.internal", "computer.internal"]);
    expect((defined(made.at(-1)).props as { hostId: string }).hostId).toBe(HOST);
    expect(port.intercepts.some((i) => i.host === BACKUP_GATEWAY_HOST)).toBe(false);
  });

  it("refuses props that do not parse", async () => {
    const port = new FakeComputerContainer();
    const { exports } = exportsRecorder();
    await expect(
      registerIntercepts(port, exports, {
        propsVersion: 1,
        computerId: COMPUTER,
        generation: 1,
        hostId: null,
        token: "x",
      } as never),
    ).rejects.toThrow();
    expect(port.intercepts).toHaveLength(0);
  });
});

/** A recording stand-in for the runtime's `ctx.container` (as test/unit/container-port.test.ts). */
function runtime(
  images: Record<string, string> | "throws" = { computer: "registry/computer@sha256:abc" },
) {
  const calls: unknown[][] = [];
  let running = false;
  let stillRunningAfterDestroy = 0;
  const container = {
    get running() {
      return running;
    },
    get images() {
      if (images === "throws") throw new Error("no images under this policy");
      return images;
    },
    start(options: unknown) {
      calls.push(["start", options]);
      running = true;
    },
    destroy: async (reason: string) => {
      calls.push(["destroy", reason]);
      if (stillRunningAfterDestroy-- <= 0) running = false;
    },
    signal: (signo: number) => calls.push(["signal", signo]),
    getTcpPort: (port: number) => ({
      fetch: async (request: Request) => {
        calls.push(["fetch", port, request.url]);
        return new Response("ok");
      },
    }),
    interceptOutboundHttp: async (host: string) => {
      calls.push(["intercept", host]);
    },
    setInactivityTimeout: async (ms: number) => {
      calls.push(["timeout", ms]);
    },
  };
  return {
    container: container as unknown as RuntimeContainer,
    calls,
    stayRunning(n: number) {
      stillRunningAfterDestroy = n;
    },
    setRunning(value: boolean) {
      running = value;
    },
  };
}

describe("the computer's container port", () => {
  const record: DirectoryBackupRecord = {
    id: "00000000-0000-4000-8000-000000000001",
    dir: "/stage/layer",
    size: 10,
    sha256: "0".repeat(64),
    format: "tar+zstd/1",
  };
  const backupsCalls: unknown[][] = [];
  const backups = (prefix: string, generation: number | null) => ({
    backup: async (options: unknown) => {
      backupsCalls.push(["backup", prefix, options, generation]);
      return record;
    },
    restore: async (r: DirectoryBackupRecord, options: unknown) => {
      backupsCalls.push(["restore", prefix, r.id, options, generation]);
    },
    delete: async (r: DirectoryBackupRecord) => {
      backupsCalls.push(["delete", prefix, r.id, generation]);
    },
  });

  it("starts with an explicit size, internet on, and the computer image when mapped", () => {
    const rt = runtime();
    const port = nativeComputerContainer(rt.container, { backups });
    port.start({ instance: "standard-2", env: { CFO_GENERATION: "3" } });
    expect(rt.calls[0]).toEqual([
      "start",
      {
        enableInternet: true,
        env: { CFO_GENERATION: "3" },
        instance: "standard-2",
        image: "registry/computer@sha256:abc",
      },
    ]);
    expect(() => port.start({ instance: "standard-2", env: {} })).toThrow(/running/);
    expect(runtimeStartOptions({ instance: "lite", env: {} }, {})).toEqual({
      enableInternet: true,
      env: {},
      instance: "lite",
    });
    expect(COMPUTER_IMAGE_KEY).toBe("computer");
  });

  it("starts without an image when the class has no images map", () => {
    const rt = runtime("throws");
    nativeComputerContainer(rt.container, { backups }).start({ instance: "standard-1", env: {} });
    expect(rt.calls[0]?.[1]).not.toHaveProperty("image");
  });

  it("reaches ports only over http://", async () => {
    const rt = runtime();
    const port = nativeComputerContainer(rt.container, { backups });
    await port.fetch(8090, new Request("http://computer/v1/commands"));
    await expect(port.fetch(8090, new Request("https://computer/v1/commands"))).rejects.toThrow(
      /http:/,
    );
    expect(rt.calls).toEqual([["fetch", 8090, "http://computer/v1/commands"]]);
  });

  it("confirms a stop, and rejects when the container keeps running", async () => {
    const rt = runtime();
    const port = nativeComputerContainer(rt.container, {
      backups,
      sleep: async () => undefined,
      stopConfirmMs: 300,
    });
    port.start({ instance: "standard-2", env: {} });
    await port.destroy("sleep");
    expect(port.running).toBe(false);
    port.start({ instance: "standard-2", env: {} });
    rt.stayRunning(1);
    await expect(port.destroy("sleep")).rejects.toThrow(/did not stop/);
  });

  it("refuses a catch-all or a foreign intercept host", async () => {
    const rt = runtime();
    const port = nativeComputerContainer(rt.container, { backups });
    await port.registerIntercept("omnigent.internal", {} as Fetcher);
    for (const host of ["*", "platform.internal", BACKUP_GATEWAY_HOST]) {
      await expect(port.registerIntercept(host, {} as Fetcher)).rejects.toThrow();
    }
    expect(rt.calls).toEqual([["intercept", "omnigent.internal"]]);
  });

  it("passes signals, timeouts and backups through, each under the computer's prefix", async () => {
    const rt = runtime();
    const port = nativeComputerContainer(rt.container, { backups });
    port.signal(15);
    await port.setInactivityTimeout(2_700_000);
    const signal = AbortSignal.timeout(600_000);
    expect(
      await port.backup({
        dir: "/stage/layer",
        name: "lyr_1",
        prefix: "workspace/cmp_x/",
        generation: 7,
        signal,
      }),
    ).toBe(record);
    await port.restore(record, { dir: "/restore/0", prefix: "workspace/cmp_x/" });
    await port.deleteBackup(record, { prefix: "workspace/cmp_x/" });
    expect(rt.calls).toEqual([
      ["signal", 15],
      ["timeout", 2_700_000],
    ]);
    expect(backupsCalls.map((c) => [c[0], c[1]])).toEqual([
      ["backup", "workspace/cmp_x/"],
      ["restore", "workspace/cmp_x/"],
      ["delete", "workspace/cmp_x/"],
    ]);
    expect(backupsCalls[0]?.[2]).toEqual({ dir: "/stage/layer", name: "lyr_1", signal });
    // An upload is fenced to its capture's generation; a restore or a delete carries no fence.
    expect(backupsCalls.map((c) => c.at(-1))).toEqual([7, null, null]);
  });
});

describe("observing a start without monitor()", () => {
  /** A fake clock: polling sleeps advance it; a probe's timer never fires unless asked. */
  const clockFrom = () => {
    let now = 0;
    return {
      clock: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      timer: () => new Promise<void>(() => undefined),
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it("is ready once a probe answers within the deadline", async () => {
    const t = clockFrom();
    let probes = 0;
    const outcome = await observeStart({ ...t, probe: async () => ++probes >= 3 });
    expect(outcome).toEqual({ kind: "ready", afterMs: 500 });
  });

  it("is refused when a probe surfaces Cloudflare's refusal (CF-05)", async () => {
    const t = clockFrom();
    const outcome = await observeStart({
      ...t,
      probe: async () => {
        throw new Error(NO_INSTANCE_MESSAGE);
      },
    });
    expect(outcome.kind).toBe("refused");
  });

  it("is not_running when nothing answers within the deadline", async () => {
    const t = clockFrom();
    const outcome = await observeStart({
      ...t,
      deadlineMs: 10_000,
      probe: async () => {
        throw new Error("The container is not listening");
      },
    });
    expect(outcome).toEqual({ kind: "not_running", afterMs: 10_000 });
  });

  it("bounds a hanging probe, aborts it, and gives up at the deadline (r1-5)", async () => {
    let now = 0;
    const signals: AbortSignal[] = [];
    const outcome = await observeStart({
      deadlineMs: 10_000,
      probeTimeoutMs: 2_000,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      // The probe's timer fires at once, as its time passes.
      timer: async (ms) => {
        now += ms;
      },
      probe: (signal) => {
        signals.push(signal);
        return new Promise<boolean>(() => undefined); // never answers
      },
    });
    expect(outcome.kind).toBe("not_running");
    expect(outcome.afterMs).toBeGreaterThanOrEqual(10_000);
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("never reports ready for an answer that came after the deadline (r1-5)", async () => {
    let now = 0;
    const outcome = await observeStart({
      deadlineMs: 10_000,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      timer: () => new Promise<void>(() => undefined),
      probe: async () => {
        now += 20_000; // the answer arrives 20 s later
        return true;
      },
    });
    expect(outcome).toEqual({ kind: "not_running", afterMs: 20_000 });
  });

  it("reads a probe that throws at once like one that rejects (r2-3)", async () => {
    const t = clockFrom();
    const refused = await observeStart({
      ...t,
      probe: () => {
        throw new Error(NO_INSTANCE_MESSAGE);
      },
    });
    expect(refused.kind).toBe("refused");
    const t2 = clockFrom();
    let calls = 0;
    const ready = await observeStart({
      ...t2,
      probe: () => {
        calls += 1;
        if (calls === 1) throw new Error("The container is not listening");
        return Promise.resolve(true);
      },
    });
    expect(ready.kind).toBe("ready");
  });

  it("works with the fake port's refused start (DC-37)", async () => {
    const fake = new FakeComputerContainer();
    fake.refuseStarts = 1;
    fake.start({ instance: "standard-2", env: {} });
    const t = clockFrom();
    const outcome = await observeStart({
      ...t,
      probe: async (signal) =>
        (
          await fake.fetch(
            8090,
            new Request("http://computer/v1/commands", { method: "POST", body: "{}", signal }),
          )
        ).ok,
    });
    expect(outcome.kind).toBe("refused");
  });
});

describe("the container port's defaults", () => {
  it("waits with real timers for a stop to show, and passes a missing signal on as none", async () => {
    const rt = runtime(null as unknown as Record<string, string>);
    const port = nativeComputerContainer(rt.container, {
      backups: () => ({
        backup: async (options) => {
          expect(options).not.toHaveProperty("signal");
          return {
            id: "00000000-0000-4000-8000-000000000002",
            dir: "/d",
            size: 1,
            sha256: "0".repeat(64),
            format: "tar+zstd/1",
          };
        },
        restore: async (_record, options) => {
          expect(options?.signal).toBeInstanceOf(AbortSignal);
        },
        delete: async () => undefined,
      }),
    });
    port.start({ instance: "standard-1", env: {} });
    expect(rt.calls[0]?.[1]).not.toHaveProperty("image");
    rt.stayRunning(1);
    const stopping = port.destroy("stop"); // real 100 ms waits until the stop shows
    setTimeout(() => rt.setRunning(false), 150);
    await stopping;
    const record = await port.backup({ dir: "/d", name: "n", prefix: "p/", generation: 1 });
    await port.restore(record, { dir: "/r", prefix: "p/", signal: AbortSignal.timeout(1_000) });
  });

  it("observes a start with real timers by default", async () => {
    expect(await observeStart({ probe: async () => true })).toMatchObject({ kind: "ready" });
    let probes = 0;
    const late = await observeStart({
      deadlineMs: 300,
      pollMs: 10,
      probeTimeoutMs: 50,
      probe: () => (probes++ === 0 ? new Promise<boolean>(() => undefined) : Promise.resolve(true)),
    });
    expect(late.kind).toBe("ready");
  });
});
