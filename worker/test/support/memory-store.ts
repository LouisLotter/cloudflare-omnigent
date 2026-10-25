/**
 * The controller's `Store` in memory, for Node tests and the simulation. Values are kept as JSON
 * text, as SQLite keeps them, so a caller can never change a stored value by mutating what it read.
 * A transaction commits every write or none, and transactions nest.
 *
 * `beforeCommit` runs at every commit of an outermost transaction: the simulation throws from it
 * to crash the controller between a decision and its persistence, and `afterCommit` to crash right
 * after a transition is persisted, before its effects.
 */
import type { Store } from "../../src/computer/record.ts";

export class MemoryStore implements Store {
  readonly data = new Map<string, string>();
  #tx: Map<string, string | null> | null = null;
  #depth = 0;
  beforeCommit: (() => void) | null = null;
  afterCommit: (() => void) | null = null;
  commits = 0;

  get(key: string): unknown {
    const pending = this.#tx?.get(key);
    const text = pending === undefined ? this.data.get(key) : pending;
    return text === undefined || text === null ? undefined : (JSON.parse(text) as unknown);
  }

  put(key: string, value: unknown): void {
    this.#write(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.#write(key, null);
  }

  #write(key: string, text: string | null): void {
    if (this.#tx !== null) this.#tx.set(key, text);
    else if (text === null) this.data.delete(key);
    else this.data.set(key, text);
  }

  keys(prefix: string, limit = Number.POSITIVE_INFINITY): readonly string[] {
    const all = new Set(this.data.keys());
    for (const [key, text] of this.#tx ?? []) {
      if (text === null) all.delete(key);
      else all.add(key);
    }
    return [...all]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit < 0 ? undefined : limit);
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      this.#depth += 1;
      try {
        return fn();
      } finally {
        this.#depth -= 1;
      }
    }
    this.#tx = new Map();
    this.#depth = 1;
    try {
      const result = fn();
      this.beforeCommit?.();
      for (const [key, text] of this.#tx) {
        if (text === null) this.data.delete(key);
        else this.data.set(key, text);
      }
      this.commits += 1;
      this.#tx = null;
      this.#depth = 0;
      this.afterCommit?.();
      return result;
    } finally {
      this.#tx = null;
      this.#depth = 0;
    }
  }

  /** The stored text of every key, for checks that no secret was persisted. */
  dump(): string {
    return [...this.data].map(([key, text]) => `${key}=${text}`).join("\n");
  }
}
