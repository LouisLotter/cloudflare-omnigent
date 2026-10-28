// WP3.23: the sign-in link check and the sign-in commands' fencing rules as the contract states
// them. The supervisor's own parser (Python) applies the same rule; its tests replay the pinned
// CLIs' captured transcripts.
import { describe, expect, it } from "vitest";
import {
  COMPUTER_API_MESSAGES,
  SIGN_IN_LINKS,
  SignInCode,
  SignInUserCode,
  SignInView,
  SUPERVISOR_FEATURES,
  SupervisorHello,
  signInLinkAllowed,
} from "../src/index.ts";

const CLAUDE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile+user%3Ainference&code_challenge=c&code_challenge_method=S256&state=s";
const CODEX = "https://auth.openai.com/codex/device";

describe("sign-in links", () => {
  it("accepts the pinned CLIs' own links", () => {
    expect(signInLinkAllowed("claude", CLAUDE)).toBe(true);
    expect(signInLinkAllowed("codex", CODEX)).toBe(true);
  });

  it.each([
    ["claude", CODEX, "the other provider's host"],
    ["codex", CLAUDE, "the other provider's host"],
    ["claude", CLAUDE.replace("https:", "http:"), "plain HTTP"],
    ["claude", CLAUDE.replace("claude.com", "claude.com.example.net"), "a longer host"],
    ["claude", CLAUDE.replace("claude.com", "evil.example@claude.com"), "user information"],
    ["claude", CLAUDE.replace("claude.com", "claude.com:8443"), "a port"],
    ["claude", CLAUDE.replace("/cai/oauth/authorize", "/cai/oauth/other"), "another path"],
    ["codex", `${CODEX}/../../x`, "a path that leaves the expected one"],
    ["codex", "https://AUTH.openai.com/codex/device", "an uppercase host"],
    ["codex", "https://%", "a link that does not parse"],
    ["codex", "javascript:alert(1)", "another scheme"],
    ["codex", `${CODEX}'onmouseover=x`, "an apostrophe"],
    ["codex", `${CODEX}?${"a".repeat(2048)}`, "a link over 2048 characters"],
    ["claude", "https://claude.com.", "a trailing dot"],
  ] as const)("refuses for %s: %s (%s)", (service, url, _why) => {
    expect(signInLinkAllowed(service, url)).toBe(false);
  });

  it("names exactly one host and path per service", () => {
    expect(Object.keys(SIGN_IN_LINKS).sort()).toEqual(["claude", "codex"]);
  });
});

describe("sign-in values", () => {
  it("takes Codex's code as it prints it, and nothing else", () => {
    expect(SignInUserCode.safeParse("ABCD-EFGH1").success).toBe(true);
    expect(SignInUserCode.safeParse("abcd-efgh1").success).toBe(false);
    expect(SignInUserCode.safeParse("ABCD EFGH1").success).toBe(false);
  });

  it("refuses a pasted code with whitespace or control characters", () => {
    expect(SignInCode.safeParse("abc#def").success).toBe(true);
    for (const bad of ["", "a b", "a\nb", "a\rb", "a\u0003", "ä", "x".repeat(1025)]) {
      expect(SignInCode.safeParse(bad).success).toBe(false);
    }
  });

  it("keeps a failed attempt's reason a fixed name", () => {
    expect(
      SignInView.safeParse({
        service: "claude",
        attempt: 1,
        state: "failed",
        reason: "Login failed: something",
      }).success,
    ).toBe(false);
  });

  it("lets a hello name its features, and an older one name none", () => {
    const hello = {
      type: "hello",
      protocolVersion: 1,
      computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3",
      generation: 1,
      operationId: "op_01hzy4a7b8c9d0e1f2g3h4j5k6",
      supervisorVersion: "0.2.0",
    };
    expect(SupervisorHello.safeParse(hello).success).toBe(true);
    expect(
      SupervisorHello.safeParse({ ...hello, features: [...SUPERVISOR_FEATURES, "later"] }).success,
    ).toBe(true);
  });

  it("fences starts and cancels by attempt; input by operation ID", () => {
    expect(COMPUTER_API_MESSAGES.sign_in_start.idempotency).toBe("attempt");
    expect(COMPUTER_API_MESSAGES.sign_in_cancel.idempotency).toBe("attempt");
    expect(COMPUTER_API_MESSAGES.sign_in_input.idempotency).toBe("operation_id");
    expect(COMPUTER_API_MESSAGES.sign_in_status.idempotency).toBe("read_only");
    expect(COMPUTER_API_MESSAGES.computer_status.idempotency).toBe("read_only");
  });
});
