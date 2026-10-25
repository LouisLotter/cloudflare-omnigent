/**
 * An in-memory checkpoint bucket for the credential bundles (R2 in production). It can fail the
 * next writes or reads, so a test can block publication (FH-10, R-18).
 */
import type { CheckpointBucket } from "../../src/computer/controller.ts";

export class FakeBucket implements CheckpointBucket {
  readonly objects = new Map<string, Uint8Array>();
  failPuts = 0;
  failGets = 0;
  /** Every write fails while true: storage blocked. */
  blocked = false;
  readonly deleted: string[] = [];

  async put(key: string, body: Uint8Array): Promise<void> {
    if (this.blocked || this.failPuts > 0) {
      if (this.failPuts > 0) this.failPuts -= 1;
      throw new Error("R2: we encountered an internal error");
    }
    this.objects.set(key, new Uint8Array(body));
  }

  async get(key: string): Promise<Uint8Array | null> {
    if (this.failGets > 0) {
      this.failGets -= 1;
      throw new Error("R2: we encountered an internal error");
    }
    const body = this.objects.get(key);
    return body === undefined ? null : new Uint8Array(body);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    this.deleted.push(key);
  }

  /** Every stored byte, as text, for checks that a secret is or is not stored. */
  dump(): string {
    return [...this.objects.values()].map((b) => new TextDecoder().decode(b)).join("\n");
  }
}
