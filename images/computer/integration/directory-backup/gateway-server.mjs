// Runs in a container on the test network as backups.sandbox.internal, in place of the
// Worker's outbound intercept: every request from the computer's sandbox-shim goes to the SDK's
// real DirectoryBackupGateway, with the grant the driver last registered (grant.json) and the
// file-backed bucket. Adapted from spike S3's local harness, without its holds.
//
//   node --import /h/hooks.mjs /h/gateway-server.mjs   (R2_ROOT=/r2)

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DirectoryBackupGateway } from "@cloudflare/sandbox";
import { fileBucket } from "./fake-r2.mjs";

const root = process.env.R2_ROOT ?? "/r2";
const bucket = fileBucket(root);

createServer(async (req, res) => {
  try {
    const props = JSON.parse(await readFile(`${root}/grant.json`, "utf8"));
    const gateway = new DirectoryBackupGateway({ props }, { CKPT: bucket });
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    });
    const response = await gateway.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(error));
  }
}).listen(80, () => console.log("gateway listening on :80"));
