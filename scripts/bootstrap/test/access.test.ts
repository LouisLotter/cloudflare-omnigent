import { describe, expect, it } from "vitest";
import { ownerOnlyAccess } from "../access.ts";
import { OWNER_EMAIL, ownerPin } from "./fixtures.ts";

const HOST = "omnigent.example.test";
const TEAM = "team.cloudflareaccess.com";

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    name: "omnigent",
    domain: HOST,
    type: "self_hosted",
    aud: "a".repeat(64),
    same_site_cookie_attribute: "lax",
    options_preflight_bypass: false,
    policies: [
      { name: "Allow owner", decision: "allow", include: [{ email: { email: OWNER_EMAIL } }] },
    ],
    ...overrides,
  };
}

const allow = (...include: unknown[]) => [{ decision: "allow", include }];

describe("ownerOnlyAccess", () => {
  it("returns the team domain and AUD of an owner-only application", async () => {
    expect(
      await ownerOnlyAccess(
        [app(), app({ domain: "other.example.test" })],
        HOST,
        await ownerPin(),
        TEAM,
      ),
    ).toEqual({
      teamDomain: TEAM,
      aud: "a".repeat(64),
    });
  });

  it("matches the owner's address as ingress does: trimmed and lowercased", async () => {
    const policies = allow({ email: { email: `  ${OWNER_EMAIL.toUpperCase()} ` } });
    await expect(
      ownerOnlyAccess([app({ policies })], HOST, await ownerPin(), TEAM),
    ).resolves.toBeDefined();
  });

  it.each([
    ["no application", [], /found 0/],
    ["two applications", [app(), app({ id: "app-2" })], /found 2/],
    ["not self-hosted", [app({ type: "saas" })], /not a self-hosted application/],
    ["no AUD", [app({ aud: "" })], /has no AUD tag/],
    ["SameSite unset", [app({ same_site_cookie_attribute: undefined })], /SameSite=lax/],
    ["preflight bypass", [app({ options_preflight_bypass: true })], /CORS preflight/],
    ["no policy", [app({ policies: [] })], /has no policy/],
    [
      "a bypass",
      [app({ policies: [{ decision: "bypass", include: [{ everyone: {} }] }] })],
      /not an allow/,
    ],
    [
      "a service token",
      [
        app({
          policies: [
            ...allow({ email: { email: OWNER_EMAIL } }),
            { decision: "non_identity", include: [{ service_token: { token_id: "t" } }] },
          ],
        }),
      ],
      /not an allow/,
    ],
    ["everyone", [app({ policies: allow({ everyone: {} }) })], /other than one email address/],
    [
      "an email domain",
      [app({ policies: allow({ email_domain: { domain: "example.test" } }) })],
      /other than one email address/,
    ],
    [
      "another person",
      [app({ policies: allow({ email: { email: "someone-else@example.test" } }) })],
      /someone other than the owner/,
    ],
    [
      "the owner and another person",
      [
        app({
          policies: allow(
            { email: { email: OWNER_EMAIL } },
            { email: { email: "x@example.test" } },
          ),
        }),
      ],
      /someone other than the owner/,
    ],
    [
      "a policy with no rule",
      [app({ policies: [{ decision: "allow", include: [] }] })],
      /policy with no rule/,
    ],
    [
      "a rule with more keys",
      [app({ policies: allow({ email: { email: OWNER_EMAIL }, everyone: {} }) })],
      /other than one email/,
    ],
    [
      "an email rule with more keys",
      [app({ policies: allow({ email: { email: OWNER_EMAIL, x: 1 } }) })],
      /other than one email/,
    ],
  ])("refuses %s", async (_name, apps, message) => {
    await expect(ownerOnlyAccess(apps, HOST, await ownerPin(), TEAM)).rejects.toThrow(message);
  });

  it("needs the team's domain and a well-formed pin", async () => {
    await expect(ownerOnlyAccess([app()], HOST, await ownerPin(), undefined)).rejects.toThrow(
      /team domain/,
    );
    await expect(ownerOnlyAccess([app()], HOST, "not-a-pin", TEAM)).rejects.toThrow(
      /owner pin is malformed/,
    );
  });

  it("never names an address in its errors", async () => {
    const error = await ownerOnlyAccess(
      [app({ policies: allow({ email: { email: "someone-else@example.test" } }) })],
      HOST,
      await ownerPin(),
      TEAM,
    ).catch((e: Error) => e.message);
    expect(error).not.toMatch(/@/);
  });
});
