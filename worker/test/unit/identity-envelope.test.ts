// Omnigent's identity envelope as OmnigentServer signs it (WP8.3). The vector is the fork's
// (`tests/server/test_external_identity.py`, `_VECTOR`), so the signer here and the verifier
// there agree byte for byte; the key derivation is the server image's (`envelope_key`).

import { describe, expect, it } from "vitest";
import { envelopeKey, signEnvelope } from "../../src/server/identity-envelope.ts";

const KEY = "cfo-test-envelope-key-0123456789abcdef";
const PERSON = {
  issuer: "https://example-team.cloudflareaccess.com",
  subject: "7335d417-61da-459d-899c-0a01c76a2f94",
  audience: "32eafc7626e974616deaf0dc3ce63d7bcbed58a2731e84d06bc3cdf1b53c4228",
  email: "alice@example.test",
  installationOwner: false,
  expiresAt: 1_800_000_600,
};
const VECTOR =
  "v1.eyJhdWQiOiIzMmVhZmM3NjI2ZTk3NDYxNmRlYWYwZGMzY2U2M2Q3YmNiZWQ1OGEyNzMxZTg0ZDA2YmMzY2Rm" +
  "MWI1M2M0MjI4IiwiZW1haWwiOiJhbGljZUBleGFtcGxlLnRlc3QiLCJleHAiOjE4MDAwMDAwNjAsImlhdCI6MTgw" +
  "MDAwMDAwMCwiaXNzIjoiaHR0cHM6Ly9leGFtcGxlLXRlYW0uY2xvdWRmbGFyZWFjY2Vzcy5jb20iLCJvd25lciI6" +
  "ZmFsc2UsInN1YiI6IjczMzVkNDE3LTYxZGEtNDU5ZC04OTljLTBhMDFjNzZhMmY5NCIsInYiOjF9" +
  ".kvKB20Zx20Fk5ptJO4wGFT04BEWmRXmPCVsgaFVY3I8";

function claimsOf(envelope: string): Record<string, unknown> {
  const payload = envelope.split(".")[1] ?? "";
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
}

describe("the identity envelope", () => {
  it("matches the fork's vector", async () => {
    expect(await signEnvelope(PERSON, KEY, 1_800_000_000)).toBe(VECTOR);
  });

  it("lasts sixty seconds, never past the assertion, and not at all once it expired", async () => {
    const claims = claimsOf((await signEnvelope(PERSON, KEY, 1_800_000_000)) ?? "");
    expect(claims.exp).toBe(1_800_000_060);
    const late = claimsOf((await signEnvelope(PERSON, KEY, 1_800_000_570.5)) ?? "");
    expect([late.iat, late.exp]).toEqual([1_800_000_570, 1_800_000_600]);
    expect(await signEnvelope(PERSON, KEY, 1_800_000_600)).toBeNull();
  });

  it("carries no email when the assertion has none, and marks the owner", async () => {
    const { email: _email, ...withoutEmail } = PERSON;
    const claims = claimsOf(
      (await signEnvelope({ ...withoutEmail, installationOwner: true }, KEY, 1_800_000_000)) ?? "",
    );
    expect(claims).not.toHaveProperty("email");
    expect(claims.owner).toBe(true);
  });

  it("derives the key the server image derives from the cookie secret", async () => {
    expect(await envelopeKey("ab".repeat(32))).toBe(
      "f9cc3e22721562f8fa6d7bec59e3fc79dfcc1b209f3192d12436e5563a28face",
    );
  });
});
