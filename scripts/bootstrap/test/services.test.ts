// The installer's MCP services step (WP5.10, services.ts), on the bootstrap's simulated
// Cloudflare: the shipped manifests, the destination rules (the image's own vectors), the one
// secrets change, the wait for a server started with it, refusals, crashes and the listing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpRevisionOf } from "../../../worker/src/server/mcp-services.ts";
import { type BootstrapState, runBootstrap } from "../machine.ts";
import {
  askedSecrets,
  changeServices,
  destinationProblem,
  envKey,
  MCP_REVISION_SECRET,
  MCP_SERVICES_SECRET,
  originProblem,
  readManifest,
  type ServiceManifest,
  type ServicesChange,
  type ServicesOptions,
  ServicesRefusal,
  servicesListing,
  servicesMessage,
} from "../services.ts";
import { shippedManifests } from "../services-command.ts";
import {
  CREDENTIAL_STORE_SECRETS,
  KEY_SERVICE_KEY_SECRET,
  PLATFORM_FEATURES_VAR,
} from "../settings.ts";
import { parseState } from "../state.ts";
import {
  Crash,
  FakeWorld,
  fakeMcpRevision,
  MemoryStore,
  REPLACE_MS,
  SWITCH_MS,
} from "./fake-cloud.ts";
import { accountPlan, baseConfigs, freshState, OWNER_PASSWORD, ROOT } from "./fixtures.ts";

const VECTORS = JSON.parse(
  readFileSync(join(ROOT, "images", "server", "tests", "destination_vectors.json"), "utf8"),
) as { allowed: string[]; refused: string[] };
const SHIPPED = shippedManifests(ROOT);
const ORIGIN = "https://mcp-demo.example.test";
const CLIENT_ID = "cfo-canary-mcp-client-id-0001";
const CLIENT_SECRET = "cfo-canary-mcp-client-secret-0001";
/** A shipped set with a service that asks for an OAuth client too (as a real one will). */
const WITH_MAIL = new Map<string, ServiceManifest>([
  ...SHIPPED,
  ["mail", { id: "mail", title: "Mail", auth: "oauth", asks: ["client_id", "client_secret"] }],
]);

/** A finished installation on the simulated Cloudflare, a day after its release. */
async function installed(): Promise<{ world: FakeWorld; store: MemoryStore }> {
  const plan = await accountPlan();
  const world = new FakeWorld(plan);
  const store = new MemoryStore(freshState(plan));
  const outcome = await runBootstrap(
    {
      cloud: world.cloud(),
      store,
      baseConfigs: baseConfigs(),
      secrets: () => ({
        ownerPassword: OWNER_PASSWORD,
        replicaAccessKeyId: "cfo-canary-replica-key-id",
        replicaSecretAccessKey: "cfo-canary-replica-secret-key",
      }),
      random: (n) => new Uint8Array(n).fill(0xab),
      now: () => world.now,
      sleep: async (ms) => {
        world.now += Math.max(0, ms);
      },
      log: () => undefined,
    },
    { waitMs: 30 * 60_000, pollMs: 30_000, verify: true, switchMs: 330_000, verifyWaitMs: 600_000 },
  );
  expect(outcome).toEqual({ kind: "done" });
  world.calls.length = 0;
  world.counts.clear();
  world.now += 24 * 3600_000;
  return { world, store };
}

/** Different bytes on every call, across steps: each change's revision is its own. */
let next = 1;
function random(n: number): Uint8Array {
  next = (next % 255) + 1;
  return new Uint8Array(n).fill(next);
}

async function step(
  h: { world: FakeWorld; store: MemoryStore },
  change: ServicesChange,
  options: ServicesOptions & {
    answers?: string[];
    manifests?: ReadonlyMap<string, ServiceManifest>;
  } = {},
) {
  const logs: string[] = [];
  const asked: { question: string; secret: boolean }[] = [];
  const answers = [...(options.answers ?? [])];
  const outcome = await changeServices(
    h.world.plan,
    {
      cloud: h.world.cloud(),
      store: h.store,
      manifests: options.manifests ?? SHIPPED,
      ask: async (question, { secret }) => {
        asked.push({ question, secret });
        const answer = answers.shift();
        if (answer === undefined) throw new Error("no answer");
        return answer;
      },
      random,
      now: () => h.world.now,
      sleep: async (ms) => {
        h.world.now += Math.max(0, ms);
      },
      log: (message) => logs.push(message),
    },
    change,
    options,
  );
  return { outcome, logs, asked };
}

const secrets = (world: FakeWorld) => world.secretsOf(world.plan.platformWorker) ?? new Map();

describe("the manifests and the destination rules", () => {
  it("reads the shipped manifests: the test service asks for its origin, GitHub for nothing", () => {
    expect([...SHIPPED.keys()].sort()).toEqual(["github", "tracker"]);
    expect(SHIPPED.get("tracker")).toMatchObject({ auth: "oauth", asks: ["origin"] });
    expect(SHIPPED.get("github")).toMatchObject({ auth: "github", asks: [] });
    expect(() => readManifest("other", { manifest: 1, asks: [], service: { id: "x" } })).toThrow(
      /does not name its service/,
    );
    expect(() => readManifest("x", { manifest: 2 })).toThrow(/not a version 1 manifest/);
    expect(() =>
      readManifest("x", {
        manifest: 1,
        asks: ["password"],
        service: { id: "x", title: "X", auth: "none" },
      }),
    ).toThrow(/asks/);
  });

  it("names a service's settings as the image reads them", () => {
    expect(envKey("google-drive")).toBe("GOOGLE_DRIVE");
    expect(askedSecrets({ id: "my-svc", title: "", auth: "oauth", asks: [] })).toEqual({
      origin: "SERVER_ENV_CFO_MCP_ORIGIN_MY_SVC",
      client_id: "SERVER_ENV_CFO_MCP_CLIENT_ID_MY_SVC",
      client_secret: "SERVER_ENV_CFO_MCP_CLIENT_SECRET_MY_SVC",
    });
  });

  it.each(VECTORS.allowed)("allows %s, as the image does", (url) => {
    expect(destinationProblem(url)).toBeUndefined();
  });

  it.each(VECTORS.refused)("refuses %j, as the image does, without repeating it", (url) => {
    const problem = destinationProblem(url);
    expect(problem).toBeDefined();
    if (url !== "") expect(problem).not.toContain(url);
  });

  it("takes an origin only, with nothing after it", () => {
    expect(originProblem(ORIGIN)).toBeUndefined();
    expect(originProblem(`${ORIGIN}/`)).toBeUndefined();
    expect(originProblem(`${ORIGIN}:8443`)).toBeUndefined();
    expect(originProblem(`${ORIGIN}/mcp`)).toBe("it must be an origin, with no path");
    expect(originProblem("http://mcp-demo.example.test")).toBe("it must be https");
  });
});

describe("turning a service on and off, on a simulated Cloudflare", () => {
  it("adds the test service in one change and waits for a server started with it", async () => {
    const h = await installed();
    const changes = h.world.secretChanges.length;
    const { outcome, logs, asked } = await step(h, { kind: "add", id: "tracker", origin: ORIGIN });
    expect(outcome).toEqual({ kind: "ready", on: ["tracker"] });
    expect(asked).toEqual([]); // --origin gave it
    expect(h.world.secretChanges).toHaveLength(changes + 1);
    const change = h.world.secretChanges.at(-1)?.changes ?? {};
    expect(Object.keys(change).sort()).toEqual(
      [MCP_REVISION_SECRET, MCP_SERVICES_SECRET, "SERVER_ENV_CFO_MCP_ORIGIN_TRACKER"].sort(),
    );
    expect(change[MCP_SERVICES_SECRET]).toBe("tracker");
    expect(change.SERVER_ENV_CFO_MCP_ORIGIN_TRACKER).toBe(ORIGIN);
    const revision = change[MCP_REVISION_SECRET] ?? "";
    expect(revision).toMatch(/^[0-9a-f]{32}$/);
    // The platform reads the same revision the step wrote, and the fake logs it as the real one.
    expect(mcpRevisionOf(Object.fromEntries(secrets(h.world)))).toBe(revision);
    expect(fakeMcpRevision(secrets(h.world))).toBe(revision);
    // It waited out the object's switch and the server's restart.
    const at = h.world.secretChanges.at(-1)?.at ?? Number.NaN;
    expect(h.world.now - at).toBeGreaterThanOrEqual(SWITCH_MS + REPLACE_MS);
    expect(logs.join("\n")).toContain(
      "waiting: the server is restarting with the new MCP settings",
    );
    const record = h.store.load().journal.mcpServices;
    expect(record).toMatchObject({ on: ["tracker"], revision, registry: true });
    expect(record?.confirmedAt).toBeDefined();
    expect(record?.pending).toBeUndefined();
    expect(servicesMessage(h.world.plan, { kind: "add", id: "tracker" }, SHIPPED, outcome)).toEqual(
      {
        exitCode: 0,
        lines: [
          "Ready. Demo work tracker (test service) (tracker) is on.",
          "Connect it in Omnigent: Settings → MCP, https://omnigent.example.test/settings/mcp; then turn it on in a new conversation's MCPs picker.",
          "MCP services on: tracker.",
        ],
      },
    );
    // The state file records it as version 5, which an older bootstrap refuses.
    const saved = JSON.parse(JSON.stringify({ ...h.store.load(), stateVersion: 5 }));
    expect(parseState(JSON.stringify(saved)).journal.mcpServices).toEqual(record);
  });

  it("asks for the origin when it is not given, shown as typed, and refuses a bad one before any change", async () => {
    const h = await installed();
    const changes = h.world.secretChanges.length;
    await expect(
      step(h, { kind: "add", id: "tracker" }, { answers: ["http://10.0.0.1"] }),
    ).rejects.toThrow(/breaks a rule: it must be https; nothing was changed/);
    expect(h.world.secretChanges).toHaveLength(changes);
    const { outcome, asked } = await step(
      h,
      { kind: "add", id: "tracker" },
      { answers: [` ${ORIGIN.toUpperCase().replace("HTTPS", "https")}/ `] },
    );
    expect(outcome.kind).toBe("ready");
    expect(asked).toEqual([{ question: expect.stringContaining("address"), secret: false }]);
    expect(secrets(h.world).get("SERVER_ENV_CFO_MCP_ORIGIN_TRACKER")).toBe(ORIGIN);
  });

  it("asks for an OAuth client's ID and secret, never shown, and never keeps or logs them", async () => {
    const h = await installed();
    const { outcome, logs, asked } = await step(
      h,
      { kind: "add", id: "mail" },
      { manifests: WITH_MAIL, answers: [CLIENT_ID, CLIENT_SECRET] },
    );
    expect(outcome).toEqual({ kind: "ready", on: ["mail"] });
    expect(asked.map((a) => a.secret)).toEqual([true, true]);
    expect(secrets(h.world).get("SERVER_ENV_CFO_MCP_CLIENT_ID_MAIL")).toBe(CLIENT_ID);
    expect(secrets(h.world).get("SERVER_ENV_CFO_MCP_CLIENT_SECRET_MAIL")).toBe(CLIENT_SECRET);
    const kept = JSON.stringify(h.store.load()) + logs.join("\n");
    expect(kept).not.toContain(CLIENT_SECRET);
    expect(kept).not.toContain(CLIENT_ID);
    // A value with a space or nothing at all is refused, before any change.
    const changes = h.world.secretChanges.length;
    await expect(
      step(h, { kind: "add", id: "mail" }, { manifests: WITH_MAIL, answers: ["has space", "x"] }),
    ).rejects.toThrow(/the OAuth client ID is not usable: it must be printable characters/);
    await expect(
      step(h, { kind: "add", id: "mail" }, { manifests: WITH_MAIL, answers: [CLIENT_ID, ""] }),
    ).rejects.toThrow(/the OAuth client secret is not usable: it is empty/);
    expect(h.world.secretChanges).toHaveLength(changes);
  });

  it("removes a service, and the values it was given, in one change", async () => {
    const h = await installed();
    await step(h, { kind: "add", id: "tracker", origin: ORIGIN });
    await step(
      h,
      { kind: "add", id: "mail" },
      { manifests: WITH_MAIL, answers: [CLIENT_ID, CLIENT_SECRET] },
    );
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("mail,tracker");
    const { outcome } = await step(h, { kind: "remove", id: "mail" }, { manifests: WITH_MAIL });
    expect(outcome).toEqual({ kind: "ready", on: ["tracker"] });
    const change = h.world.secretChanges.at(-1)?.changes ?? {};
    expect(change).toMatchObject({
      [MCP_SERVICES_SECRET]: "tracker",
      SERVER_ENV_CFO_MCP_CLIENT_ID_MAIL: null,
      SERVER_ENV_CFO_MCP_CLIENT_SECRET_MAIL: null,
    });
    expect(secrets(h.world).has("SERVER_ENV_CFO_MCP_CLIENT_SECRET_MAIL")).toBe(false);
    // The last one: the list goes, and Omnigent lists no MCP, which is what "ready" means then.
    const last = await step(h, { kind: "remove", id: "tracker" });
    expect(last.outcome).toEqual({ kind: "ready", on: [] });
    expect(secrets(h.world).has(MCP_SERVICES_SECRET)).toBe(false);
    expect(secrets(h.world).has("SERVER_ENV_CFO_MCP_ORIGIN_TRACKER")).toBe(false);
    expect(h.store.load().journal.mcpServices).toMatchObject({ on: [], registry: false });
    expect(
      servicesMessage(h.world.plan, { kind: "remove", id: "tracker" }, SHIPPED, last.outcome)
        .lines[0],
    ).toBe("Demo work tracker (test service) (tracker) is off.");
  });

  it("changes nothing for a service already on that asks for nothing, or one that is not on", async () => {
    const h = await installed();
    await h.world.cloud().updateSecrets(h.world.plan.platformWorker, {
      SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_ID: "Iv23liCanaryClient00",
    });
    expect((await step(h, { kind: "add", id: "github" })).outcome.kind).toBe("ready");
    const changes = h.world.secretChanges.length;
    expect((await step(h, { kind: "add", id: "github" })).outcome).toEqual({
      kind: "unchanged",
      on: ["github"],
    });
    expect((await step(h, { kind: "remove", id: "tracker" })).outcome.kind).toBe("unchanged");
    expect(h.world.secretChanges).toHaveLength(changes);
  });

  it("says GitHub's MCP server needs GitHub linking first", async () => {
    const h = await installed();
    await expect(step(h, { kind: "add", id: "github" })).rejects.toThrow(
      /uses Omnigent's GitHub linking.*run bootstrap.ts github-app first/,
    );
    const ready = await step(h, { kind: "add", id: "tracker", origin: ORIGIN });
    expect(
      servicesMessage(h.world.plan, { kind: "add", id: "github" }, SHIPPED, {
        kind: "ready",
        on: ["github", "tracker"],
      }).lines[1],
    ).toContain("uses your GitHub link");
    expect(ready.outcome.kind).toBe("ready");
  });
});

describe("refusals, before anything is asked or changed", () => {
  it("a service this release does not ship", async () => {
    const h = await installed();
    await expect(step(h, { kind: "add", id: "nonesuch" })).rejects.toThrow(
      /no MCP service "nonesuch" ships with this release \(it has: github, tracker\)/,
    );
  });

  it("a release from before MCP services, or without the credential store's keys", async () => {
    const h = await installed();
    const versions = h.world.configs.get(h.world.plan.platformWorker) ?? [];
    const last = versions.at(-1) as Record<string, unknown>;
    versions.push({
      ...last,
      vars: { ...(last.vars as object), [PLATFORM_FEATURES_VAR]: "key-service github-setup" },
    });
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(
      /runs a release from before MCP services: update the installation first/,
    );
    versions.pop();
    await h.world
      .cloud()
      .updateSecrets(h.world.plan.platformWorker, { [KEY_SERVICE_KEY_SECRET]: null });
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(
      new RegExp(`lacks ${KEY_SERVICE_KEY_SECRET}, which logins need: run bootstrap.ts update`),
    );
    expect(CREDENTIAL_STORE_SECRETS).toContain(KEY_SERVICE_KEY_SECRET);
  });

  it("a list this state file does not record, unless told to replace it", async () => {
    const h = await installed();
    await h.world
      .cloud()
      .updateSecrets(h.world.plan.platformWorker, { [MCP_SERVICES_SECRET]: "tracker" });
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(
      /holds a list of MCP services this state file does not record/,
    );
    const replaced = await step(
      h,
      { kind: "add", id: "tracker", origin: ORIGIN },
      { replace: true },
    );
    expect(replaced.outcome.kind).toBe("ready");
  });

  it("refuses before anything changes while an earlier version serves than the latest (Codex WP3.41b r1-2)", async () => {
    const h = await installed();
    // As after a rollback whose newer versions Cloudflare kept: the latest is not deployed.
    await h.world.cloud().deleteLatestSecrets(h.world.plan.platformWorker, ["SERVER_ENV_CFO_X"]);
    const before = h.store.load().journal;
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(
      /refuses to change .*'s secrets while its latest version is not the one deployed.*nothing was changed/,
    );
    expect(h.store.load().journal).toEqual(before);
    expect(h.world.calls).not.toContain("updateSecrets");
  });

  it("a platform Worker that is not there, or another installation's", async () => {
    const h = await installed();
    h.world.versions.delete(h.world.plan.platformWorker);
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(
      ServicesRefusal,
    );
  });
});

describe("when the server does not take the change", () => {
  it("held: the server refused a setting (exit 78), and the way back is named", async () => {
    const h = await installed();
    h.world.refusesSettings = (v) => v.secrets.has(MCP_SERVICES_SECRET);
    const { outcome } = await step(h, { kind: "add", id: "tracker", origin: ORIGIN });
    expect(outcome).toEqual({ kind: "held", on: ["tracker"] });
    const words = servicesMessage(h.world.plan, { kind: "add", id: "tracker" }, SHIPPED, outcome);
    expect(words.exitCode).toBe(1);
    expect(words.lines.join(" ")).toContain("exit code 78");
    expect(words.lines.join(" ")).toContain("bootstrap.ts services remove tracker");
    // The journal still says what the Worker holds, so the way back works.
    h.world.refusesSettings = () => false;
    expect((await step(h, { kind: "remove", id: "tracker" })).outcome.kind).toBe("ready");
  });

  it("off: the server restarted, but Omnigent lists no MCP (a prerequisite missing)", async () => {
    const h = await installed();
    h.world.mcpListed = () => false;
    const { outcome } = await step(h, { kind: "add", id: "tracker", origin: ORIGIN });
    expect(outcome.kind).toBe("off");
    const words = servicesMessage(h.world.plan, { kind: "add", id: "tracker" }, SHIPPED, outcome);
    expect(words.exitCode).toBe(1);
    expect(words.lines.join(" ")).toContain("config.warning");
    expect(h.store.load().journal.mcpServices).toMatchObject({ on: ["tracker"], registry: false });
    expect(servicesListing(SHIPPED, h.store.load().journal.mcpServices).at(-1)).toContain(
      "but Omnigent listed no MCP services",
    );
  });

  it("not yet: the wait runs out and says what it saw last", async () => {
    const h = await installed();
    h.world.appliesReleases = false;
    const { outcome } = await step(
      h,
      { kind: "add", id: "tracker", origin: ORIGIN },
      { waitMs: 10 * 60_000 },
    );
    expect(outcome.kind).toBe("waiting");
    const words = servicesMessage(h.world.plan, { kind: "add", id: "tracker" }, SHIPPED, outcome);
    expect(words.exitCode).toBe(3);
    expect(h.store.load().journal.mcpServices?.confirmedAt).toBeUndefined();
    expect(servicesListing(SHIPPED, h.store.load().journal.mcpServices).at(-1)).toContain(
      "not confirmed by the server yet",
    );
  });

  it("a crash before the change is sent leaves the intent, and the next run writes the list whole", async () => {
    const h = await installed();
    h.world.crash = { call: "updateSecrets", nth: 1, when: "before" };
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(Crash);
    const record = h.store.load().journal.mcpServices;
    expect(record).toMatchObject({ on: [], pending: { on: ["tracker"] } });
    expect(servicesListing(SHIPPED, record).at(-1)).toContain("may not have reached");
    const again = await step(h, { kind: "add", id: "tracker", origin: ORIGIN });
    expect(again.outcome.kind).toBe("ready");
    expect(again.logs[0]).toContain("may not have reached the installation");
    expect(h.store.load().journal.mcpServices?.pending).toBeUndefined();
  });
});

describe("after a change whose outcome is unknown (Codex r1-1)", () => {
  const github = async (h: { world: FakeWorld }) =>
    h.world.cloud().updateSecrets(h.world.plan.platformWorker, {
      SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_ID: "Iv23liCanaryClient00",
    });

  it("a lost answer after the change was applied: remove still removes", async () => {
    const h = await installed();
    h.world.crash = { call: "updateSecrets", nth: 1, when: "after" };
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(Crash);
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("tracker");
    expect(h.store.load().journal.mcpServices).toMatchObject({
      on: [],
      pending: { on: ["tracker"] },
    });
    const changes = h.world.secretChanges.length;
    const { outcome } = await step(h, { kind: "remove", id: "tracker" });
    expect(outcome).toEqual({ kind: "ready", on: [] });
    expect(h.world.secretChanges).toHaveLength(changes + 1);
    expect(secrets(h.world).has(MCP_SERVICES_SECRET)).toBe(false);
    expect(secrets(h.world).has("SERVER_ENV_CFO_MCP_ORIGIN_TRACKER")).toBe(false);
  });

  it("adding again after an interrupted removal writes again", async () => {
    const h = await installed();
    await github(h);
    expect((await step(h, { kind: "add", id: "github" })).outcome.kind).toBe("ready");
    // The App's settings were the first change, the add the second: the removal is the third.
    h.world.crash = { call: "updateSecrets", nth: 3, when: "after" };
    await expect(step(h, { kind: "remove", id: "github" })).rejects.toThrow(Crash);
    expect(secrets(h.world).has(MCP_SERVICES_SECRET)).toBe(false);
    const { outcome } = await step(h, { kind: "add", id: "github" });
    expect(outcome).toEqual({ kind: "ready", on: ["github"] });
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("github");
  });

  it("never lists a service whose values an interrupted change left out", async () => {
    const h = await installed();
    await github(h);
    h.world.crash = { call: "updateSecrets", nth: 2, when: "before" };
    await expect(step(h, { kind: "add", id: "tracker", origin: ORIGIN })).rejects.toThrow(Crash);
    // The intent names tracker, but its origin never reached the Worker: the next change leaves
    // it off rather than list it without one (which the server would refuse).
    const { outcome, logs } = await step(h, { kind: "add", id: "github" });
    expect(outcome).toEqual({ kind: "ready", on: ["github"] });
    expect(logs.join("\n")).toContain("tracker is left off");
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("github");
  });

  it("removes from a list set elsewhere with --replace, with the values it held", async () => {
    const h = await installed();
    await h.world.cloud().updateSecrets(h.world.plan.platformWorker, {
      [MCP_SERVICES_SECRET]: "tracker",
      SERVER_ENV_CFO_MCP_ORIGIN_TRACKER: ORIGIN,
    });
    const { outcome } = await step(h, { kind: "remove", id: "tracker" }, { replace: true });
    expect(outcome).toEqual({ kind: "ready", on: [] });
    expect(secrets(h.world).has(MCP_SERVICES_SECRET)).toBe(false);
    expect(secrets(h.world).has("SERVER_ENV_CFO_MCP_ORIGIN_TRACKER")).toBe(false);
  });
});

describe("a settled list with a service that can no longer stay on (Codex r2-1)", () => {
  it("rewrites the list when a service's values are gone, though the change asks nothing new", async () => {
    const h = await installed();
    await h.world.cloud().updateSecrets(h.world.plan.platformWorker, {
      SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_ID: "Iv23liCanaryClient00",
    });
    await step(h, { kind: "add", id: "github" });
    await step(h, { kind: "add", id: "tracker", origin: ORIGIN });
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("github,tracker");
    await h.world
      .cloud()
      .updateSecrets(h.world.plan.platformWorker, { SERVER_ENV_CFO_MCP_ORIGIN_TRACKER: null });
    const { outcome, logs } = await step(h, { kind: "add", id: "github" });
    expect(outcome).toEqual({ kind: "ready", on: ["github"] });
    expect(logs.join("\n")).toContain("tracker is left off");
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("github");
  });

  it("rewrites the list when the release no longer ships a service, and drops its values", async () => {
    const h = await installed();
    await step(
      h,
      { kind: "add", id: "mail" },
      { manifests: WITH_MAIL, answers: [CLIENT_ID, CLIENT_SECRET] },
    );
    await step(h, { kind: "add", id: "tracker", origin: ORIGIN }, { manifests: WITH_MAIL });
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("mail,tracker");
    // A later release without "mail": removing something that is not on still rewrites the list.
    const { outcome } = await step(h, { kind: "remove", id: "github" });
    expect(outcome).toEqual({ kind: "ready", on: ["tracker"] });
    expect(secrets(h.world).get(MCP_SERVICES_SECRET)).toBe("tracker");
    expect(secrets(h.world).has("SERVER_ENV_CFO_MCP_CLIENT_SECRET_MAIL")).toBe(false);
    expect(secrets(h.world).has("SERVER_ENV_CFO_MCP_CLIENT_ID_MAIL")).toBe(false);
    expect(secrets(h.world).get("SERVER_ENV_CFO_MCP_ORIGIN_TRACKER")).toBe(ORIGIN);
  });
});

describe("the listing", () => {
  it("names each shipped service, on or off, and what it asks for", () => {
    expect(servicesListing(SHIPPED, undefined)).toEqual([
      "off  github: GitHub",
      "off  tracker: Demo work tracker (test service) (asks for: origin)",
    ]);
    const state: BootstrapState["journal"]["mcpServices"] = {
      on: ["tracker"],
      revision: "a".repeat(32),
      changedAt: "2026-10-30T10:00:00.000Z",
      confirmedAt: "2026-10-30T10:07:00.000Z",
      registry: true,
    };
    expect(servicesListing(SHIPPED, state)).toEqual([
      "off  github: GitHub",
      "on   tracker: Demo work tracker (test service) (asks for: origin)",
      "last changed at 2026-10-30T10:00:00.000Z; confirmed at 2026-10-30T10:07:00.000Z",
    ]);
  });
});
