// A file-backed stand-in for an R2 bucket binding, with only the calls DirectoryBackupGateway
// makes: get (with a range), delete, createMultipartUpload and resumeMultipartUpload. The host
// driver and the gateway container share one directory, so both see the same objects.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
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
          out.setMaxListeners(0);
          const names = (await readdir(dir)).sort();
          if (names.length !== parts.length) throw new Error("parts do not match the upload");
          for (const name of names) {
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
