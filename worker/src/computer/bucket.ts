// The checkpoint bucket's credential bundles (the controller's `CheckpointBucket`): reads, lists
// and deletes on the R2 binding, and every put through the backup gateway's write fence
// (`egress/backups.ts`, `credentialWriter`), named by the generation whose upload it is. Reads and
// deletes are never fenced: deletes are the cleanup the fence relies on (the lead's decisions,
// 26 Oct). Types only from the runtime, so it is tested in Node.

import type { CheckpointBucket } from "./controller.ts";

/** The R2 operations the adapter uses directly: no put. */
export interface R2Reader {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: readonly { key: string }[]; truncated: boolean; cursor?: string }>;
}

/** A put through the write fence, for this generation's pending upload. */
export type FencedPut = (key: string, body: Uint8Array, generation: number) => Promise<void>;

export function r2Bucket(bucket: R2Reader, put: FencedPut): CheckpointBucket {
  return {
    async put(key, body, writer) {
      await put(key, body, writer.generation);
    },
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
        keys.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return keys;
    },
  };
}
