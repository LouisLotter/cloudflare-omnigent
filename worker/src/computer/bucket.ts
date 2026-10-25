// The checkpoint bucket's credential bundles on an R2 binding (the controller's
// `CheckpointBucket`). Types only from the runtime, so it is tested in Node.

import type { CheckpointBucket } from "./controller.ts";

/** The R2 operations the adapter uses. */
export interface R2Like {
  put(key: string, body: Uint8Array): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(key: string): Promise<void>;
}

export function r2Bucket(bucket: R2Like): CheckpointBucket {
  return {
    async put(key, body) {
      await bucket.put(key, body);
    },
    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
