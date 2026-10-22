/**
 * The fakes' record of operations by operation ID, as the real controllers must keep it: an ID is
 * bound to its request when the operation begins, a repeat of the same request returns the
 * recorded outcome once there is one, and an ID reused for any other request is refused with
 * `conflict`, without touching the record.
 */
import { platformError } from "../../src/shared/errors.ts";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "interfaceVersion")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, stable(v)]),
    );
  }
  return value;
}

/** A request's identity for the journal: every field but the interface version, keys sorted. */
export function fingerprint(request: unknown): string {
  return JSON.stringify(stable(request));
}

export class OperationJournal<T> {
  readonly #entries = new Map<string, { readonly request: string; outcome?: T }>();

  /**
   * Binds `operationId` to `request` if it is new. Returns the recorded outcome if the operation
   * settled, or undefined if it is new or still in progress.
   */
  begin(operationId: string, request: unknown): T | undefined {
    const print = fingerprint(request);
    const entry = this.#entries.get(operationId);
    if (entry === undefined) {
      this.#entries.set(operationId, { request: print });
      return undefined;
    }
    if (entry.request !== print) {
      throw platformError("conflict", "operation ID reused for another request");
    }
    return entry.outcome;
  }

  /** Records the outcome of an operation that began. */
  settle(operationId: string, outcome: T): void {
    const entry = this.#entries.get(operationId);
    if (entry === undefined) throw new Error(`operation ${operationId} never began`);
    entry.outcome = outcome;
  }
}
