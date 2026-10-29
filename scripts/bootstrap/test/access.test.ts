import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addressesIn,
  coversHostname,
  isServiceTokenPolicy,
  ownerOnlyAccess,
  ownerOnlyAppBody,
  ownerOnlyProblems,
} from "../access.ts";
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

describe("the shared builder and check (staging tool and bootstrap, WP3.31)", () => {
  it("builds what it checks: an application from the builder, as Cloudflare answers, passes", () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.domain(),
        fc.option(fc.uuid(), { nil: undefined }),
        (email, hostname, idp) => {
          const body = ownerOnlyAppBody({
            name: "n",
            hostname,
            ownerEmail: email,
            identityProviderId: idp,
          });
          const answered = {
            ...body,
            id: "x",
            aud: "a".repeat(64),
            options_preflight_bypass: false,
          };
          const check = { hostname, isOwner: (e: string) => e === email };
          expect(ownerOnlyProblems(answered, check)).toEqual([]);
          expect(addressesIn(answered)).toEqual([email]);
          expect(coversHostname(answered, hostname)).toBe(true);
          // Any second address, or any other rule beside the owner's, is refused.
          const widened = (rule: unknown) => ({
            ...answered,
            policies: [{ decision: "allow", include: [{ email: { email } }, rule] }],
          });
          for (const rule of [
            { email: { email: `x${email}` } },
            { everyone: {} },
            { email_domain: { domain: hostname } },
            { any_valid_service_token: {} },
          ]) {
            expect(ownerOnlyProblems(widened(rule), check).map((p) => p.aspect)).toEqual(["rules"]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("adds the login method and skips the chooser only when one is named", () => {
    const body = ownerOnlyAppBody({
      name: "n",
      hostname: HOST,
      ownerEmail: OWNER_EMAIL,
      identityProviderId: "idp-1",
    });
    expect(body).toMatchObject({ allowed_idps: ["idp-1"], auto_redirect_to_identity: true });
    const all = ownerOnlyAppBody({ name: "n", hostname: HOST, ownerEmail: OWNER_EMAIL });
    expect(all).not.toHaveProperty("allowed_idps");
    expect(all).not.toHaveProperty("auto_redirect_to_identity");
    expect(all).toMatchObject({ session_duration: "24h", app_launcher_visible: false });
  });

  it("covers a hostname through its domain, a destination or a path, never another host", () => {
    expect(coversHostname(app(), HOST)).toBe(true);
    expect(coversHostname(app({ domain: `${HOST}/admin` }), HOST)).toBe(true);
    expect(
      coversHostname(
        app({ domain: "other.example.test", destinations: [{ type: "public", uri: HOST }] }),
        HOST,
      ),
    ).toBe(true);
    expect(
      coversHostname(
        app({ domain: "other.example.test", self_hosted_domains: [`${HOST}/x`] }),
        HOST,
      ),
    ).toBe(true);
    expect(coversHostname(app({ domain: `${HOST}.evil.test` }), HOST)).toBe(false);
    expect(coversHostname(app({ domain: `x${HOST}` }), HOST)).toBe(false);
    expect(coversHostname("nothing", HOST)).toBe(false);
    expect(coversHostname(app({ domain: undefined, destinations: [null, { uri: 7 }] }), HOST)).toBe(
      false,
    );
  });

  it("names each difference once, with its fix, and never an address", () => {
    const problems = ownerOnlyProblems(
      app({
        type: "saas",
        domain: `${HOST}/x`,
        aud: undefined,
        same_site_cookie_attribute: "strict",
        options_preflight_bypass: true,
        policies: [
          { name: "One", decision: "allow", include: [{ everyone: {} }, { everyone: {} }] },
          { decision: "allow", include: [{ email: { email: "x@example.test" } }] },
          { name: "", decision: "bypass", include: [] },
          { decision: "allow" },
        ],
      }),
      { hostname: HOST, isOwner: () => false },
    );
    expect(problems.map((p) => [p.aspect, p.why, p.fix])).toEqual([
      [
        "application",
        "is not a self-hosted application",
        "delete it; a self-hosted application takes its place",
      ],
      ["application", `does not cover exactly ${HOST}`, `set its domain to ${HOST}, with no path`],
      ["aud", "has no AUD tag", "delete it; a new application gets one"],
      [
        "cookie",
        "does not set its cookie to SameSite=lax",
        "under Settings, Cookie settings, set Same Site Attribute to Lax",
      ],
      [
        "preflight",
        "bypasses Access for CORS preflight",
        "under Settings, CORS settings, turn off Bypass options requests to origin",
      ],
      [
        "rules",
        "admits something other than one email address",
        'make the only rule of the policy "One" Emails with the owner\'s address',
      ],
      [
        "rules",
        "admits someone other than the owner",
        "remove every address but the owner's from that policy",
      ],
      [
        "rules",
        "has a policy that is not an allow (a bypass or a service token)",
        "remove that policy",
      ],
      ["rules", "has a policy with no rule", "remove that policy"],
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/@/);
    expect(ownerOnlyProblems(null, { hostname: HOST, isOwner: () => true })).toHaveLength(5);
  });

  it("admits the staging tool's one service token policy only when asked, once", () => {
    const owner = { decision: "allow", include: [{ email: { email: OWNER_EMAIL } }] };
    const token = { decision: "non_identity", include: [{ service_token: { token_id: "t" } }] };
    const check = {
      hostname: HOST,
      isOwner: (e: string) => e === OWNER_EMAIL,
      serviceTokenId: "t",
    };
    expect(ownerOnlyProblems(app({ policies: [owner, token] }), check)).toEqual([]);
    expect(
      ownerOnlyProblems(app({ policies: [owner, token, token] }), check).map((p) => p.why),
    ).toEqual(["admits its service token more than once"]);
    expect(ownerOnlyProblems(app({ policies: [token] }), check).map((p) => p.why)).toEqual([
      "has no policy that allows the owner",
    ]);
    expect(isServiceTokenPolicy(null, "t")).toBe(false);
  });

  it("explains a refusal with its fixes on the read path too", async () => {
    const error = await ownerOnlyAccess(
      [app({ same_site_cookie_attribute: "none" })],
      HOST,
      await ownerPin(),
      TEAM,
    ).catch((e: Error) => e.message);
    expect(error).toBe(
      `the Access application on ${HOST} does not set its cookie to SameSite=lax. To fix it, open https://one.dash.cloudflare.com/, Access, Applications, edit it, and under Settings, Cookie settings, set Same Site Attribute to Lax. The bootstrap never changes or widens an application it did not create; not deploying`,
    );
  });
});
