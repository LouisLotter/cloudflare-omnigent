// Teams behind Access (WP8.3): the installer's member group, the reconciler's token, the
// owner-only check with the group, and the update flag that waits for WP8.11.

import { describe, expect, it } from "vitest";
import { ownerOnlyProblems, pinCheck } from "../access.ts";
import { AccessUnavailable } from "../access-app.ts";
import type { ApiToken, TokenApi, TokenRequest } from "../r2-token.ts";
import {
  ACCESS_GROUPS_WRITE_GROUP,
  ACCOUNT_SCOPE,
  type AccessGroupsApi,
  admissionTokenRequest,
  ensureMemberGroup,
  makeAdmissionToken,
  memberGroupBody,
  memberPolicy,
  type RecordedMemberGroup,
  TEAM_ADMISSION_SUPPORTED,
  TeamAdmissionRefusal,
  teamAdmissionRefusal,
  teamAdmissionVars,
} from "../team-admission.ts";
import { updateCommand } from "../update-command.ts";
import { accountPlan, OWNER_EMAIL, ownerPin } from "./fixtures.ts";

const HOST = "omnigent.example.test";

class FakeGroups implements AccessGroupsApi {
  readonly byId = new Map<string, Record<string, unknown>>();
  creates = 0;
  refuse = false;
  /** The next create lands but its answer is lost. */
  loseAnswer = false;
  groups() {
    return [...this.byId.values()];
  }
  group(id: string) {
    return this.byId.get(id);
  }
  createGroup(body: Record<string, unknown>) {
    if (this.refuse) throw new AccessUnavailable("403");
    this.creates++;
    const id = `group-${this.creates}`;
    this.byId.set(id, { id, ...body });
    if (this.loseAnswer) {
      this.loseAnswer = false;
      throw new Error("connection reset");
    }
    return id;
  }
}

async function context(api: FakeGroups, recorded?: RecordedMemberGroup) {
  const plan = await accountPlan();
  const state = { recorded };
  const logs: string[] = [];
  return {
    state,
    logs,
    ctx: {
      api,
      plan,
      ownerEmail: OWNER_EMAIL,
      recorded: () => state.recorded,
      record: (group: RecordedMemberGroup | undefined) => {
        state.recorded = group;
      },
      now: () => Date.parse("2026-11-03T12:00:00Z"),
      sleep: async () => undefined,
      nonce: () => "0f1e2d3c",
      log: (line: string) => logs.push(line),
    },
  };
}

describe("the member group", () => {
  it("is created with the owner's address only, its intent journaled before the create", async () => {
    const api = new FakeGroups();
    const { ctx, state } = await context(api);
    const id = await ensureMemberGroup(ctx);
    expect(id).toBe("group-1");
    expect(api.group(id)).toMatchObject({
      name: `${ctx.plan.webWorker}--members--0f1e2d3c`,
      include: [{ email: { email: OWNER_EMAIL } }],
    });
    expect(state.recorded).toMatchObject({ id: "group-1" });
    // Run again: the recorded group is checked, not created twice.
    expect(await ensureMemberGroup(ctx)).toBe("group-1");
    expect(api.creates).toBe(1);
  });

  it("adopts the group an interrupted create made, rather than making a second", async () => {
    const api = new FakeGroups();
    api.loseAnswer = true;
    const { ctx, state } = await context(api);
    await expect(ensureMemberGroup(ctx)).rejects.toThrow("connection reset");
    expect(state.recorded?.id).toBeUndefined();
    expect(await ensureMemberGroup(ctx)).toBe("group-1");
    expect(api.creates).toBe(1);
  });

  it("refuses a group someone widened, and keeps one the team page changed", async () => {
    const api = new FakeGroups();
    const { ctx } = await context(api);
    const id = await ensureMemberGroup(ctx);
    const group = api.byId.get(id) as Record<string, unknown>;
    group.include = [{ email: { email: OWNER_EMAIL } }, { email: { email: "alice@example.test" } }];
    expect(await ensureMemberGroup(ctx)).toBe(id);
    group.include = [{ email: { email: OWNER_EMAIL } }, { everyone: {} }];
    await expect(ensureMemberGroup(ctx)).rejects.toThrow(TeamAdmissionRefusal);
    // The founding owner left or was suspended: the team's current owners are the reconciler's
    // check, so a later run keeps the group.
    group.include = [{ email: { email: "second-owner@example.test" } }];
    expect(await ensureMemberGroup(ctx)).toBe(id);
  });

  it("checks a new group admits the owner", async () => {
    const api = new FakeGroups();
    const create = api.createGroup.bind(api);
    // Access kept another address than the one created.
    api.createGroup = (body) =>
      create({ ...body, include: [{ email: { email: "x@example.test" } }] });
    const { ctx } = await context(api);
    await expect(ensureMemberGroup(ctx)).rejects.toThrow(/does not admit the owner/);
  });

  it("refuses another owner's address, and a login that may not create groups", async () => {
    const api = new FakeGroups();
    const { ctx } = await context(api);
    await expect(ensureMemberGroup({ ...ctx, ownerEmail: "mallory@example.test" })).rejects.toThrow(
      /not the owner/,
    );
    api.refuse = true;
    await expect(ensureMemberGroup(ctx)).rejects.toThrow(/may not create Access groups/);
    expect(api.creates).toBe(0);
  });

  it("has a body naming the owner and nothing else", () => {
    expect(memberGroupBody("g", OWNER_EMAIL)).toEqual({
      name: "g",
      include: [{ email: { email: OWNER_EMAIL } }],
    });
  });
});

describe("the reconciler's token", () => {
  it("holds groups-write on the installation's account, and nothing else", async () => {
    const plan = await accountPlan();
    const request = admissionTokenRequest(plan, "perm-1", Date.parse("2026-11-03T12:00:00Z"));
    expect(request.policies).toEqual([
      {
        effect: "allow",
        permission_groups: [{ id: "perm-1" }],
        resources: { [`${ACCOUNT_SCOPE}.${plan.accountId}`]: "*" },
      },
    ]);
    expect(request.name).toBe(
      `${plan.platformWorker}-access--${plan.installationId}--20261103T120000Z`,
    );
  });

  it("is made by the installer's login and its value returned, never logged", async () => {
    const asked: [string, string | undefined][] = [];
    const created: TokenRequest[] = [];
    const api: TokenApi = {
      permissionGroup: (name, scope) => {
        asked.push([name, scope]);
        return "perm-1";
      },
      create: (request) => {
        created.push(request);
        return { id: "tok-1", value: "synthetic-canary-access-token" };
      },
      list: (): ApiToken[] => [],
      get: () => undefined,
      remove: () => "absent",
    };
    const plan = await accountPlan();
    const token = makeAdmissionToken(api, plan, Date.parse("2026-11-03T12:00:00Z"));
    expect(asked).toEqual([[ACCESS_GROUPS_WRITE_GROUP, ACCOUNT_SCOPE]]);
    expect(token).toMatchObject({ id: "tok-1", value: "synthetic-canary-access-token" });
    expect(JSON.stringify(created)).not.toContain("synthetic-canary-access-token");
  });
});

describe("the application's check with the member group", () => {
  const app = (include: unknown[]) => ({
    id: "app-1",
    name: "omnigent",
    domain: HOST,
    type: "self_hosted",
    aud: "a".repeat(64),
    same_site_cookie_attribute: "lax",
    options_preflight_bypass: false,
    policies: [{ name: "Allow team members", decision: "allow", include }],
  });

  it("accepts exactly the recorded group, and refuses another group", async () => {
    const pin = await ownerPin();
    const withGroup = app([{ group: { id: "group-1" } }]);
    const check = { ...(await pinCheck(withGroup, HOST, pin)), memberGroupId: "group-1" };
    expect(ownerOnlyProblems(withGroup, check)).toEqual([]);
    expect(memberPolicy("group-1")).toEqual({
      name: "Allow team members",
      decision: "allow",
      include: [{ group: { id: "group-1" } }],
    });
    const other = app([{ group: { id: "group-2" } }]);
    expect(ownerOnlyProblems(other, { ...check }).map((p) => p.aspect)).toContain("rules");
    // Without a recorded group, a group is refused as before.
    const before = await pinCheck(withGroup, HOST, pin);
    expect(ownerOnlyProblems(withGroup, before).map((p) => p.aspect)).toContain("rules");
  });
});

describe("enabling team admission", () => {
  it("is supported at this pin; any other admission is refused before touching anything", async () => {
    // cfo/teams 922b69c62 carries WP8.11's fork part; a pin without it is refused through the
    // update's ports (update.test.ts, `supported: false`) with this refusal.
    expect(TEAM_ADMISSION_SUPPORTED).toBe(true);
    expect(teamAdmissionRefusal()).toMatch(/WP8\.11's fork part/);
    await expect(
      updateCommand("/nonexistent/state.json", {
        root: "/nonexistent",
        verify: true,
        teamAdmission: "everyone",
      }),
    ).rejects.toThrow(/owner or members/);
  });

  it("names the settings WP8.11 deploys, with no secret among them", async () => {
    const plan = await accountPlan();
    const vars = teamAdmissionVars(plan, "group-1");
    expect(vars.web).toEqual({ TEAM_ADMISSION: "members" });
    expect(vars.platform).toMatchObject({
      CFO_IDENTITY_ENVELOPE: "on",
      CFO_ACCESS_GROUP_ID: "group-1",
    });
    // The identity mode is a secret the move changes on its own (bind, then required).
    expect(Object.keys(vars.platform)).not.toContain("SERVER_ENV_OMNIGENT_EXTERNAL_IDENTITY_MODE");
    expect(Object.keys(vars.platform)).not.toContain("CFO_ACCESS_GROUP_TOKEN");
    // The reconciler checks the team's current owners, not the planned owner's pin.
    expect(Object.keys(vars.platform)).not.toContain("OWNER_EMAIL_HASH");
  });
});
