import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BootstrapState } from "../machine.ts";
import {
  fileStateStore,
  installationsDir,
  locksDir,
  parseState,
  resourceLockPaths,
  stagingStateProblem,
  statePathFor,
  stateVersionFor,
  writeAtomic,
} from "../state.ts";
import { accountPlan, INSTALLATION, stagingPlan } from "./fixtures.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-bootstrap-state-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function fullState(): Promise<BootstrapState> {
  return {
    stateVersion: 1,
    installation: await stagingPlan(),
    journal: {
      platformDeployStartedAt: "2026-10-22T12:00:00.000Z",
      platformDeployedAt: "2026-10-22T12:01:00.000Z",
      access: {
        teamDomain: "team.cloudflareaccess.com",
        aud: "a".repeat(64),
        checkedAt: "2026-10-22T12:01:01.000Z",
      },
      webDeployStartedAt: "2026-10-22T12:01:02.000Z",
      webDeployedAt: "2026-10-22T12:01:30.000Z",
      accepted: {
        at: "2026-10-22T12:06:00.000Z",
        status: {
          protocolVersion: 1,
          installationId: INSTALLATION,
          initialized: true,
          checkedAt: "2026-10-22T12:05:30.000Z",
        },
        versionId: "v1",
      },
      releaseStartedAt: "2026-10-22T12:06:01.000Z",
      releasedAt: "2026-10-22T12:06:05.000Z",
      verifiedAt: "2026-10-22T12:12:00.000Z",
    },
  };
}

describe("the state file", () => {
  it("round-trips the plan and the journal, mode 0600 in a 0700 directory", async () => {
    const path = join(dir, "installations", "cfo-stg-wp24-platform.json");
    const store = fileStateStore(path);
    const state = await fullState();
    store.save(state);
    expect(store.load()).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const account = { stateVersion: 1 as const, installation: await accountPlan(), journal: {} };
    store.save(account);
    expect(store.load()).toEqual(account);
    // The artifact bucket, with its own endpoint (G2-DUR-001).
    const artifacts = {
      url: "s3://cfo-canary-artifacts/x",
      endpoint: "https://other.example.test",
    };
    const withEndpoint = { ...account, installation: { ...account.installation, artifacts } };
    store.save(withEndpoint);
    expect(store.load()).toEqual(withEndpoint);
  });

  it("writes atomically: no temporary file is left", () => {
    const path = join(dir, "x.json");
    writeAtomic(path, "one");
    writeAtomic(path, "two");
    expect(readFileSync(path, "utf8")).toBe("two");
    expect(readFileSync(path, "utf8")).not.toContain("tmp");
  });

  it("names a broken field and never echoes the file", async () => {
    const good = JSON.parse(JSON.stringify(await fullState()));
    const cases: [unknown, RegExp][] = [
      ["not json {", /not JSON/],
      [[], /top level is not an object/],
      [{ ...good, stateVersion: 5 }, /unknown version/],
      [{ ...good, stateVersion: "1" }, /unknown version/],
      // D33: version 2 records the bucket tag, and only version 2 does.
      [{ ...good, stateVersion: 2 }, /version 2 plan records no bucket tag/],
      [
        { ...good, installation: { ...good.installation, bucketTag: "01hs3f9q" } },
        /has a bucket tag, which only version 2 records/,
      ],
      [
        { ...good, stateVersion: 2, installation: { ...good.installation, bucketTag: 7 } },
        /installation.bucketTag is not text/,
      ],
      [
        { ...good, stateVersion: 2, installation: { ...good.installation, bucketTag: "zzzzzzzz" } },
        /plan is not usable: the bucket tag is not the first 8 digits of the installation ID/,
      ],
      [
        { ...good, installation: { ...good.installation, hostname: 7 } },
        /installation.hostname is not text/,
      ],
      [
        { ...good, installation: { ...good.installation, ownerUsername: "root" } },
        /plan is not usable/,
      ],
      [
        { ...good, installation: { ...good.installation, target: { kind: "cloud" } } },
        /neither an account nor staging/,
      ],
      [
        {
          ...good,
          installation: {
            ...good.installation,
            target: { ...good.installation.target, days: "1" },
          },
        },
        /days is not a number/,
      ],
      [
        {
          ...good,
          installation: { ...good.installation, replica: { url: "s3://b/p", endpoint: 1 } },
        },
        /endpoint is not text/,
      ],
      [
        { ...good, installation: { ...good.installation, artifacts: "s3://b" } },
        /installation.artifacts is not an object/,
      ],
      [
        { ...good, installation: { ...good.installation, artifacts: { endpoint: "https://x" } } },
        /installation.artifacts.url is not text/,
      ],
      [
        {
          ...good,
          installation: { ...good.installation, artifacts: { url: "s3://b", endpoint: 1 } },
        },
        /artifacts endpoint is not text/,
      ],
      [
        { ...good, journal: { ...good.journal, releasedAt: "yesterday" } },
        /journal.releasedAt is not a time/,
      ],
      [{ ...good, journal: { ...good.journal, access: "x" } }, /journal.access is not an object/],
      [
        {
          ...good,
          journal: { ...good.journal, accepted: { ...good.journal.accepted, status: {} } },
        },
        /accepted status is malformed/,
      ],
      [
        {
          ...good,
          journal: { ...good.journal, accepted: { ...good.journal.accepted, versionId: 3 } },
        },
        /accepted version is not text/,
      ],
    ];
    for (const [value, message] of cases) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      expect(() => parseState(text)).toThrow(message);
      try {
        parseState(text);
      } catch (error) {
        expect((error as Error).message).not.toContain("example.test");
      }
    }
    expect(parseState(JSON.stringify({ ...good, journal: undefined })).journal).toEqual({});
  });

  it("says to plan first when there is no state file", () => {
    expect(() => fileStateStore(join(dir, "none.json")).load()).toThrow(/run plan first/);
  });

  it("locks by account and Worker, wherever the state file is (review r1, F1)", async () => {
    const plan = await accountPlan();
    expect(resourceLockPaths(plan, "/l")).toEqual([
      `/l/${plan.accountId}.cloudflare-omnigent-web.lock`,
      `/l/${plan.accountId}.cloudflare-omnigent.lock`,
    ]);
    expect(locksDir({ XDG_CONFIG_HOME: "/cfg", CFO_INSTALL_DIR: "/elsewhere" })).toBe(
      "/cfg/cloudflare-omnigent/bootstrap-locks",
    );
    expect(locksDir({})).toMatch(/\.config\/cloudflare-omnigent\/bootstrap-locks$/);
  });

  it("round-trips the watermark and the released version", async () => {
    const state = await fullState();
    const path = join(dir, "w.json");
    const withMore = {
      ...state,
      journal: {
        ...state.journal,
        newestStatus: {
          loggedAt: 5,
          versionId: "v1",
          reason: "durable",
          status: state.journal.accepted?.status,
        },
        releasedVersionId: "v2",
      },
    } as BootstrapState;
    fileStateStore(path).save(withMore);
    expect(fileStateStore(path).load()).toEqual(withMore);
    const good = JSON.parse(JSON.stringify(withMore));
    for (const [journal, message] of [
      [
        { ...good.journal, newestStatus: { ...good.journal.newestStatus, loggedAt: "5" } },
        /newest status is malformed/,
      ],
      [
        { ...good.journal, newestStatus: { ...good.journal.newestStatus, reason: 3 } },
        /newest status reason is not text/,
      ],
      [{ ...good.journal, releasedVersionId: 2 }, /released version is not text/],
    ] as const) {
      expect(() => parseState(JSON.stringify({ ...good, journal }))).toThrow(message);
    }
  });

  it("round-trips whose password was uploaded and the code deployed (WP3.34, Codex r1-1)", async () => {
    const state = await fullState();
    const path = join(dir, "code.json");
    const withCode = {
      ...state,
      journal: {
        ...state.journal,
        ownerPassword: "page",
        platformCode: "a".repeat(40),
        webCode: "b".repeat(40),
        updatedAt: "2026-10-29T12:00:00.000Z",
      },
    } as BootstrapState;
    fileStateStore(path).save(withCode);
    // Version 3: a journal with these fields (stateVersionFor, Codex r2-1).
    expect(fileStateStore(path).load()).toEqual({ ...withCode, stateVersion: 3 });
    const good = JSON.parse(JSON.stringify(withCode));
    for (const [journal, message] of [
      [{ ...good.journal, ownerPassword: "owner" }, /neither page nor installer/],
      [{ ...good.journal, platformCode: "main" }, /journal.platformCode is not a commit ID/],
      [{ ...good.journal, webCode: 40 }, /journal.webCode is not a commit ID/],
      [{ ...good.journal, updatedAt: "yesterday" }, /journal.updatedAt is not a time/],
    ] as const) {
      expect(() => parseState(JSON.stringify({ ...good, journal }))).toThrow(message);
    }
  });

  it("writes a journal with WP3.34's fields as version 3, which earlier bootstraps refuse (Codex r2-1)", async () => {
    // A bootstrap from before WP3.34 accepts versions 1 and 2 only ("unknown version"
    // otherwise), so it can never read such a journal and save it without these fields.
    const state = await fullState();
    for (const plan of [state.installation, { ...state.installation, bucketTag: "01hs3f9q" }]) {
      const path = join(dir, `v3-${plan.bucketTag ?? "untagged"}.json`);
      const store = fileStateStore(path);
      store.save({ ...state, installation: plan, journal: { ...state.journal } });
      expect(JSON.parse(readFileSync(path, "utf8")).stateVersion).toBe(plan.bucketTag ? 2 : 1);
      const recorded = { ...state.journal, platformCode: "a".repeat(40) };
      store.save({ ...state, installation: plan, journal: recorded });
      expect(JSON.parse(readFileSync(path, "utf8")).stateVersion).toBe(3);
      expect(store.load()).toMatchObject({ stateVersion: 3, journal: recorded });
    }
    for (const key of ["ownerPassword", "webCode", "updatedAt"]) {
      const value =
        key === "ownerPassword"
          ? "page"
          : key === "webCode"
            ? "b".repeat(40)
            : "2026-10-29T12:00:00.000Z";
      expect(stateVersionFor({}, { [key]: value })).toBe(3);
    }
    expect(stateVersionFor({}, { ownerPasswordGivenAt: "2026-10-29T12:00:00.000Z" })).toBe(1);
  });

  it("round-trips the R2 token's record, which holds no value (WP3.25)", async () => {
    const state = await fullState();
    const path = join(dir, "t.json");
    for (const r2Token of [
      { name: "cfo-stg-wp24-platform-r2--x", createStartedAt: "2026-10-28T12:00:00.000Z" },
      {
        name: "cfo-stg-wp24-platform-r2--x",
        id: "cfocanary-token-id",
        createdAt: "2026-10-28T12:00:01.000Z",
        expiresOn: "2026-10-30T12:00:00Z",
      },
    ]) {
      const withToken = {
        ...state,
        journal: {
          ...state.journal,
          r2Token,
          r2TokensToDelete: [
            { name: "a" },
            { name: "b", id: "i", expiresOn: "2026-10-30T12:00:00Z" },
          ],
        },
      };
      fileStateStore(path).save(withToken);
      expect(fileStateStore(path).load()).toEqual(withToken);
    }
    const good = JSON.parse(JSON.stringify({ ...state, journal: { r2Token: { name: "n" } } }));
    for (const [r2Token, message] of [
      ["n", /journal.r2Token is not an object/],
      [{}, /journal.r2Token.name is not text/],
      [{ name: "n", id: 7 }, /journal.r2Token.id is not text/],
      [{ name: "n", createdAt: "yesterday" }, /journal.r2Token.createdAt is not a time/],
      [{ name: "n", expiresOn: 1 }, /journal.r2Token.expiresOn is not a time/],
      [{ name: "n", createStartedAt: "soon" }, /journal.r2Token.createStartedAt is not a time/],
    ] as const) {
      expect(() => parseState(JSON.stringify({ ...good, journal: { r2Token } }))).toThrow(message);
    }
    for (const [r2TokensToDelete, message] of [
      [{}, /journal.r2TokensToDelete is not a list/],
      [["x"], /journal.r2TokensToDelete entry is not an object/],
      [[{}], /journal.r2TokensToDelete.name is not text/],
      [[{ name: "a", id: 1 }], /journal.r2TokensToDelete.id is not text/],
      [[{ name: "a", expiresOn: "later" }], /journal.r2TokensToDelete.expiresOn is not a time/],
    ] as const) {
      expect(() => parseState(JSON.stringify({ ...good, journal: { r2TokensToDelete } }))).toThrow(
        message,
      );
    }
  });

  it("round-trips the Access application's record and the login method's (WP3.31)", async () => {
    const state = await fullState();
    const path = join(dir, "a.json");
    for (const [accessApp, accessLoginMethod] of [
      [
        { name: "cloudflare-omnigent-web--0a1b2c3d", createStartedAt: "2026-10-29T12:00:00.000Z" },
        { createStartedAt: "2026-10-29T11:59:59.000Z" },
      ],
      [
        {
          name: "cloudflare-omnigent-web--0a1b2c3d",
          id: "app-1",
          createdAt: "2026-10-29T12:00:01.000Z",
        },
        { id: "idp-1", createdAt: "2026-10-29T12:00:00.000Z" },
      ],
    ] as const) {
      const withAccess = { ...state, journal: { ...state.journal, accessApp, accessLoginMethod } };
      fileStateStore(path).save(withAccess);
      expect(fileStateStore(path).load()).toEqual(withAccess);
    }
    const good = JSON.parse(JSON.stringify(state));
    for (const [journal, message] of [
      [{ accessApp: "x" }, /journal.accessApp is not an object/],
      [{ accessApp: {} }, /journal.accessApp.name is not text/],
      [{ accessApp: { name: "n", id: 1 } }, /journal.accessApp.id is not text/],
      [
        { accessApp: { name: "n", createdAt: "soon" } },
        /journal.accessApp.createdAt is not a time/,
      ],
      [{ accessLoginMethod: [] }, /journal.accessLoginMethod is not an object/],
      [{ accessLoginMethod: { id: 2 } }, /journal.accessLoginMethod.id is not text/],
      [
        { accessLoginMethod: { createStartedAt: "x" } },
        /journal.accessLoginMethod.createStartedAt is not a time/,
      ],
    ] as const) {
      expect(() => parseState(JSON.stringify({ ...good, journal }))).toThrow(message);
    }
  });

  it("round-trips the update's record, which holds no secret; a file without one reads too (WP3.35)", async () => {
    const state = await fullState();
    const path = join(dir, "u.json");
    // A state file from before WP3.35 has none of these fields: it reads as it was.
    fileStateStore(path).save(state);
    expect(fileStateStore(path).load()).toEqual(state);
    for (const update of [
      { code: "a".repeat(40), startedAt: "2026-10-30T09:00:00.000Z" },
      {
        code: "b".repeat(40),
        startedAt: "2026-10-30T09:00:00.000Z",
        deployId: "0102030405060708",
        platformDeployStartedAt: "2026-10-30T09:00:01.000Z",
        platformDeployedAt: "2026-10-30T09:08:00.000Z",
        platformVersionId: "v9",
        addedSecrets: ["SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET"],
        webDeployStartedAt: "2026-10-30T09:08:01.000Z",
        webDeployedAt: "2026-10-30T09:09:00.000Z",
        webVersionId: "w3",
        verifiedAt: "2026-10-30T09:16:00.000Z",
      },
    ]) {
      const withUpdate = {
        ...state,
        journal: {
          ...state.journal,
          update,
          platformCode: update.code,
          webCode: update.code,
          updatedAt: "2026-10-30T09:09:00.000Z",
        },
      };
      fileStateStore(path).save(withUpdate);
      // Version 4: a bootstrap from before WP3.35 refuses it rather than drop the update's record.
      expect(fileStateStore(path).load()).toEqual({ ...withUpdate, stateVersion: 4 });
      expect(JSON.parse(readFileSync(path, "utf8")).stateVersion).toBe(4);
    }
    const good = JSON.parse(JSON.stringify(state));
    const start = { code: "c".repeat(40), startedAt: "2026-10-30T09:00:00.000Z" };
    for (const [journal, message] of [
      [{ update: "x" }, /journal.update is not an object/],
      [{ update: { code: "c".repeat(40) } }, /journal.update.startedAt is missing/],
      [{ update: { ...start, code: 1 } }, /journal.update.code is not text/],
      [{ update: { ...start, code: "main" } }, /journal.update.code is not a commit ID/],
      [{ update: { ...start, startedAt: "soon" } }, /journal.update.startedAt is not a time/],
      [{ update: { ...start, verifiedAt: 3 } }, /journal.update.verifiedAt is not a time/],
      [{ update: { ...start, deployId: 3 } }, /journal.update.deployId is not text/],
      [{ update: { ...start, addedSecrets: "x" } }, /addedSecrets is not a list of names/],
      [{ update: { ...start, addedSecrets: [1] } }, /addedSecrets is not a list of names/],
      [{ platformCode: 1 }, /journal.platformCode is not a commit ID/],
      [{ updatedAt: "later" }, /journal.updatedAt is not a time/],
    ] as const) {
      expect(() => parseState(JSON.stringify({ ...good, journal }))).toThrow(message);
    }
  });

  it("keeps a staging installation's state where the staging tool finds it (Codex WP3.25 r3-5)", async () => {
    const staging = await stagingPlan();
    const home = join(dir, "installations");
    expect(stagingStateProblem(staging, join(home, "cfo-stg-wp24-platform.json"), home)).toBe(
      undefined,
    );
    expect(stagingStateProblem(staging, join(home, ".", "cfo-stg-wp24-platform.json"), home)).toBe(
      undefined,
    );
    expect(stagingStateProblem(staging, join(dir, "elsewhere.json"), home)).toBe(
      `a staging installation's state file lives at ${join(home, "cfo-stg-wp24-platform.json")}, where the staging tool finds its R2 tokens; leave out --state`,
    );
    // An installation in the installer's own account may keep it anywhere.
    expect(stagingStateProblem(await accountPlan(), join(dir, "elsewhere.json"), home)).toBe(
      undefined,
    );
  });

  it("lives outside the repository, by platform Worker", () => {
    expect(installationsDir({ CFO_INSTALL_DIR: "/x" })).toBe("/x");
    expect(installationsDir({ XDG_CONFIG_HOME: "/cfg" })).toBe(
      "/cfg/cloudflare-omnigent/installations",
    );
    expect(installationsDir({})).toMatch(/\.config\/cloudflare-omnigent\/installations$/);
    expect(statePathFor("cloudflare-omnigent", "/d")).toBe("/d/cloudflare-omnigent.json");
    writeFileSync(join(dir, "probe"), "");
  });
});
