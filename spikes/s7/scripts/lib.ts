// Shared helpers for the S7 scripts: a raw HTTP/1.1 client, login, and direct server inspection.
//
// The variants need exact control of the request line (method case, unnormalized paths,
// absolute-form targets) and of the body framing, which fetch() and node:http normalize away.
// So requests are written byte for byte on a TCP socket.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SPIKE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RUN_DIR = join(SPIKE_DIR, ".run");
export const RESULTS_DIR = join(SPIKE_DIR, "results");
export const SERVER_CONTAINER = "cfo-s7-omnigent";
export const SERVER_PORT = Number(process.env.S7_SERVER_PORT ?? 18700);
export const BROWSER_PORT = Number(process.env.S7_BROWSER_PORT ?? 8787);
export const COMPUTER_PORT = Number(process.env.S7_COMPUTER_PORT ?? 8788);

/** The values the deployment manages; server.sh starts Omnigent with exactly these. */
export const MANAGED = {
  sharing_mode: "read_only",
  public_sharing_enabled: false,
  public_sharing_max_level: "read",
  default_public_sessions: "off",
} as const;

/** Omnigent's sharing override files in its data directory. Any successful PUT creates one. */
export const OVERRIDE_FILES = [
  "sharing_mode",
  "public_sharing",
  "public_sharing_max_level",
  "default_public_sessions",
];
const DATA_DIR = "/data/state";

export interface RawRequest {
  /** The exact request line, without CRLF, for example `PUT /v1/sharing HTTP/1.1`. */
  readonly line: string;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly body?: Buffer | string;
  /** Send the body with chunked transfer encoding instead of Content-Length. */
  readonly chunked?: boolean;
}

export interface RawResponse {
  /** 0 when the peer closed or reset without a parseable response. */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function decodeChunked(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < data.length) {
    const end = data.indexOf("\r\n", offset);
    if (end < 0) break;
    const size = Number.parseInt(
      data.subarray(offset, end).toString("latin1").split(";")[0] ?? "",
      16,
    );
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(data.subarray(end + 2, end + 2 + size));
    offset = end + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/** Sends one request on a fresh connection and reads until the peer closes it. */
export function rawRequest(port: number, request: RawRequest): Promise<RawResponse> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const data = Buffer.concat(chunks);
      const split = data.indexOf("\r\n\r\n");
      if (split < 0) {
        resolve({ status: 0, headers: {}, body: data.toString("utf8") });
        return;
      }
      const head = data.subarray(0, split).toString("latin1").split("\r\n");
      const status = Number((head[0] ?? "").split(" ")[1] ?? 0) || 0;
      const headers: Record<string, string> = {};
      for (const line of head.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0) {
          const name = line.slice(0, colon).trim().toLowerCase();
          const value = line.slice(colon + 1).trim();
          headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
        }
      }
      let body = data.subarray(split + 4);
      if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked")) {
        body = decodeChunked(body);
      }
      resolve({ status, headers, body: body.toString("utf8") });
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish();
    }, 15_000);
    // Some servers (wrangler dev among them) keep the connection open after a complete response
    // despite `Connection: close`. Stop reading as soon as the response is complete.
    const isHead = request.line.toUpperCase().startsWith("HEAD ");
    const complete = (): boolean => {
      const data = Buffer.concat(chunks);
      const split = data.indexOf("\r\n\r\n");
      if (split < 0) return false;
      const head = data.subarray(0, split).toString("latin1").toLowerCase();
      const status = Number(head.split(" ")[1] ?? 0);
      if (isHead || status === 204 || status === 304 || (status >= 100 && status < 200)) {
        return true;
      }
      const body = data.subarray(split + 4);
      const length = /\r\ncontent-length:\s*(\d+)/.exec(head);
      if (length) return body.length >= Number(length[1]);
      if (/\r\ntransfer-encoding:[^\r]*chunked/.test(head)) return body.includes("0\r\n\r\n");
      return false;
    };
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (complete()) {
        socket.destroy();
        finish();
      }
    });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
    socket.on("connect", () => {
      const body =
        request.body === undefined
          ? undefined
          : Buffer.isBuffer(request.body)
            ? request.body
            : Buffer.from(request.body, "utf8");
      const lines = [request.line, `Host: 127.0.0.1:${port}`];
      for (const [name, value] of request.headers ?? []) lines.push(`${name}: ${value}`);
      if (body !== undefined && request.chunked) lines.push("Transfer-Encoding: chunked");
      else if (body !== undefined) lines.push(`Content-Length: ${body.length}`);
      lines.push("Connection: close", "", "");
      socket.write(Buffer.from(lines.join("\r\n"), "latin1"));
      if (body !== undefined && request.chunked) {
        const half = Math.ceil(body.length / 2);
        for (const part of [body.subarray(0, half), body.subarray(half)]) {
          if (part.length === 0) continue;
          socket.write(`${part.length.toString(16)}\r\n`);
          socket.write(part);
          socket.write("\r\n");
        }
        socket.write("0\r\n\r\n");
      } else if (body !== undefined) {
        socket.write(body);
      }
    });
  });
}

export interface Credentials {
  /** `Authorization` header value, as a computer's host or CLI sends it. */
  readonly bearer: string;
  /** `Cookie` header value, as the browser sends it. */
  readonly cookie: string;
}

/** Logs in as the pre-provisioned owner, directly against the server. Never prints secrets. */
export async function login(port = SERVER_PORT): Promise<Credentials> {
  const secrets = Object.fromEntries(
    readFileSync(join(RUN_DIR, "secrets.env"), "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const response = await rawRequest(port, {
    line: "POST /auth/login HTTP/1.1",
    headers: [["Content-Type", "application/json"]],
    body: JSON.stringify({
      username: secrets.S7_ADMIN_USERNAME,
      password: secrets.S7_ADMIN_PASSWORD,
    }),
  });
  if (response.status !== 200) throw new Error(`login failed with status ${response.status}`);
  const token = (JSON.parse(response.body) as { token: string }).token;
  const setCookie = response.headers["set-cookie"] ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  return { bearer: `Bearer ${token}`, cookie };
}

export interface SharingState {
  readonly status: number;
  readonly sharing_mode?: string;
  readonly public_sharing_enabled?: boolean;
  readonly public_sharing_max_level?: string;
  readonly default_public_sessions?: string;
  readonly [key: string]: unknown;
}

/** Reads the settings straight from the server, bypassing the Worker. */
export async function directState(creds: Credentials): Promise<SharingState> {
  const response = await rawRequest(SERVER_PORT, {
    line: "GET /v1/sharing HTTP/1.1",
    headers: [["Authorization", creds.bearer]],
  });
  if (response.status !== 200) return { status: response.status };
  return { status: 200, ...(JSON.parse(response.body) as object) };
}

export function isManagedState(state: SharingState): boolean {
  return (
    state.status === 200 &&
    state.sharing_mode === MANAGED.sharing_mode &&
    state.public_sharing_enabled === MANAGED.public_sharing_enabled &&
    state.public_sharing_max_level === MANAGED.public_sharing_max_level &&
    state.default_public_sessions === MANAGED.default_public_sessions
  );
}

/** Override files present in the server's data directory. */
export function overrideFiles(): string[] {
  // The data directory does not exist until Omnigent first writes to it.
  const list = `import os; d=${JSON.stringify(DATA_DIR)}; print("\\n".join(os.listdir(d)) if os.path.isdir(d) else "")`;
  const out = execFileSync("docker", ["exec", SERVER_CONTAINER, "python", "-c", list], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => OVERRIDE_FILES.includes(s));
}

/** Removes every override file, returning the server to the managed values. */
export function resetOverrides(): void {
  execFileSync("docker", [
    "exec",
    SERVER_CONTAINER,
    "rm",
    "-f",
    ...OVERRIDE_FILES.map((f) => `${DATA_DIR}/${f}`),
  ]);
}

/** Access-log lines naming a sharing-like path since `since`; Docker keeps stdout and stderr. */
export function serverLogLines(since: string): string[] {
  const result = spawnSync("docker", ["logs", "--since", since, SERVER_CONTAINER], {
    encoding: "utf8",
  });
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((l) => /"[A-Za-z]+ \S*(sharing|%73|%2F|%5C)/i.test(l));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
