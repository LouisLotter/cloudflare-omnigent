/**
 * Shared state between the Workers-runtime tests and the test OmnigentServer
 * (platform-test-worker.ts): one fake container per Durable Object ID, a test clock and the
 * timing. Register a container before the object's first call; an object without one behaves as
 * a class with no container configured.
 *
 * The clock starts a day ahead of real time, so an alarm the object schedules from it never fires
 * by itself during a test run: tests run the watchdog with `runDurableObjectAlarm`.
 */
import { SERVER_TIMING, type ServerTiming } from "../../src/server/OmnigentServer.ts";
import { FakeServerContainer } from "./fake-server-container.ts";

const DAY_MS = 86_400_000;

class TestClock {
  #now = Date.now() + DAY_MS;

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }

  reset(): void {
    this.#now = Date.now() + DAY_MS;
  }
}

/** Fast timings for tests: no pause between health checks, short request waits. */
export const TEST_TIMING: ServerTiming = {
  ...SERVER_TIMING,
  probeRetryMs: 0,
  probeTimeoutMs: 50,
  requestWaitMs: 150,
  requestPollMs: 10,
};

class TestServers {
  readonly clock = new TestClock();
  timing: ServerTiming = TEST_TIMING;
  readonly #containers = new Map<string, FakeServerContainer>();

  /** A fake container for the object with this ID. */
  create(id: DurableObjectId | string): FakeServerContainer {
    const fake = new FakeServerContainer();
    this.#containers.set(id.toString(), fake);
    return fake;
  }

  container(id: string): FakeServerContainer | null {
    return this.#containers.get(id) ?? null;
  }
}

export const testServers = new TestServers();
