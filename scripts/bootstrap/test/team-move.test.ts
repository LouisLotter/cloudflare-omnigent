// The team's move behind Access (WP8.11): what each status line lets it decide, this computer's
// host ID, the settings it renders and the secrets it adds, its record after a rollback, and the
// one change it makes to the installation's Access application.

import { describe, expect, it } from "vitest";
import type { TeamStatusReport } from "../../../contracts/src/team.ts";
import { type AccessApi, AccessRefusal, AccessUnavailable } from "../access-app.ts";
import {
  checkMove,
  hostConfigPath,
  localHostId,
  type MoveRules,
  moveSecrets,
  normalHostId,
  switchToMemberPolicy,
  type TeamMoveLine,
  type TeamRecord,
  teamAfterRollback,
  teamVars,
  webAdmitsMembers,
} from "../team-move.ts";
import { accountPlan, OWNER_EMAIL } from "./fixtures.ts";

const MOVE = "tm-20261103T150000Z-0a1b2c3d";
const PC = "a".repeat(32);
const LAPTOP = "c".repeat(32);
const CLOUD = "b".repeat(32);

function team(over: Partial<TeamStatusReport> = {}): TeamStatusReport {
  return {
    owners: 1,
    ownersBound: 1,
    revision: 2,
    hosts: [
      { hostId: PC, launchToken: false, installationOwner: true, identity: "owner" },
      { hostId: CLOUD, launchToken: true, installationOwner: true, identity: "none" },
    ],
    ...over,
  };
}

function line(over: Partial<TeamMoveLine> = {}): TeamMoveLine {
  return { id: MOVE, identityMode: "bind", team: team(), admissionApplied: 2, ...over };
}

const RULES: MoveRules = {
  moveId: MOVE,
  mode: "bind",
  hostId: PC,
  hostname: "omnigent.example.test",
};

describe("the move's checks", () => {
  it("is ready when the owner is bound, the group written and this computer's host the owner's", () => {
    expect(checkMove(line(), RULES)).toEqual({ kind: "ready", computers: 1 });
    expect(checkMove(line({ identityMode: "required" }), { ...RULES, mode: "required" })).toEqual({
      kind: "ready",
      computers: 1,
    });
  });

  it("waits for a line of its own move and mode", () => {
    for (const seen of [
      undefined,
      line({ id: "tm-20261103T150000Z-ffffffff" }),
      line({ identityMode: "off" }),
    ]) {
      expect(checkMove(seen, RULES).kind).toBe("waiting");
    }
    expect(checkMove(line(), { ...RULES, mode: "required" }).kind).toBe("waiting");
    expect(checkMove(line({ team: null }), RULES)).toEqual({
      kind: "waiting",
      why: "the server does not say yet who is bound",
    });
  });

  it("tells the owner exactly what to open while nobody is bound", () => {
    const check = checkMove(line({ team: team({ ownersBound: 0 }) }), RULES);
    expect(check.kind).toBe("waiting");
    expect(check.kind === "waiting" && check.why).toContain(
      "open https://omnigent.example.test in your browser and sign in to Omnigent once",
    );
  });

  it("waits for the member group to be written to the server's revision", () => {
    expect(checkMove(line({ admissionApplied: null }), RULES)).toEqual({
      kind: "waiting",
      why: "Access's member group is not written yet (revision none of 2)",
    });
    expect(checkMove(line({ admissionApplied: 1 }), RULES).kind).toBe("waiting");
  });

  it("waits for this computer's host to connect", () => {
    const check = checkMove(line({ team: team({ hosts: [] }) }), RULES);
    expect(check.kind === "waiting" && check.why).toContain(
      "this computer's host (aaaaaaaa…) is not connected",
    );
  });

  it("stops at bind when this computer's host presents a sign-in nobody is bound to", () => {
    const unbound = team({
      hosts: [{ hostId: PC, launchToken: false, installationOwner: true, identity: "unbound" }],
    });
    const check = checkMove(line({ team: unbound }), RULES);
    expect(check.kind).toBe("stopped");
    expect(check.kind === "stopped" && check.why).toContain(
      "the device's sign-in is not the same Access identity as your browser's. The installation stays in bind mode, where it keeps working",
    );
    for (const identity of ["other", "none"] as const) {
      const hosts = [{ hostId: PC, launchToken: false, installationOwner: true, identity }];
      expect(checkMove(line({ team: team({ hosts }) }), RULES).kind).toBe("stopped");
    }
  });

  it("stops at bind for another of the owner's hosts that required mode would refuse", () => {
    const hosts = [
      ...team().hosts,
      { hostId: LAPTOP, launchToken: false, installationOwner: true, identity: "unbound" as const },
    ];
    const check = checkMove(line({ team: team({ hosts }) }), RULES);
    expect(check.kind === "stopped" && check.why).toContain("cccccccc…");
    // Someone else's host is not the owner's to fix, and a cloud computer has no sign-in.
    const theirs = [
      ...team().hosts,
      {
        hostId: LAPTOP,
        launchToken: false,
        installationOwner: false,
        identity: "unbound" as const,
      },
    ];
    expect(checkMove(line({ team: team({ hosts: theirs }) }), RULES).kind).toBe("ready");
  });

  it("needs a host ID, or the owner's word that there is no personal host", () => {
    expect(checkMove(line(), { ...RULES, hostId: undefined }).kind).toBe("stopped");
    expect(checkMove(line({ team: team({ hosts: [] }) }), { ...RULES, hostId: "none" })).toEqual({
      kind: "ready",
      computers: 0,
    });
  });

  it("stops when the team has no active owner", () => {
    expect(checkMove(line({ team: team({ owners: 0, ownersBound: 0 }) }), RULES).kind).toBe(
      "stopped",
    );
  });
});

describe("this computer's host ID", () => {
  const files: Record<string, string> = {};
  const read = (path: string) => {
    const text = files[path];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  const config = (id: string) =>
    [
      "server:",
      "  host_id: not-this-one",
      "host:",
      "  name: workstation",
      `  host_id: "${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}"  # mine`,
      "other: 1",
    ].join("\n");

  it("reads the platform host's configuration where omnigent-host.sh keeps it", () => {
    // XDG_CONFIG_HOME set, OMNIGENT_CONFIG_HOME unset: as on the owner's computer.
    files["/xdg/omnigent-cfo/config.yaml"] = config(PC);
    files["/home/me/.omnigent/config.yaml"] = config(LAPTOP);
    expect(hostConfigPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/omnigent-cfo/config.yaml");
    expect(localHostId({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" }, read)).toBe(PC);
    // An explicit OMNIGENT_CONFIG_HOME (the host wrapper's) wins.
    files["/explicit/config.yaml"] = config(CLOUD);
    expect(localHostId({ XDG_CONFIG_HOME: "/xdg", OMNIGENT_CONFIG_HOME: "/explicit" }, read)).toBe(
      CLOUD,
    );
    expect(localHostId({ XDG_CONFIG_HOME: "/nowhere" }, read)).toBeUndefined();
    files["/xdg/omnigent-cfo/config.yaml"] = "host:\n  name: workstation\n";
    expect(localHostId({ XDG_CONFIG_HOME: "/xdg" }, read)).toBeUndefined();
  });

  it("falls back to ~/.config/omnigent-cfo, never Omnigent's own ~/.omnigent", () => {
    const asked: string[] = [];
    const record = (path: string) => {
      asked.push(path);
      throw new Error("ENOENT");
    };
    expect(localHostId({}, record)).toBeUndefined();
    expect(
      localHostId({ OMNIGENT_CONFIG_HOME: "  ", XDG_CONFIG_HOME: " " }, record),
    ).toBeUndefined();
    expect(asked).toHaveLength(2);
    for (const path of asked) {
      expect(path).toMatch(/[\\/]\.config[\\/]omnigent-cfo[\\/]config\.yaml$/);
      expect(path).not.toMatch(/\.omnigent[\\/]/);
    }
  });

  it("takes Omnigent's forms of a host ID and refuses anything else", () => {
    expect(normalHostId(`host_${PC}`)).toBe(PC);
    expect(normalHostId(PC.toUpperCase())).toBe(PC);
    for (const bad of ["", "none", "a".repeat(31), "g".repeat(32)])
      expect(normalHostId(bad)).toBeUndefined();
  });
});

describe("the move's settings and secrets", () => {
  const recorded: TeamRecord = {
    id: MOVE,
    startedAt: "2026-11-03T15:00:00.000Z",
    memberGroup: { name: "web--members--n", id: "group-1" },
    token: { name: "platform-access", id: "tok-1" },
  };

  it("renders the team's variables once the group is recorded, and members admission only from the web step", () => {
    expect(teamVars(undefined, "acct")).toEqual({ platform: {}, web: {} });
    expect(teamVars(recorded, "acct")).toEqual({
      platform: {
        CFO_IDENTITY_ENVELOPE: "on",
        CFO_ACCESS_ACCOUNT_ID: "acct",
        CFO_ACCESS_GROUP_ID: "group-1",
        SERVER_ENV_CFO_ACCESS_ADMISSION: "true",
      },
      web: {},
    });
    const web = { ...recorded, webStartedAt: "2026-11-03T16:00:00.000Z" };
    expect(webAdmitsMembers(web)).toBe(true);
    expect(teamVars(web, "acct").web).toEqual({ TEAM_ADMISSION: "members" });
  });

  it("adds bind, the move and the token, and never weakens a finished move's mode", () => {
    expect(moveSecrets(new Set(), recorded, "token-value")).toEqual({
      SERVER_ENV_OMNIGENT_EXTERNAL_IDENTITY_MODE: "bind",
      CFO_TEAM_MOVE: MOVE,
      CFO_ACCESS_GROUP_TOKEN: "token-value",
    });
    const held = new Set(["SERVER_ENV_OMNIGENT_EXTERNAL_IDENTITY_MODE", "CFO_TEAM_MOVE"]);
    expect(moveSecrets(held, recorded, undefined)).toEqual({});
    const finished = { ...recorded, requiredAt: "x", finishedAt: "2026-11-03T17:00:00.000Z" };
    expect(moveSecrets(new Set(), finished, undefined)).toEqual({
      SERVER_ENV_OMNIGENT_EXTERNAL_IDENTITY_MODE: "required",
    });
  });

  it("starts an unfinished move again after a rollback, its token listed for deletion", () => {
    const halfway = { ...recorded, boundAt: "2026-11-03T15:30:00.000Z", requiredStartedAt: "y" };
    expect(teamAfterRollback(halfway)).toEqual({
      id: MOVE,
      startedAt: recorded.startedAt,
      memberGroup: recorded.memberGroup,
      tokensToDelete: [recorded.token],
    });
    const finished = { ...recorded, finishedAt: "2026-11-03T17:00:00.000Z" };
    expect(teamAfterRollback(finished)).toBe(finished);
    // A move rolled back before it had a group or a token keeps only its ID.
    const bare = { id: MOVE, startedAt: recorded.startedAt };
    expect(teamAfterRollback(bare)).toEqual(bare);
    expect(teamAfterRollback(undefined)).toBeUndefined();
  });

  it("keeps the token the latest upload still holds when Cloudflare kept the rolled-back versions", () => {
    const halfway = { ...recorded, boundAt: "2026-11-03T15:30:00.000Z" };
    // The first move: started again, its token its own.
    expect(teamAfterRollback(halfway, undefined, true)).toEqual({
      id: MOVE,
      startedAt: recorded.startedAt,
      memberGroup: recorded.memberGroup,
      token: recorded.token,
    });
    // A later window that replaced a lost token: the stage restored, the new token kept, and
    // only the one that window's run gave up listed.
    const lost = { name: "cfo-access-old", id: "token-old" };
    const replaced = { ...halfway, requiredAt: "z", tokensToDelete: [lost] };
    const stage = { ...halfway, token: lost };
    expect(teamAfterRollback(replaced, stage, true)).toEqual({
      ...halfway,
      tokensToDelete: [lost],
    });
    expect(teamAfterRollback(replaced, stage, false)).toEqual({
      ...stage,
      tokensToDelete: [recorded.token],
    });
    expect(teamAfterRollback(undefined, undefined, true)).toBeUndefined();
    const finished = { ...recorded, finishedAt: "2026-11-03T17:00:00.000Z" };
    expect(teamAfterRollback(finished, undefined, true)).toEqual(finished);
  });
});

describe("the application's policy", () => {
  function api(app: Record<string, unknown>, keeps = true, forbidden = false) {
    const writes: Record<string, unknown>[] = [];
    let current = structuredClone(app);
    const access = {
      app: () => structuredClone(current),
      update: (_id: string, body: Record<string, unknown>) => {
        if (forbidden) throw new AccessUnavailable("403");
        writes.push(body);
        if (keeps) current = { ...structuredClone(body), id: app.id, aud: app.aud };
      },
    } as unknown as AccessApi;
    return { access, writes };
  }
  const app = {
    id: "app-1",
    aud: "a".repeat(64),
    created_at: "2026-10-01T00:00:00Z",
    type: "self_hosted",
    name: "web--n",
    domain: "omnigent.example.test",
    session_duration: "24h",
    same_site_cookie_attribute: "lax",
    options_preflight_bypass: false,
    http_only_cookie_attribute: true,
    policies: [
      {
        id: "p1",
        name: "Owner",
        decision: "allow",
        include: [{ email: { email: OWNER_EMAIL } }],
        precedence: 1,
      },
    ],
  };

  it("replaces the owner's address with the member group, every other setting as read", async () => {
    const plan = await accountPlan();
    const { access, writes } = api(app);
    await switchToMemberPolicy(access, plan, "app-1", "group-1");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.policies).toEqual([
      { name: "Allow team members", decision: "allow", include: [{ group: { id: "group-1" } }] },
    ]);
    expect(writes[0]).toMatchObject({
      domain: "omnigent.example.test",
      same_site_cookie_attribute: "lax",
    });
    expect(writes[0]).not.toHaveProperty("created_at");
    expect(JSON.stringify(writes)).not.toContain(OWNER_EMAIL);
  });

  it("says what to do when the login may not, and fails when Access did not keep it", async () => {
    const plan = await accountPlan();
    await expect(
      switchToMemberPolicy(api(app, true, true).access, plan, "app-1", "group-1"),
    ).rejects.toThrow(AccessRefusal);
    await expect(
      switchToMemberPolicy(api(app, false).access, plan, "app-1", "group-1"),
    ).rejects.toThrow(/did not keep the member group/);
    const gone = { app: () => undefined, update: () => undefined } as unknown as AccessApi;
    await expect(switchToMemberPolicy(gone, plan, "app-1", "group-1")).rejects.toThrow(/is gone/);
  });
});
