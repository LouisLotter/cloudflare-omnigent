/**
 * In-memory fake of ControlDO (WP3.2's), for WorkspaceDO's tests (WP3.1) and the launcher API's
 * (WP3.3). It keeps ControlDO's rules, so callers cannot come to rely on a laxer one:
 *   - `register_computer` is idempotent by name: `provision` repeated after a lost reply gets the
 *     same computer;
 *   - a reservation is a (computer, generation) slot; a repeat returns the same answer, and a wake
 *     at the limit is refused at once with the counts, with no queue (R-20);
 *   - every call is parsed with the contract and its interface version checked, as ControlDO does.
 * `unavailable` makes every call fail with `unavailable`, as when ControlDO cannot be reached
 * (FH-37).
 */
import {
  CONTROL_INTERFACE_VERSION,
  type ComputerId,
  ControlCall,
  type ControlResult,
  type InstanceSize,
} from "@cfo/contracts";
import { platformError } from "../../src/shared/errors.ts";
import type { ControlRpc } from "../../src/shared/rpc.ts";

const base32 = "0123456789abcdefghjkmnpqrstvwxyz";

export class FakeControl implements ControlRpc {
  maxAwakeComputers = 2;
  maxInstanceSize: InstanceSize = "standard-4";
  unavailable = false;
  readonly calls: ControlCall[] = [];
  /** name → computer. */
  readonly computers = new Map<string, ComputerId>();
  /** `${computerId}/${generation}` slots. */
  readonly slots = new Set<string>();
  #next = 0;

  async control(raw: ControlCall): Promise<ControlResult> {
    const parsed = ControlCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a ControlCall");
    const call = parsed.data;
    if (call.interfaceVersion > CONTROL_INTERFACE_VERSION) {
      throw platformError("unsupported_version", `interface version ${call.interfaceVersion}`);
    }
    if (this.unavailable) throw platformError("unavailable", "ControlDO is unavailable");
    this.calls.push(call);
    switch (call.method) {
      case "register_computer": {
        let computerId = this.computers.get(call.name);
        if (!computerId) {
          computerId = this.#mint();
          this.computers.set(call.name, computerId);
        }
        return { method: "register_computer", computerId };
      }
      case "list_computers":
        return {
          method: "list_computers",
          computers: [...this.computers].map(([name, computerId]) => ({ computerId, name })),
        };
      case "reserve": {
        const slot = `${call.computerId}/${call.generation}`;
        if (this.slots.has(slot)) return { method: "reserve", granted: true };
        if (this.slots.size >= this.maxAwakeComputers) {
          return {
            method: "reserve",
            granted: false,
            reason: "at_capacity",
            awake: this.slots.size,
            limit: this.maxAwakeComputers,
          };
        }
        this.slots.add(slot);
        return { method: "reserve", granted: true };
      }
      case "release":
        return {
          method: "release",
          released: this.slots.delete(`${call.computerId}/${call.generation}`),
        };
      case "forget_computer": {
        let forgotten = false;
        for (const [name, id] of this.computers) {
          if (id === call.computerId) forgotten = this.computers.delete(name);
        }
        for (const slot of this.slots) {
          if (slot.startsWith(`${call.computerId}/`)) this.slots.delete(slot);
        }
        return { method: "forget_computer", forgotten };
      }
      case "limits":
        return {
          method: "limits",
          maxAwakeComputers: this.maxAwakeComputers,
          maxInstanceSize: this.maxInstanceSize,
        };
    }
  }

  #mint(): ComputerId {
    this.#next += 1;
    let n = this.#next;
    let id = "";
    for (let i = 0; i < 26; i += 1) {
      id = (base32[n % 32] as string) + id;
      n = Math.floor(n / 32);
    }
    return `cmp_${id}`;
  }
}
