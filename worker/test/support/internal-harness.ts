/**
 * Shared state between the Workers-runtime tests of the private virtual hosts (WP3.3) and the
 * test platform Worker's stand-ins for WP3.1's WorkspaceDO and WP3.2's ControlDO
 * (platform-test-worker.ts): one FakeWorkspace per computer and one FakeControl, kept in the
 * test isolate, which workerd shares with the Durable Objects. The stand-ins call the fakes, so
 * the real entrypoints (`internal/entrypoints.ts`) are tested through real bindings and RPC.
 */
import type { ComputerId } from "@cfo/contracts";
import { FakeControl } from "./fake-control.ts";
import { FakeWorkspace } from "./fake-workspace.ts";

class InternalFakes {
  readonly #workspaces = new Map<string, FakeWorkspace>();
  control = new FakeControl();
  /** Calls that fail with no answer before reaching the fake, as a reset or a lost connection. */
  loseWorkspaceCalls = 0;

  workspace(computerId: string): FakeWorkspace {
    let fake = this.#workspaces.get(computerId);
    if (!fake) {
      fake = new FakeWorkspace(computerId as ComputerId);
      this.#workspaces.set(computerId, fake);
    }
    return fake;
  }

  has(computerId: string): boolean {
    return this.#workspaces.has(computerId);
  }

  reset(): void {
    this.#workspaces.clear();
    this.control = new FakeControl();
    this.loseWorkspaceCalls = 0;
  }
}

export const internalFakes = new InternalFakes();
