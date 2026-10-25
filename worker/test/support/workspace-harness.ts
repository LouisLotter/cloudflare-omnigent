/**
 * Shared state between the Workers-runtime tests and the test WorkspaceDO (platform-test-worker.ts):
 * a simulated computer per Durable Object ID, one fake ControlDO and one checkpoint bucket, and a
 * test clock a day ahead of real time, so an alarm WorkspaceDO schedules never fires by itself:
 * tests run it with `runDurableObjectAlarm`. Register a computer before the object's first call.
 */
import { CMP } from "./computer-sim.ts";
import { FakeBucket } from "./fake-bucket.ts";
import { FakeControl } from "./fake-control.ts";
import { SimulatedComputer } from "./fake-supervisor.ts";

const DAY_MS = 86_400_000;

class TestComputers {
  #now = Date.now() + DAY_MS;
  readonly control = new FakeControl();
  readonly bucket = new FakeBucket();
  readonly #computers = new Map<string, SimulatedComputer>();

  constructor() {
    this.control.maxAwakeComputers = 100;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }

  /** A simulated computer for the object with this ID. */
  create(id: DurableObjectId | string, computerId = CMP): SimulatedComputer {
    const computer = new SimulatedComputer(computerId as typeof CMP);
    this.#computers.set(id.toString(), computer);
    return computer;
  }

  computer(id: string): SimulatedComputer | null {
    return this.#computers.get(id) ?? null;
  }
}

export const testComputers = new TestComputers();
