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
  statePathFor,
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
      [{ ...good, stateVersion: 2 }, /unknown version/],
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
