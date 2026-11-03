import { describe, expect, it } from "vitest";
import {
  AccessAdmissionCall,
  ADMISSION_SIGNING_PROTOCOL,
  admissionStringToSign,
  ForwardedPerson,
} from "../src/index.ts";

describe("teams contracts (WP8.3)", () => {
  it("signs an admission call over four lines, its own protocol first", () => {
    // The server image's adapter (cfo_server/admission.py) builds the same lines.
    expect(
      admissionStringToSign({
        keyId: "key-1",
        timestamp: "1800000000",
        bodySha256: "ab".repeat(32),
      }),
    ).toBe(`${ADMISSION_SIGNING_PROTOCOL}\nkey-1\n1800000000\n${"ab".repeat(32)}`);
    expect(ADMISSION_SIGNING_PROTOCOL).toBe("cfo-access-admission/v1");
  });

  it("refuses an admission list longer than Omnigent sends, and an uppercase address", () => {
    const emails = Array.from({ length: 1001 }, (_, i) => `p${i}@example.test`);
    expect(AccessAdmissionCall.safeParse({ revision: 1, emails }).success).toBe(false);
    expect(
      AccessAdmissionCall.safeParse({ revision: 1, emails: emails.slice(0, 1000) }).success,
    ).toBe(true);
    const person = {
      issuer: "https://i",
      subject: "s",
      audience: "a",
      installationOwner: false,
      expiresAt: 1,
    };
    expect(ForwardedPerson.safeParse({ ...person, email: "A@example.test" }).success).toBe(false);
    expect(ForwardedPerson.safeParse({ ...person, email: "a@example.test" }).success).toBe(true);
  });
});
