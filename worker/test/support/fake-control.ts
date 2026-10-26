/**
 * In-memory fake of ControlDO (WP3.2's), for WorkspaceDO's tests (WP3.1) and the launcher API's
 * (WP3.3). It keeps ControlDO's rules, so callers cannot come to rely on a laxer one:
 *   - `register_computer` is idempotent by name: `provision` repeated after a lost reply gets the
 *     same computer;
 *   - a reservation is a (computer, generation) slot; a repeat returns the same answer, and a wake
 *     at the limit is refused at once with the counts, with no queue (R-20);
 *   - generations are finished in order (`control/limits.ts`): asking for generation G, or
 *     releasing it, finishes every older one of that computer, and forgetting a computer finishes
 *     all of them. A reservation at or below the highest finished generation is refused with
 *     `stale_generation`, also when a granted operation is replayed after its slot was released;
 *     a granted reservation replaces the computer's older slots, which do not count against the
 *     limit; a finished generation is refused even while its slot is still held;
 *   - at most 1000 computers are recorded; an operation ID is bound to the fields ControlDO acts
 *     on;
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
import { OperationJournal } from "./operation-journal.ts";

const base32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** The most computers ControlDO records (`list_computers` answers at most this many). */
const MAX_COMPUTERS = 1000;

/** The fields ControlDO acts on: an operation ID is bound to these, so a repeat that differs only
 * in fields added later is the same request, as ControlDO treats it. */
function actedOn(call: ControlCall): unknown {
  switch (call.method) {
    case "register_computer":
      return { method: call.method, name: call.name };
    case "reserve":
    case "release":
      return { method: call.method, computerId: call.computerId, generation: call.generation };
    case "forget_computer":
      return { method: call.method, computerId: call.computerId };
    default:
      return { method: call.method };
  }
}

/** A mutating call's operation ID; read-only calls have none. */
function operationIdOf(call: object): string | undefined {
  const id = (call as { readonly operationId?: unknown }).operationId;
  return typeof id === "string" ? id : undefined;
}

export class FakeControl implements ControlRpc {
  maxAwakeComputers = 2;
  maxInstanceSize: InstanceSize = "standard-4";
  unavailable = false;
  readonly calls: ControlCall[] = [];
  /** name → computer. */
  readonly computers = new Map<string, ComputerId>();
  /** `${computerId}/${generation}` slots. */
  readonly slots = new Set<string>();
  /** Per computer, the highest generation known to be finished. */
  readonly floors = new Map<ComputerId, number>();
  /** Mutating calls by operation ID, each bound to its request: a repeat returns the recorded
   * answer, even after capacity frees (a refused reservation replayed must not take a slot nobody
   * starts), and an ID reused for another request is `conflict`. */
  readonly #operations = new OperationJournal<ControlResult>();
  #next = 0;

  async control(raw: ControlCall): Promise<ControlResult> {
    // The version first, as ControlDO does: a newer caller may use a method this code lacks.
    const version = (raw as { readonly interfaceVersion?: unknown } | null | undefined)
      ?.interfaceVersion;
    if (typeof version === "number" && version > CONTROL_INTERFACE_VERSION) {
      throw platformError("unsupported_version", `interface version ${version}`);
    }
    const parsed = ControlCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a ControlCall");
    const call = parsed.data;
    if (this.unavailable) throw platformError("unavailable", "ControlDO is unavailable");
    this.calls.push(call);
    const operationId = operationIdOf(call);
    const recorded =
      operationId === undefined ? undefined : this.#operations.begin(operationId, actedOn(call));
    if (recorded) {
      if (
        call.method === "reserve" &&
        recorded.method === "reserve" &&
        recorded.granted &&
        (call.generation <= (this.floors.get(call.computerId) ?? -1) ||
          !this.slots.has(`${call.computerId}/${call.generation}`))
      ) {
        throw platformError("stale_generation", "the slot granted to this operation was released");
      }
      return recorded;
    }
    const result = this.#answer(call);
    if (operationId !== undefined) this.#operations.settle(operationId, result);
    return result;
  }

  #answer(call: ControlCall): ControlResult {
    switch (call.method) {
      case "register_computer": {
        let computerId = this.computers.get(call.name);
        if (!computerId) {
          if (this.computers.size >= MAX_COMPUTERS) {
            throw platformError(
              "conflict",
              `the installation already has ${MAX_COMPUTERS} computers`,
            );
          }
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
        const floor = this.floors.get(call.computerId) ?? -1;
        // A finished generation first, even while its slot is still held.
        if (call.generation <= floor) {
          throw platformError("stale_generation", `generation ${call.generation} is finished`);
        }
        this.floors.set(call.computerId, Math.max(floor, call.generation - 1));
        if (this.slots.has(slot)) return { method: "reserve", granted: true };
        const own = [...this.slots].filter((s) => {
          const [computer, generation] = s.split("/");
          return computer === call.computerId && Number(generation) < call.generation;
        });
        const awake = this.slots.size - own.length;
        if (awake >= this.maxAwakeComputers) {
          return {
            method: "reserve",
            granted: false,
            reason: "at_capacity",
            awake,
            limit: this.maxAwakeComputers,
          };
        }
        for (const old of own) this.slots.delete(old);
        this.slots.add(slot);
        return { method: "reserve", granted: true };
      }
      case "release": {
        const floor = this.floors.get(call.computerId) ?? -1;
        this.floors.set(call.computerId, Math.max(floor, call.generation));
        return {
          method: "release",
          released: this.slots.delete(`${call.computerId}/${call.generation}`),
        };
      }
      case "forget_computer": {
        let forgotten = false;
        for (const [name, id] of this.computers) {
          if (id === call.computerId) forgotten = this.computers.delete(name);
        }
        for (const slot of this.slots) {
          if (slot.startsWith(`${call.computerId}/`)) this.slots.delete(slot);
        }
        this.floors.set(call.computerId, Number.MAX_SAFE_INTEGER);
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
