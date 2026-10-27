/**
 * Shared state between the assembled chain's Workers-runtime tests (WP3.18) and the test
 * platform Worker's `WorkspaceDO` (platform-test-worker.ts), which is bound as WORKSPACE, the
 * binding the routes, the backup gateway and ControlDO use. That class is the production
 * WorkspaceDO: its port, intercepts, bucket and ControlDO are the production wiring. Only these
 * are replaced, here:
 *   - the runtime container, one `FakeRuntimeContainer` per computer, kept across instances as
 *     the runtime keeps a Durable Object's container;
 *   - the clock, a day ahead of real time, so an alarm never fires by itself: tests run it;
 *   - a fault seam: the next RPC calls into WorkspaceDO fail with "Network connection lost."
 *     before reaching it, as a reset or a dropped connection would.
 *   - a part fault seam: the next part uploads the backup gateway admits fail as R2's lost
 *     connection did on staging (27 Oct 2026), "502 Network connection lost.", and the upload
 *     retry's delays are shortened (WP3.22).
 * workerd runs this module in the tests' own isolate, so a test and the objects share it.
 */
import type { ComputerId } from "@cfo/contracts";
import { FakeRuntimeContainer } from "./runtime-container.ts";

const DAY_MS = 86_400_000;

class Assembly {
  #now = Date.now() + DAY_MS;
  readonly #containers = new Map<string, FakeRuntimeContainer>();
  /** RPC calls into WorkspaceDO that fail before reaching it (a lost connection). */
  loseCalls = 0;
  /** Part uploads the gateway answers with 502 "Network connection lost." after its fence. */
  failParts = 0;
  /** Part uploads the gateway received, failed or not. */
  partsSeen = 0;
  /** WorkspaceDO's upload retry delays: production's, shortened for the tests' real timers. */
  readonly uploadRetryDelaysMs: readonly number[] = [5, 10];

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }

  /** The computer's container, created on first use. */
  container(computerId: ComputerId): FakeRuntimeContainer {
    let container = this.#containers.get(computerId);
    if (container === undefined) {
      container = new FakeRuntimeContainer(computerId);
      this.#containers.set(computerId, container);
    }
    return container;
  }

  /** Throws "Network connection lost." while calls are set to be lost. */
  maybeLose(): void {
    if (this.loseCalls > 0) {
      this.loseCalls -= 1;
      throw new Error("Network connection lost.");
    }
  }
}

export const assembly = new Assembly();
