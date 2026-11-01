// The sign-in check (scripts/host/signin-check.py, WP3.43; Codex r1-8 and r2), run as the real
// file with stand-ins for Omnigent's `omnigent.cli_auth` and for `httpx`. The stand-in's renewal
// logs Omnigent's own messages at the pinned fork (cli_auth.py, `_refresh_locked`), which the
// check reads to tell a refused grant from an unwell server.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHECK = resolve(import.meta.dirname, "..", "signin-check.py");
const URL = "https://omnigent.example.test";
const python = spawnSync("python3", ["--version"]).status === 0;

const CLI_AUTH = `
import json, logging, os
_logger = logging.getLogger(__name__)
S = json.loads(os.environ["FAKE_AUTH"])

def stored_token_status(url):
    return S["status"]

def load_token(url, *, min_remaining_seconds=0.0):
    # Like Omnigent's: any token not yet expired, unless a margin is asked for.
    if min_remaining_seconds > 0 and S.get("near_expiry"):
        return None
    return S.get("token")

def refresh_stored_token(url, *, timeout=10.0):
    with open(os.environ["FAKE_CALLS"], "a") as f:
        f.write("refresh\\n")
    r = S.get("refresh", "none")
    if r == "none":
        return None
    if r.startswith("token:"):
        return r[len("token:"):]
    if r == "transport":
        _logger.warning("Token refresh against %s failed: %s", url, "ConnectTimeout")
        return None
    if r.startswith("http:"):
        code = int(r[len("http:"):])
        if code == 404:
            _logger.warning("Token refresh against %s returned HTTP 404 — the server does not expose /oauth/token (wrong URL or a build without session refresh).", url)
            return None
        _logger.warning("Token refresh against %s refused (HTTP %d) — run \`omnigent login %s\` to re-authenticate.", url, code, url)
        return None
    raise AssertionError(r)
`;

const HTTPX = `
import json, os
class HTTPError(Exception): pass
class ConnectError(HTTPError): pass
class _Response:
    def __init__(self, status_code): self.status_code = status_code
def get(url, headers=None, timeout=None):
    assert url.endswith("/v1/me"), url
    with open(os.environ["FAKE_CALLS"], "a") as f:
        f.write("me\\n")
    token = headers["Authorization"].split(" ", 1)[1]
    answer = json.loads(os.environ["FAKE_ME"]).get(token, 401)
    if answer == "error":
        raise ConnectError("down")
    return _Response(answer)
`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-signin-"));
  mkdirSync(join(dir, "stubs", "omnigent"), { recursive: true });
  writeFileSync(join(dir, "stubs", "omnigent", "__init__.py"), "");
  writeFileSync(join(dir, "stubs", "omnigent", "cli_auth.py"), CLI_AUTH);
  writeFileSync(join(dir, "stubs", "httpx.py"), HTTPX);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(auth: Record<string, unknown>, me: Record<string, number | "error"> = {}) {
  const calls = join(dir, `calls-${Math.random().toString(16).slice(2)}`);
  writeFileSync(calls, "");
  const result = spawnSync("python3", [CHECK, URL], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      PYTHONPATH: join(dir, "stubs"),
      PYTHONDONTWRITEBYTECODE: "1",
      FAKE_AUTH: JSON.stringify(auth),
      FAKE_ME: JSON.stringify(me),
      FAKE_CALLS: calls,
    },
  });
  expect(result.stderr).toBe("");
  return { said: result.stdout.trim(), calls: readFileSync(calls, "utf8").trim().split("\n") };
}

describe.skipIf(!python)("signin-check.py", () => {
  it("says absent with nothing stored, and asks nothing", () => {
    expect(check({ status: "absent" })).toEqual({ said: "absent", calls: [""] });
  });

  it("asks the installation with a token not yet expired, even close to expiry (Codex r2)", () => {
    const r = check(
      { status: "ok", token: "t1", near_expiry: true, refresh: "transport" },
      { t1: 200 },
    );
    expect(r).toEqual({ said: "ok", calls: ["me"] });
  });

  it("renews an expired token, and tells a refused grant from an unwell server", () => {
    expect(check({ status: "expired", refresh: "token:t2" }, { t2: 200 }).said).toBe("ok");
    expect(check({ status: "expired", refresh: "none" }).said).toBe("expired");
    for (const code of [400, 401, 403]) {
      expect(check({ status: "expired", refresh: `http:${code}` }).said, String(code)).toBe(
        "expired",
      );
    }
    for (const refresh of ["transport", "http:502", "http:500", "http:429", "http:404"]) {
      const r = check({ status: "expired", refresh });
      expect(r.said, refresh).toBe("unknown renewal");
      expect(r.calls, refresh).toEqual(["refresh"]);
    }
  });

  it("signs in again when the installation rejects a token that looks valid (a password change)", () => {
    expect(check({ status: "ok", token: "t1", refresh: "http:401" }, { t1: 401 }).said).toBe(
      "rejected",
    );
    expect(check({ status: "ok", token: "t1", refresh: "none" }, { t1: 401 }).said).toBe(
      "rejected",
    );
    // A grant that is still good mends it.
    expect(
      check({ status: "ok", token: "t1", refresh: "token:t2" }, { t1: 401, t2: 200 }).said,
    ).toBe("ok");
    expect(
      check({ status: "ok", token: "t1", refresh: "token:t2" }, { t1: 401, t2: 401 }).said,
    ).toBe("rejected");
    // An unwell token endpoint after a 401 is not a reason to ask for the password.
    expect(check({ status: "ok", token: "t1", refresh: "transport" }, { t1: 401 }).said).toBe(
      "unknown renewal",
    );
  });

  it("does not guess when the installation does not answer", () => {
    expect(check({ status: "ok", token: "t1" }, { t1: 502 }).said).toBe("unknown 502");
    expect(check({ status: "ok", token: "t1" }, { t1: "error" }).said).toBe("unknown ConnectError");
    expect(check({ status: "ok", token: "t1" }, { t1: 403 }).said).toBe("unknown 403");
  });
});
