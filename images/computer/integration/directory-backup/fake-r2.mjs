// A file-backed stand-in for an R2 bucket binding, with the calls DirectoryBackupGateway makes
// (get with a range, delete, createMultipartUpload, resumeMultipartUpload) and put and list.
// The driver and the gateway container share one directory. From spike S3 (and S1), with
// WP3.22's part fault.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const safe = (key) => encodeURIComponent(key);

/**
 * WP3.22's faults: each line of `<root>/fail-parts` fails one part upload as R2's lost connection
 * did on staging (27 Oct 2026), and the SDK's real gateway answers the real shim 502 with R2's
 * message. `late`: after the part's bytes arrived (the shim then reports the 502, as on
 * staging); `early`: before (the shim is still sending, and reports a broken pipe).
 */
async function takeFailure(root) {
  let lines = [];
  try {
    lines = (await readFile(join(root, "fail-parts"), "utf8")).split("\n").filter(Boolean);
  } catch {
    return null;
  }
  if (!lines.length) return null;
  await writeFile(join(root, "fail-parts"), lines.slice(1).join("\n"));
  return lines[0];
}

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
          const failure = await takeFailure(root);
          if (failure === "early") {
            await readable.cancel().catch(() => undefined);
            throw new Error("Network connection lost.");
          }
          if (failure !== null) {
            for await (const _ of Readable.fromWeb(readable)) {
              // The bytes arrive; R2 then loses the connection.
            }
            throw new Error("Network connection lost.");
          }
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
