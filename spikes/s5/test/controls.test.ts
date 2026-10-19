// IR-017: the campaign-control checks, as a pure function. The Worker-level tests, through the
// real route handler in workerd with zero-effect checks, are in scripts/local-run.ts, section
// "campaign controls (IR-017)".

import { describe, expect, it } from "vitest";
import {
  ARM_DEFAULT_SECONDS,
  ARM_MAX_SECONDS,
  armUntil,
  CONTROLS,
  checkControl,
  constantTimeEqual,
  currentIntent,
  isArmed,
  newIntent,
  PAGE_HEADERS,
  renderConfirmation,
} from "../src/controls.ts";
import { CARD_HEADERS } from "../src/repair-card.ts";

const ORIGIN = "https://cfo-stg-s5-access.example.com";
const INTENT = newIntent();
const base = {
  origin: ORIGIN,
  secFetchSite: "same-origin" as string | null,
  expectedOrigin: ORIGIN,
  presented: INTENT as string | null,
  expected: INTENT as string | undefined,
  needsArm: true,
  armed: true,
};

describe("checkControl", () => {
  it("accepts a valid same-origin control", () => {
    expect(checkControl(base)).toBeUndefined();
    expect(checkControl({ ...base, secFetchSite: null })).toBeUndefined();
  });

  it.each([
    ["foreign origin", { origin: "https://attacker.example" }],
    ["null origin", { origin: "null" }],
    ["missing origin", { origin: null }],
    ["sibling origin", { origin: "https://evil.example.com" }],
    ["scheme downgrade", { origin: ORIGIN.replace("https", "http") }],
    ["trailing slash", { origin: `${ORIGIN}/` }],
    ["cross-site fetch metadata", { secFetchSite: "cross-site" }],
    ["same-site fetch metadata", { secFetchSite: "same-site" }],
    ["typed-in navigation metadata", { secFetchSite: "none" }],
  ])("refuses %s", (_, change) => {
    expect(checkControl({ ...base, ...change })).toBe("bad_origin");
  });

  it("refuses a simple cross-site form, with or without the token", () => {
    const form = { origin: "https://attacker.example", secFetchSite: "cross-site" };
    expect(checkControl({ ...base, ...form, presented: null })).toBe("bad_origin");
    expect(checkControl({ ...base, ...form })).toBe("bad_origin");
  });

  it.each([
    ["missing token", null],
    ["empty token", ""],
    ["wrong token", newIntent()],
    ["token prefix", INTENT.slice(0, 20)],
    ["token with extra", `${INTENT}x`],
  ])("refuses a %s", (_, presented) => {
    expect(checkControl({ ...base, presented })).toBe("bad_intent");
  });

  it("refuses everything when no token is configured", () => {
    expect(checkControl({ ...base, expected: undefined })).toBe("controls_disabled");
  });

  it("refuses a fault or scenario control outside an armed campaign", () => {
    expect(checkControl({ ...base, armed: false })).toBe("not_armed");
    expect(checkControl({ ...base, armed: false, needsArm: false })).toBeUndefined();
  });

  it("checks origin before the token, and both before arming", () => {
    expect(checkControl({ ...base, origin: null, presented: null, armed: false })).toBe(
      "bad_origin",
    );
    expect(checkControl({ ...base, presented: null, armed: false })).toBe("bad_intent");
  });
});

describe("campaign state", () => {
  it("uses the stored token, else the seed, and nothing shorter than 32 characters", () => {
    expect(currentIntent({ intent: INTENT }, "x".repeat(40))).toBe(INTENT);
    expect(currentIntent({}, INTENT)).toBe(INTENT);
    expect(currentIntent(undefined, undefined)).toBeUndefined();
    expect(currentIntent({}, "short")).toBeUndefined();
  });

  it("arms for a bounded time and disarms itself", () => {
    const now = 1_800_000_000_000;
    expect(armUntil(now, undefined)).toBe(now + ARM_DEFAULT_SECONDS * 1000);
    expect(armUntil(now, "5")).toBe(now + 5000);
    expect(armUntil(now, "999999")).toBe(now + ARM_MAX_SECONDS * 1000);
    expect(armUntil(now, "0")).toBe(now + 1000);
    expect(armUntil(now, "-5")).toBe(now + 1000);
    expect(armUntil(now, "soon")).toBe(now + ARM_DEFAULT_SECONDS * 1000);
    const until = armUntil(now, "5");
    expect(isArmed({ armedUntil: until }, now + 4999)).toBe(true);
    expect(isArmed({ armedUntil: until }, now + 5000)).toBe(false);
    expect(isArmed({}, now)).toBe(false);
    expect(isArmed(undefined, now)).toBe(false);
  });

  it("generates distinct 256-bit tokens and compares them exactly", () => {
    const a = newIntent();
    expect(a).toHaveLength(43);
    expect(newIntent()).not.toBe(a);
    expect(constantTimeEqual(a, a)).toBe(true);
    expect(constantTimeEqual(a, `${a.slice(0, 42)}A`)).toBe(a.endsWith("A"));
    expect(constantTimeEqual(a, "")).toBe(false);
  });
});

describe("confirmation page", () => {
  it("is a page whose one form POSTs the control with the token", () => {
    const html = renderConfirmation("/__s5/run", INTENT, undefined, 0);
    expect(html).toContain('<form method="post" action="/__s5/run">');
    expect(html).toContain(`name="intent" value="${INTENT}"`);
    expect(html).toContain('data-armed="false"');
    expect(html.match(/<form /g)).toHaveLength(1);
  });

  it("shows the arming deadline and the arm duration field", () => {
    const html = renderConfirmation("/__s5/arm", INTENT, 10_000, 0, "disarmed");
    expect(html).toContain('data-armed="true"');
    expect(html).toContain('name="seconds"');
    expect(html).toContain('data-message="disarmed"');
  });

  it("lists every control, and marks fault and scenario controls as needing a campaign", () => {
    for (const path of ["/__s5/run", "/__s5/fault/revoke-grant", "/__s5/fault/drop-access"]) {
      expect(CONTROLS[path]?.needsArm).toBe(true);
    }
    for (const path of [
      "/__s5/arm",
      "/__s5/disarm",
      "/platform/bootstrap",
      "/platform/schedules",
    ]) {
      expect(CONTROLS[path]?.needsArm).toBe(false);
    }
  });
});

// Under no-referrer a browser sends `Origin: null` with a page's own form POST, which the origin
// check refuses. same-origin keeps the real Origin for that POST and gives other sites nothing.
describe("pages that post keep the Origin of their own form submissions", () => {
  for (const [page, headers] of [
    ["confirmation page", PAGE_HEADERS],
    ["repair card", CARD_HEADERS],
  ] as const) {
    it(`${page}: referrer-policy is same-origin`, () => {
      expect(headers["referrer-policy"]).toBe("same-origin");
    });
  }
});
