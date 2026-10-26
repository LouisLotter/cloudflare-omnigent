// A file-backed stand-in for an R2 bucket binding, with the calls DirectoryBackupGateway makes
// (get with a range, delete, createMultipartUpload, resumeMultipartUpload) and put and list.
// The driver and the gateway container share one directory. From spike S3 (and S1) unchanged.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const safe = (key) => encodeURIComponent(key);

export function fileBucket(root) {
  const objects = join(root, "objects");
  const uploads = join(root, "uploads");
  return {
    async get(key, options = {}) {
      const path = join(objects, safe(key));
      let info;
      try {
        info = await stat(path);
      } catch {
        return null;
      }
      const offset = options.range?.offset ?? 0;
      const length = options.range?.length ?? info.size - offset;
      const end = Math.min(info.size, offset + length) - 1;
      const body =
        end < offset
          ? new ReadableStream({ start: (c) => c.close() })
          : Readable.toWeb(createReadStream(path, { start: offset, end }));
      return { key, size: info.size, body };
    },
    async put(key, value) {
      await mkdir(objects, { recursive: true });
      await writeFile(join(objects, safe(key)), value);
      return { key };
    },
    async list({ prefix = "" } = {}) {
      let names = [];
      try {
        names = await readdir(objects);
      } catch {
        // Nothing stored yet.
      }
      const keys = names.map(decodeURIComponent).filter((k) => k.startsWith(prefix));
      return { objects: keys.map((key) => ({ key })), truncated: false };
    },
    async delete(key) {
      await rm(join(objects, safe(key)), { force: true });
    },
    async createMultipartUpload(key) {
      const uploadId = crypto.randomUUID();
      await mkdir(join(uploads, uploadId), { recursive: true });
      return { key, uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const dir = join(uploads, uploadId);
      return {
        async uploadPart(partNumber, readable) {
          await pipeline(
            Readable.fromWeb(readable),
            createWriteStream(join(dir, String(partNumber).padStart(6, "0"))),
          );
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts) {
          await mkdir(objects, { recursive: true });
          const target = join(objects, safe(key));
          const out = createWriteStream(target);
          for (const { partNumber } of parts) {
            const name = String(partNumber).padStart(6, "0");
            await pipeline(createReadStream(join(dir, name)), out, { end: false });
          }
          await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
          await rm(dir, { recursive: true, force: true });
          return { key, size: (await stat(target)).size };
        },
        async abort() {
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  };
}
