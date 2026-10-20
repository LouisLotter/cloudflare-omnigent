import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  bucketLookup,
  type CommandResult,
  childEnv,
  childStdio,
  cliCloud,
  dockerExecutable,
  fileStore,
  imagesOf,
  pushedImageReferences,
  type RunOptions,
  readWranglerConfig,
  workerLookup,
  wranglerCli,
} from "./cloud.ts";
import { type Deployment, validateDeployConfig } from "./guard.ts";
import { acquireLock, heldLockFds } from "./lock.ts";

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "worker");
const scratch = mkdtempSync(join(tmpdir(), "cfo-stg-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });
const NOT_FOUND = [
  "┌ APIError",
  "│ [10007] This Worker does not exist on your account.",
  "│ 404 Not Found · HTTP /accounts/x/workers/workers/cfo-stg-a",
  "└",
].join("\n");

describe("Worker lookup", () => {
  it("answers only when Cloudflare answered about that exact Worker", () => {
    expect(workerLookup(ok(JSON.stringify({ name: "cfo-stg-a" })), "cfo-stg-a")).toBe(true);
    expect(workerLookup(ok(JSON.stringify({ result: { name: "cfo-stg-a" } })), "cfo-stg-a")).toBe(
      true,
    );
    expect(workerLookup(failed(NOT_FOUND), "cfo-stg-a")).toBe(false);
  });

  it("treats every other outcome as unknown", () => {
    for (const result of [
      ok(JSON.stringify({ name: "cfo-stg-b" })),
      ok("null"),
      failed("│ [10000] Authentication error\n│ 403 Forbidden"),
      failed("│ 404 Not Found"),
      failed("fetch failed: ECONNRESET"),
      { status: null, stdout: "", stderr: "" },
    ]) {
      expect(() => workerLookup(result, "cfo-stg-a")).toThrow();
    }
    expect(() => workerLookup(ok("not json"), "cfo-stg-a")).toThrow();
  });
});

describe("R2 bucket lookup and image listings", () => {
  const NO_BUCKET =
    "│ [10006] The specified bucket does not exist.\n│ 404 Not Found · HTTP /r2/buckets/x";

  it("answers only when R2 answered about that exact bucket", () => {
    expect(bucketLookup(ok(JSON.stringify({ result: { name: "cfo-stg-a" } })), "cfo-stg-a")).toBe(
      true,
    );
    expect(bucketLookup(failed(NO_BUCKET), "cfo-stg-a")).toBe(false);
    for (const result of [
      ok(JSON.stringify({ result: { name: "cfo-stg-b" } })),
      failed("│ [10042] Please enable R2 through the Cloudflare Dashboard.\n│ 403 Forbidden"),
      failed("│ 404 Not Found"),
    ]) {
      expect(() => bucketLookup(result, "cfo-stg-a")).toThrow();
    }
  });

  it("picks the references of exactly one repository, in either listing shape", () => {
    const listing = [
      { name: "cfo-stg-a-host", tags: ["1", "2"] },
      { name: "cfo-stg-a-host-big", tags: ["1"] },
      "registry.cloudflare.com/acct/cfo-stg-a-host:3",
      "cfo-stg-ab:1",
    ];
    expect(imagesOf(listing, "cfo-stg-a-host")).toEqual([
      "cfo-stg-a-host:1",
      "cfo-stg-a-host:2",
      "registry.cloudflare.com/acct/cfo-stg-a-host:3",
    ]);
    expect(imagesOf([], "cfo-stg-a-host")).toEqual([]);
    expect(() => imagesOf({ images: [] }, "x")).toThrow();
    expect(() => imagesOf([{ name: "x" }], "x")).toThrow();
  });
});

describe("DC-36: the local Docker forgets what it pushed", () => {
  const ACCOUNT = "a".repeat(32);
  const OTHER = "b".repeat(32);
  const REGISTRY = `registry.cloudflare.com/${ACCOUNT}`;
  const line = (repository: string, tag: string, digest: string) =>
    JSON.stringify({ Repository: repository, Tag: tag, Digest: digest });

  it("picks the tags and digests of exactly the deployment's repositories in its account", () => {
    const listing = [
      line(`${REGISTRY}/cfo-stg-a-host`, "wrangler-1", "sha256:aaa"),
      line(`${REGISTRY}/cfo-stg-a-host`, "<none>", "sha256:bbb"),
      line(`${REGISTRY}/cfo-stg-a-host-big`, "1", "sha256:ccc"),
      line(`${REGISTRY}/nested/cfo-stg-a-host`, "1", "sha256:ddd"),
      line(`registry.cloudflare.com/${OTHER}/cfo-stg-a-host`, "1", "sha256:fff"),
      line("cfo-stg-a-host", "latest", "<none>"),
      line("docker.io/library/node", "22", "sha256:eee"),
      "",
    ].join("\n");
    expect(pushedImageReferences(listing, ACCOUNT, ["cfo-stg-a-host"])).toEqual([
      `${REGISTRY}/cfo-stg-a-host:wrangler-1`,
      `${REGISTRY}/cfo-stg-a-host@sha256:aaa`,
      `${REGISTRY}/cfo-stg-a-host@sha256:bbb`,
    ]);
    expect(pushedImageReferences(listing, ACCOUNT, [])).toEqual([]);
    expect(() => pushedImageReferences('{"Tag":"1"}', ACCOUNT, ["cfo-stg-a-host"])).toThrow(
      "unexpected entry",
    );
    expect(() => pushedImageReferences("", "acct", ["cfo-stg-a-host"])).toThrow("account ID");
  });

  it("cleans the image store Wrangler uses: WRANGLER_DOCKER_BIN, else docker", () => {
    expect(dockerExecutable({})).toBe("docker");
    expect(dockerExecutable({ WRANGLER_DOCKER_BIN: "" })).toBe("docker");
    expect(dockerExecutable({ WRANGLER_DOCKER_BIN: "/opt/podman/bin/docker" })).toBe(
      "/opt/podman/bin/docker",
    );
    const commands: string[] = [];
    const saved = process.env.WRANGLER_DOCKER_BIN;
    process.env.WRANGLER_DOCKER_BIN = "/opt/podman/bin/docker";
    try {
      cliCloud(config, WORKER, (command) => {
        commands.push(command);
        return ok("");
      }).forgetPushedImages(["cfo-stg-a-host"]);
    } finally {
      if (saved === undefined) delete process.env.WRANGLER_DOCKER_BIN;
      else process.env.WRANGLER_DOCKER_BIN = saved;
    }
    expect(commands).toEqual(["/opt/podman/bin/docker", "/opt/podman/bin/docker"]);
  });

  const config = { accountId: ACCOUNT, zone: "example.com", ownerEmail: "o@example.com" };
  /** A local Docker holding `held`; `rm` answers from `onRemove`, which may keep the image. */
  function docker(held: Set<string>, onRemove: (reference: string) => CommandResult) {
    const calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
    const cloud = cliCloud(config, WORKER, (command, args, options) => {
      calls.push({ command, args, options });
      if (args[1] === "ls") {
        return ok(
          [...held]
            .map((reference) => {
              const at = reference.indexOf("@");
              return at >= 0
                ? line(reference.slice(0, at), "<none>", reference.slice(at + 1))
                : line(reference.slice(0, reference.lastIndexOf(":")), "7", "<none>");
            })
            .join("\n"),
        );
      }
      return onRemove(args[2] as string);
    });
    return { cloud, calls };
  }

  it("removes each reference, quietly, and checks that none is left", () => {
    const foreign = `registry.cloudflare.com/${OTHER}/cfo-stg-a-host:7`;
    const held = new Set([
      `${REGISTRY}/cfo-stg-a-host:7`,
      `${REGISTRY}/cfo-stg-a-host@sha256:aaa`,
      `${REGISTRY}/cfo-stg-b-host:7`,
      foreign,
    ]);
    const { cloud, calls } = docker(held, (reference) => {
      held.delete(reference);
      // Removing the tag can take the digest reference with it.
      if (reference.endsWith(":7")) held.delete(`${REGISTRY}/cfo-stg-a-host@sha256:aaa`);
      return reference.includes("@") ? failed("Error: No such image: x") : ok("");
    });
    cloud.forgetPushedImages(["cfo-stg-a-host"]);
    expect([...held]).toEqual([`${REGISTRY}/cfo-stg-b-host:7`, foreign]);
    expect(calls.every((c) => c.command === "docker" && c.options.inherit === false)).toBe(true);
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "image ls",
      "image rm",
      "image rm",
      "image ls",
    ]);
  });

  it("stops the deploy when Docker refuses, or keeps an image it reported removed", () => {
    const busy = new Set([`${REGISTRY}/cfo-stg-a-host:7`]);
    expect(() =>
      docker(busy, () =>
        failed("Error: image is being used by a running container"),
      ).cloud.forgetPushedImages(["cfo-stg-a-host"]),
    ).toThrow("could not forget");
    const sticky = new Set([`${REGISTRY}/cfo-stg-a-host:7`]);
    expect(() => docker(sticky, () => ok("")).cloud.forgetPushedImages(["cfo-stg-a-host"])).toThrow(
      "still holds",
    );
    const broken = cliCloud(config, WORKER, () => failed("Cannot connect to the Docker daemon"));
    expect(() => broken.forgetPushedImages(["cfo-stg-a-host"])).toThrow("docker image ls failed");
  });
});

describe("CLI wiring", () => {
  const config = { accountId: "a".repeat(32), zone: "example.com", ownerEmail: "o@example.com" };
  const calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
  const cloud = cliCloud(config, WORKER, (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "accounts") return ok(JSON.stringify({ result: [{ id: "a".repeat(32) }] }));
    if (args[3] === "create") return ok(JSON.stringify({ result: { id: "app-1" } }));
    if (args[3] === "list") return ok(JSON.stringify({ result: [] }));
    return ok("{}");
  });

  it("deletes an Access application without waiting for a confirmation nobody can give", () => {
    cloud.deleteAccessApp("app-1");
    expect(calls.at(-1)?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "delete",
      "app-1",
      "--force",
    ]);
    expect(calls.at(-1)?.options.inherit).toBe(false);
  });

  it("updates an Access application by ID with the full body", () => {
    cloud.updateAccessApp("app-1", { name: "cfo-stg-a", same_site_cookie_attribute: "lax" });
    expect(calls.at(-1)?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "update",
      "app-1",
      "--body",
      '{"name":"cfo-stg-a","same_site_cookie_attribute":"lax"}',
    ]);
  });

  it("asks Access only about the exact hostname", () => {
    cloud.listAccessApps("cfo-stg-a.example.com");
    expect(calls.at(-1)?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "list",
      "--domain",
      "cfo-stg-a.example.com",
      "--exact",
    ]);
  });

  it("runs Wrangler's CLI directly, with exactly the guarded arguments", () => {
    const cli = wranglerCli(WORKER);
    expect(cli).toMatch(/wrangler-dist\/cli\.js$/);
    expect(existsSync(cli)).toBe(true);
    cloud.deployWorker("cfo-stg-a", "cfo-stg-a.example.com", "/w/wrangler.jsonc");
    expect(calls.at(-1)).toEqual({
      command: process.execPath,
      args: [
        "--no-warnings",
        cli,
        "deploy",
        "--config",
        "/w/wrangler.jsonc",
        "--name",
        "cfo-stg-a",
        "--domain",
        "cfo-stg-a.example.com",
      ],
      options: { inherit: true, cwd: WORKER },
    });
  });

  it("deletes through a generated configuration that pins the staging account", () => {
    let seen: { cwd: string | undefined; config: unknown } | undefined;
    const deleting = cliCloud(config, WORKER, (command, args, options) => {
      const file = args[args.indexOf("--config") + 1] ?? "";
      seen = { cwd: options.cwd, config: JSON.parse(readFileSync(file, "utf8")) };
      expect(command).toBe(process.execPath);
      expect(args.slice(2)).toEqual(["delete", "--config", file, "--name", "cfo-stg-a", "--force"]);
      expect(dirname(file)).toBe(options.cwd);
      return ok("");
    });
    deleting.deleteWorker("cfo-stg-a");
    expect(seen?.config).toEqual({ name: "cfo-stg-a", account_id: "a".repeat(32) });
    // The generated directory is removed afterwards.
    expect(existsSync(seen?.cwd ?? "/")).toBe(false);
  });

  it("passes the held staging locks to every child process", () => {
    const release = acquireLock(join(scratch, "locks", "wiring.lock"), 0, "test");
    try {
      const stdio = childStdio(false) as unknown[];
      expect(stdio.slice(0, 3)).toEqual(["ignore", "pipe", "pipe"]);
      expect(stdio.slice(3)).toEqual(heldLockFds());
      expect(heldLockFds()).toHaveLength(1);
    } finally {
      release();
    }
    expect(childStdio(true)).toEqual(["ignore", "inherit", "inherit"]);
  });

  it("manages buckets, container applications and images with cf, never interactively", () => {
    const cfCalls: (readonly string[])[] = [];
    let objects = 2;
    const managing = cliCloud(config, WORKER, (command, args) => {
      expect(command).toBe("cf");
      cfCalls.push(args);
      if (args[1] === "objects" && args[2] === "list") {
        const page = objects > 0 ? [{ key: `k${objects}` }] : [];
        objects -= 1;
        return ok(JSON.stringify({ result: page }));
      }
      if (args[1] === "applications" && args[2] === "list") {
        return ok(
          JSON.stringify({
            result: [
              { id: "ca-1", name: "cfo-stg-a-host" },
              { id: "ca-2", name: "cfo-stg-a-host-big" },
            ],
          }),
        );
      }
      if (args[1] === "images" && args[2] === "list") {
        return ok(JSON.stringify({ result: [{ name: "cfo-stg-a-host", tags: ["7"] }] }));
      }
      return ok("{}");
    });
    managing.createBucket("cfo-stg-a-data");
    expect(cfCalls.at(-1)).toEqual([
      "r2",
      "buckets",
      "create",
      "--body",
      '{"name":"cfo-stg-a-data"}',
    ]);
    managing.emptyAndDeleteBucket("cfo-stg-a-data");
    expect(
      cfCalls.filter((c) => c[2] === "bulk-delete").map((c) => c[c.indexOf("--body") + 1]),
    ).toEqual(['["k2"]', '["k1"]']);
    expect(cfCalls.at(-1)).toEqual(["r2", "buckets", "delete", "cfo-stg-a-data", "--force"]);
    expect(managing.containerApps("cfo-stg-a-host")).toEqual(["ca-1"]);
    managing.deleteContainerApp("ca-1");
    expect(cfCalls.at(-1)).toEqual(["containers", "applications", "delete", "ca-1", "--force"]);
    expect(managing.containerImages("cfo-stg-a-host")).toEqual(["cfo-stg-a-host:7"]);
    managing.deleteContainerImage("cfo-stg-a-host:7");
    expect(cfCalls.at(-1)).toEqual([
      "containers",
      "images",
      "delete",
      "cfo-stg-a-host:7",
      "--force",
    ]);
    // Every delete passes --force: there is no terminal to answer a confirmation. That includes
    // bulk-delete, which a check for an argument equal to "delete" missed until a live teardown.
    const deletes = cfCalls.filter((c) => c.some((arg) => arg.includes("delete")));
    expect(deletes.length).toBeGreaterThanOrEqual(5);
    expect(deletes.every((c) => c.includes("--force"))).toBe(true);
  });

  it("returns the created application's ID and fails loudly on a CLI error", () => {
    expect(cloud.createAccessApp({ name: "cfo-stg-a" })).toBe("app-1");
    expect(cloud.accountIds()).toEqual(["a".repeat(32)]);
    const broken = cliCloud(config, WORKER, () => failed("│ [10000] Authentication error"));
    expect(() => broken.accountIds()).toThrow("Authentication error");
    expect(() => broken.deployWorker("cfo-stg-a", "h", "/c")).toThrow("wrangler deploy exited");
  });

  it("pins the account and drops CLOUDFLARE_ENV for every child process", () => {
    process.env.CLOUDFLARE_ENV = "production";
    try {
      const env = childEnv("b".repeat(32));
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("b".repeat(32));
      expect(env.CLOUDFLARE_ENV).toBeUndefined();
    } finally {
      delete process.env.CLOUDFLARE_ENV;
    }
  });
});

describe("Wrangler's own reading of a configuration", () => {
  const write = (name: string, body: Record<string, unknown> | string): string => {
    const path = join(scratch, name);
    const base = { name: "x", main: "src/index.ts", compatibility_date: "2026-10-01" };
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify({ ...base, ...body }));
    return path;
  };
  const ACCOUNT = "a".repeat(32);
  const check = (path: string) =>
    validateDeployConfig(readWranglerConfig(path, WORKER), ACCOUNT, "cfo-stg-x");
  const closed = { workers_dev: false, preview_urls: false };

  it("accepts containers and buckets that carry the deployment's name, as Wrangler reads them", () => {
    const own = {
      ...closed,
      durable_objects: { bindings: [{ name: "HOST", class_name: "Host" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Host"] }],
      containers: [
        { name: "cfo-stg-x-host", class_name: "Host", image: "./Dockerfile", max_instances: 1 },
      ],
      r2_buckets: [{ binding: "DATA", bucket_name: "cfo-stg-x-data" }],
    };
    writeFileSync(join(scratch, "Dockerfile"), "FROM busybox:1.37\n"); // Wrangler checks it exists
    expect(() => check(write("own-resources.json", own))).not.toThrow();
    const foreign = { ...own, r2_buckets: [{ binding: "DATA", bucket_name: "production-data" }] };
    expect(() => check(write("foreign-bucket.json", foreign))).toThrow("bucket_name");
    const big = { ...own, containers: [{ ...own.containers[0], max_instances: 50 }] };
    expect(() => check(write("big-container.json", big))).toThrow("max_instances");
    const policy = {
      ...own,
      containers: [
        {
          name: "cfo-stg-x-computer",
          class_name: "Host",
          scheduling_policy: "durable_object",
          images: { computer: { dockerfile: "./Dockerfile" } },
        },
      ],
    };
    expect(() => check(write("policy.json", policy))).not.toThrow();
    const sshPolicy = {
      ...policy,
      containers: [{ ...policy.containers[0], ssh: { enabled: true } }],
    };
    expect(() => check(write("policy-ssh.json", sshPolicy))).toThrow('"ssh"');
  });

  it("accepts the checked-in Worker configuration", () => {
    expect(() => check(join(WORKER, "wrangler.jsonc"))).not.toThrow();
  });

  it.each([
    ["workers.dev enabled", { ...closed, workers_dev: true }],
    ["preview URLs enabled", { ...closed, preview_urls: true }],
    ["alternate URLs left to their defaults", {}],
    ["a legacy route", { ...closed, route: "x.example.com/*" }],
    ["several routes", { ...closed, routes: ["a.example.com/*", "b.example.com/*"] }],
    [
      "an extra custom domain",
      { ...closed, routes: [{ pattern: "x.example.com", custom_domain: true }] },
    ],
    ["an environment", { ...closed, env: { staging: { workers_dev: true } } }],
    // Wrangler prefers a config's account_id to CLOUDFLARE_ACCOUNT_ID.
    ["another account", { ...closed, account_id: "b".repeat(32) }],
    [
      "an R2 bucket outside staging",
      { ...closed, r2_buckets: [{ binding: "DATA", bucket_name: "non-staging-data" }] },
    ],
    ["a service binding", { ...closed, services: [{ binding: "S", service: "prod" }] }],
    ["a KV namespace", { ...closed, kv_namespaces: [{ binding: "K", id: "0".repeat(32) }] }],
    [
      "a Durable Object in another Worker",
      {
        ...closed,
        durable_objects: { bindings: [{ name: "D", class_name: "D", script_name: "prod" }] },
      },
    ],
    [
      "a migration that takes another Worker's Durable Objects",
      {
        ...closed,
        migrations: [
          {
            tag: "v1",
            transferred_classes: [{ from: "P", from_script: "production-worker", to: "I" }],
          },
        ],
      },
    ],
    [
      "a log export destination",
      { ...closed, observability: { logs: { enabled: true, destinations: ["prod-sink"] } } },
    ],
  ])("refuses %s", (label, body) => {
    expect(() => check(write(`${label.replaceAll(" ", "-")}.json`, body))).toThrow(
      "refusing Wrangler config",
    );
  });

  it("reads JSONC the way Wrangler does, including comments and repeated keys", () => {
    const path = write(
      "repeated.jsonc",
      `{
        // the later key wins in Wrangler's parser
        "name": "x", "main": "src/index.ts", "compatibility_date": "2026-10-01",
        "workers_dev": false, "preview_urls": false, "workers_dev": true,
      }`,
    );
    expect(() => check(path)).toThrow('"workers_dev" must be false');
  });

  it("refuses missing files, other formats, and a selected environment", () => {
    expect(() => readWranglerConfig(join(scratch, "missing.jsonc"), WORKER)).toThrow("no Wrangler");
    expect(() => readWranglerConfig(write("wrangler.toml", "name = 'x'"), WORKER)).toThrow(
      "no Wrangler",
    );
    process.env.CLOUDFLARE_ENV = "staging";
    try {
      expect(() => readWranglerConfig(join(WORKER, "wrangler.jsonc"), WORKER)).toThrow(
        "CLOUDFLARE_ENV",
      );
    } finally {
      delete process.env.CLOUDFLARE_ENV;
    }
  });
});

describe("registry file store", () => {
  it("writes atomically, readable by the owner only", () => {
    const file = join(scratch, "state", "resources.json");
    const store = fileStore(file, "test");
    expect(store.load()).toEqual([]);
    const d: Deployment = {
      name: "cfo-stg-a",
      hostname: "cfo-stg-a.example.com",
      owner: "wp0.4",
      createdAt: "2026-10-18T12:00:00.000Z",
      expiresAt: "2026-10-25T12:00:00.000Z",
      state: "pending",
    };
    store.update((all) => [...all, d]);
    expect(store.load()).toEqual([d]);
    // A failed change leaves the registry as it was and releases the registry lock.
    expect(() =>
      store.update(() => {
        throw new Error("change failed");
      }),
    ).toThrow("change failed");
    expect(store.load()).toEqual([d]);
    store.update((all) => all);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(3);
  });
});
