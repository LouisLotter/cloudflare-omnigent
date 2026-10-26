/**
 * Shared state between the Workers-runtime tests and the test ControlDO
 * (platform-test-worker.ts): the WorkspaceDOs its reconciliation reaches, a test clock, the
 * timing and the limit settings per ControlDO name. workerd runs this module in the tests' own
 * isolate, so a test and the Durable Object share it.
 *
 * Each computer is 3.C's `FakeWorkspace` (its `reservation` answers `reservationState`). A test can
 * make one unreachable, make it answer something that breaks the contract, or run a step while
 * ControlDO waits for its answer (to race a reconciliation against a reservation or a release).
 *
 * The clock starts a day ahead of real time, so an alarm the object schedules from it never fires
 * by itself during a test run: tests run reconciliation with `runDurableObjectAlarm`.
 */
import type { ComputerId } from "@cfo/contracts";
import { CONTROL_TIMING, type ControlTiming } from "../../src/control/ControlDO.ts";
import type { LimitSettings } from "../../src/control/limits.ts";
import { platformError } from "../../src/shared/errors.ts";
import { FakeWorkspace } from "./fake-workspace.ts";

const DAY_MS = 86_400_000;

type Behaviour =
  | { readonly kind: "unreachable" }
  | { readonly kind: "answers"; readonly value: unknown }
  | { readonly kind: "hangs" }
  | { readonly kind: "meanwhile"; readonly step: () => Promise<void> | void };

class TestControl {
  #now = Date.now() + DAY_MS;
  timing: ControlTiming = { ...CONTROL_TIMING, reportTimeoutMs: 200 };
  /** Use the production `workspace()` hook (no WORKSPACE binding on this branch). */
  productionWorkspace = false;
  readonly #settings = new Map<string, LimitSettings>();
  readonly #workspaces = new Map<string, FakeWorkspace>();
  readonly #behaviour = new Map<string, Behaviour>();
  /** Every computer ControlDO asked for its reservation, in order. */
  readonly asked: ComputerId[] = [];

  now(): number {
    return this.#now;
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }

  /** The limit settings of the ControlDO with this name (unset: the production defaults). */
  setSettings(objectName: string, settings: LimitSettings): void {
    this.#settings.set(objectName, settings);
  }

  settings(objectName: string | undefined): LimitSettings | undefined {
    return objectName === undefined ? undefined : this.#settings.get(objectName);
  }

  /** The computer's WorkspaceDO fake, created on first use. */
  computer(computerId: ComputerId): FakeWorkspace {
    let fake = this.#workspaces.get(computerId);
    if (fake === undefined) {
      fake = new FakeWorkspace(computerId);
      this.#workspaces.set(computerId, fake);
    }
    return fake;
  }

  /** How the computer's WorkspaceDO answers the next reservation calls; null restores it. */
  behave(computerId: ComputerId, behaviour: Behaviour | null): void {
    if (behaviour === null) this.#behaviour.delete(computerId);
    else this.#behaviour.set(computerId, behaviour);
  }

  /** What the test ControlDO's `workspace()` returns. */
  workspace(computerId: ComputerId): Pick<FakeWorkspace, "reservation"> {
    return {
      reservation: async (call) => {
        this.asked.push(computerId);
        const behaviour = this.#behaviour.get(computerId);
        if (behaviour?.kind === "unreachable") {
          throw platformError("unavailable", "WorkspaceDO is unreachable");
        }
        if (behaviour?.kind === "hangs") return new Promise(() => undefined);
        const fake = this.computer(computerId);
        const answer = await fake.reservation(call);
        if (behaviour?.kind === "answers") return behaviour.value as typeof answer;
        if (behaviour?.kind === "meanwhile") {
          this.#behaviour.delete(computerId);
          await behaviour.step();
        }
        return answer;
      },
    };
  }
}

export const testControl = new TestControl();
