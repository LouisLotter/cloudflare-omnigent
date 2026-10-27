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

/**
 * The server image every object's Worker version maps until a test releases another: a
 * digest-pinned reference, as Wrangler deploys one (synthetic).
 */
export const TEST_SERVER_IMAGE = `registry.example.test/cfo-test/omnigentserver-server@sha256:${"1".repeat(64)}`;

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

/** Fast timings for tests: no pause between health checks, short request waits and stops. */
export const TEST_TIMING: ServerTiming = {
  ...SERVER_TIMING,
  probeRetryMs: 0,
  probeTimeoutMs: 50,
  requestWaitMs: 150,
  requestPollMs: 10,
  stopGraceMs: 30_000,
};

class TestServers {
  readonly clock = new TestClock();
  timing: ServerTiming = TEST_TIMING;
  readonly #containers = new Map<string, FakeServerContainer>();
  readonly #releases = new Map<string, Readonly<Record<string, string | null>>>();
  readonly #images = new Map<string, string | null>();

  /**
   * A release for the object with this ID: every instance created from now on gets the Worker's
   * environment with these changes (a value sets a variable or secret, null deletes it), as the
   * objects of a new Worker version do once they switch to it. Evict the object to switch.
   * Changes accumulate, as successive releases do.
   */
  release(id: DurableObjectId | string, changes: Readonly<Record<string, string | null>>): void {
    const key = id.toString();
    this.#releases.set(key, { ...(this.#releases.get(key) ?? {}), ...changes });
  }

  /** The environment an instance of the object with this ID is created with. */
  envFor<Env extends object>(id: DurableObjectId | string, env: Env): Env {
    const changes = this.#releases.get(id.toString());
    if (changes === undefined) return env;
    const released: Record<string, unknown> = { ...(env as Record<string, unknown>) };
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) delete released[name];
      else released[name] = value;
    }
    return released as Env;
  }

  /**
   * A release of another server image for the object with this ID (null: the version maps none):
   * every instance created from now on starts the server with it, as a new Worker version's
   * `images` map does. The running container keeps its own. Evict the object to switch.
   */
  releaseImage(id: DurableObjectId | string, image: string | null): void {
    this.#images.set(id.toString(), image);
  }

  /** The server image an instance of the object with this ID maps. */
  imageFor(id: DurableObjectId | string): string | null {
    const key = id.toString();
    return this.#images.has(key) ? (this.#images.get(key) ?? null) : TEST_SERVER_IMAGE;
  }

  /** A fake container for the object with this ID. */
  create(id: DurableObjectId | string): FakeServerContainer {
    const fake = new FakeServerContainer();
    fake.clock = () => this.clock.now();
    this.#containers.set(id.toString(), fake);
    return fake;
  }

  container(id: string): FakeServerContainer | null {
    return this.#containers.get(id) ?? null;
  }
}

export const testServers = new TestServers();
