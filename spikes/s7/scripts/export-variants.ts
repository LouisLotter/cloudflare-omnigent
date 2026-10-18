// Writes the variant list for the two staging runners:
//   src/browser-variants.json        the variants a browser's fetch() can express
//   server/computer/variants.json    every raw variant, for the emulated computer's replay
//
//   node spikes/s7/scripts/export-variants.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SPIKE_DIR } from "./lib.ts";
import { VARIANTS } from "./variants.ts";

const AUTH_PLACEHOLDER = "__S7_AUTH__";
/** Request headers a browser's fetch() refuses to set. */
const FORBIDDEN_HEADERS = ["upgrade", "connection", "content-length", "transfer-encoding", "host"];
const FORBIDDEN_METHODS = ["CONNECT", "TRACE", "TRACK"];

function bodyBase64(body: Buffer | string | undefined): string | null {
  if (body === undefined) return null;
  return (Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")).toString("base64");
}

const browser = [];
const computer = [];
for (const variant of VARIANTS) {
  const request = variant.build(["Authorization", AUTH_PLACEHOLDER], 80);
  computer.push({
    id: variant.id,
    group: variant.group,
    description: variant.description,
    expect: variant.expect,
    line: request.line,
    headers: request.headers ?? [],
    bodyBase64: bodyBase64(request.body),
    chunked: request.chunked ?? false,
  });
  const match = /^([A-Za-z]+) (\/\S*) HTTP\/1\.1$/.exec(request.line);
  if (!match || request.chunked) continue;
  const [, method = "", path = ""] = match;
  if (FORBIDDEN_METHODS.includes(method.toUpperCase())) continue;
  // The browser sends Omnigent's session cookie itself; the bearer placeholder is dropped.
  const headers = (request.headers ?? []).filter(([name]) => name !== "Authorization");
  if (headers.some(([name]) => FORBIDDEN_HEADERS.includes(name.toLowerCase()))) continue;
  if (variant.id === "G05") continue; // anonymous: the browser always carries its cookie
  browser.push({
    id: variant.id,
    description: variant.description,
    expect: variant.expect,
    method,
    path,
    headers,
    // fetch() refuses a body on GET and HEAD; the override variants go without one.
    bodyBase64: ["GET", "HEAD"].includes(method.toUpperCase()) ? null : bodyBase64(request.body),
  });
}

writeFileSync(
  join(SPIKE_DIR, "src", "browser-variants.json"),
  `${JSON.stringify(browser, null, 2)}\n`,
);
mkdirSync(join(SPIKE_DIR, "server", "computer"), { recursive: true });
writeFileSync(
  join(SPIKE_DIR, "server", "computer", "variants.json"),
  `${JSON.stringify(computer, null, 2)}\n`,
);
console.log(`browser variants: ${browser.length}; computer variants: ${computer.length}`);
