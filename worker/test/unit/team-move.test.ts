// Moving a team of one behind Access (WP8.11): the move's secret, the server's identity mode, and
// the signed team-status call to the server container, which names nobody.

import {
  platformCallKey,
  platformCallStringToSign,
  sha256Hex,
  TEAM_STATUS_CALL_PATH,
} from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import {
  identityModeOf,
  newTeamMoveId,
  readTeamStatus,
  TEAM_MOVE_SECRET,
  teamMoveOf,
} from "../../src/server/team-move.ts";

const COOKIE_SECRET = "c".repeat(64);
const random = (n: number) => new Uint8Array(n).fill(0xab);
const REPORT = {
  owners: 1,
  ownersBound: 1,
  revision: 3,
  hosts: [
    { hostId: "a".repeat(32), launchToken: false, installationOwner: true, identity: "owner" },
  ],
};

describe("the team move's settings", () => {
  it("holds a move only for a well-formed ID", () => {
    const id = newTeamMoveId(Date.UTC(2026, 10, 3, 15, 4, 5), random);
    expect(id).toBe("tm-20261103T150405Z-abababab");
    expect(teamMoveOf({ [TEAM_MOVE_SECRET]: id })).toBe(id);
    for (const value of [undefined, "", "tm-yesterday", 7, `${id}x`]) {
      expect(teamMoveOf({ [TEAM_MOVE_SECRET]: value })).toBeNull();
    }
  });

  it("reads the server's identity mode, off unless bind or required", () => {
    const mode = (value: unknown) =>
      identityModeOf({ SERVER_ENV_OMNIGENT_EXTERNAL_IDENTITY_MODE: value });
    expect(mode("bind")).toBe("bind");
    expect(mode(" Required ")).toBe("required");
    for (const value of [undefined, "", "on", 1]) expect(mode(value)).toBe("off");
  });
});

describe("the team-status call", () => {
  function server(answer: () => Response) {
    const seen: Request[] = [];
    return {
      seen,
      fetch: async (request: Request) => {
        seen.push(request);
        return answer();
      },
    };
  }

  it("signs its call for its own path and reads the report", async () => {
    const s = server(() => Response.json(REPORT));
    const now = 1_800_000_000_000;
    expect(await readTeamStatus(s.fetch, COOKIE_SECRET, now, random)).toEqual(REPORT);
    const [request] = s.seen;
    expect(new URL(request?.url ?? "").pathname).toBe(TEAM_STATUS_CALL_PATH);
    const body = new Uint8Array(await (request as Request).arrayBuffer());
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({ nonce: "ab".repeat(16) });
    const timestamp = request?.headers.get("x-cfo-call-timestamp");
    expect(timestamp).toBe(String(now / 1000));
    // The signature covers this path: it is no good on another platform call.
    const key = await crypto.subtle.importKey(
      "raw",
      await platformCallKey(COOKIE_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const message = platformCallStringToSign({
      method: "POST",
      path: TEAM_STATUS_CALL_PATH,
      timestamp: String(timestamp),
      bodySha256: await sha256Hex(body),
    });
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(request?.headers.get("x-cfo-call-signature")).toBe(hex);
  });

  it("is null for a server that refuses, has no team model, names someone or fails", async () => {
    for (const answer of [
      () => new Response(null, { status: 501 }),
      () => new Response("nope", { status: 500 }),
      () => Response.json({ ...REPORT, hosts: [{ ...REPORT.hosts[0], email: "o@example.test" }] }),
      () => new Response("not json"),
      () => {
        throw new TypeError("connection refused");
      },
    ]) {
      expect(await readTeamStatus(server(answer).fetch, COOKIE_SECRET, 0, random)).toBeNull();
    }
  });
});
