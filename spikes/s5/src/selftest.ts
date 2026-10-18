// Spike S5: negative cases derived from one genuine Access assertion.
//
// In staging, Access stops every request that lacks a valid session before the Worker runs, so
// the Worker never sees a forged, expired or foreign token from outside. To exercise its checks
// on the real runtime with the team's real keys, the deployed Worker takes the owner's genuine
// assertion and derives each negative case from it: a flipped signature byte, a payload edited
// after signing, the same token judged as another application or another team would judge it, a
// clock past its expiry, and so on. A token for another application differs from this one only
// in `aud`, so judging this token with another application's AUD tag is the same predicate.

import {
  type AccessConfig,
  type AccessFailure,
  base64UrlDecode,
  base64UrlEncode,
  checkHost,
  type KeySource,
  MAX_ASSERTION_BYTES,
  sha256Hex,
  validateAccessJwt,
} from "./access.ts";

export interface SelfTestCase {
  readonly name: string;
  readonly expected: "ok" | AccessFailure;
  readonly got: "ok" | AccessFailure;
  readonly pass: boolean;
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;
}

export async function deriveNegativeCases(
  token: string,
  config: AccessConfig,
  keys: KeySource,
  nowSeconds: number,
  host: { url: URL; allowed: readonly string[] },
  otherAudience: string,
): Promise<SelfTestCase[]> {
  const [h, p, s] = token.split(".") as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  const leeway = config.leewaySeconds ?? 30;
  const signature = base64UrlDecode(s);
  const flipped = new Uint8Array(signature);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
  const exp = typeof payload.exp === "number" ? payload.exp : nowSeconds;
  const notBefore = typeof payload.nbf === "number" ? payload.nbf : (payload.iat as number);

  const cases: [string, "ok" | AccessFailure, () => Promise<"ok" | AccessFailure>][] = [];
  const run =
    (t: string | null, c: AccessConfig = config, now = nowSeconds) =>
    async () => {
      const r = await validateAccessJwt(t, c, keys, now);
      return r.ok ? "ok" : r.reason;
    };

  cases.push(["genuine assertion", "ok", run(token)]);
  cases.push(["missing assertion", "missing_assertion", run(null)]);
  cases.push(["empty assertion", "missing_assertion", run("")]);
  cases.push(["truncated", "malformed", run(`${h}.${p}`)]);
  cases.push(["oversized", "oversized", run(`${h}.${p}.${"A".repeat(MAX_ASSERTION_BYTES)}`)]);
  cases.push([
    "signature byte flipped",
    "bad_signature",
    run(`${h}.${p}.${base64UrlEncode(flipped)}`),
  ]);
  cases.push([
    "payload edited after signing (aud swapped)",
    "bad_signature",
    run(`${h}.${encodeJson({ ...payload, aud: [otherAudience] })}.${s}`),
  ]);
  cases.push([
    "payload edited after signing (exp extended)",
    "bad_signature",
    run(`${h}.${encodeJson({ ...payload, exp: exp + 86_400 })}.${s}`),
  ]);
  cases.push([
    "alg none",
    "unsupported_alg",
    run(`${encodeJson({ ...header, alg: "none" })}.${p}.AA`),
  ]);
  cases.push([
    "alg HS256 (key confusion)",
    "unsupported_alg",
    run(`${encodeJson({ ...header, alg: "HS256" })}.${p}.${s}`),
  ]);
  cases.push([
    "unknown key id",
    "unknown_kid",
    run(`${encodeJson({ ...header, kid: "0".repeat(64) })}.${p}.${s}`),
  ]);
  cases.push([
    "another application (other AUD)",
    "wrong_audience",
    run(token, { ...config, audience: otherAudience }),
  ]);
  cases.push([
    "another team (other issuer)",
    "wrong_issuer",
    run(token, { ...config, issuer: "https://another-team.cloudflareaccess.com" }),
  ]);
  cases.push(["expired (clock past exp)", "expired", run(token, config, exp + leeway + 1)]);
  cases.push([
    "not yet valid (clock before nbf)",
    "not_yet_valid",
    run(token, config, notBefore - leeway - 120),
  ]);
  cases.push([
    "another identity (owner pin)",
    "not_owner",
    run(token, {
      ...config,
      ownerEmailSha256: await sha256Hex("someone-else@example.invalid"),
    }),
  ]);
  cases.push([
    "unknown hostname",
    "unknown_host",
    async () =>
      checkHost(new URL("https://attacker.example/"), host.allowed) ? "ok" : "unknown_host",
  ]);
  cases.push([
    "this hostname",
    "ok",
    async () => (checkHost(host.url, host.allowed) ? "ok" : "unknown_host"),
  ]);

  const results: SelfTestCase[] = [];
  for (const [name, expected, test] of cases) {
    const got = await test();
    results.push({ name, expected, got, pass: got === expected });
  }
  return results;
}
