// The registry readers and their checks (WP3.37), against the fake registries in world.ts:
// each download is checked against its publisher's data, and any disagreement throws.

import { describe, expect, it } from "vitest";
import {
  checksumFor,
  compareVersions,
  githubRelease,
  hubDigest,
  hubImageEnv,
  npmLatest,
  npmVersion,
  pypiHashes,
  pypiLatest,
  sha256Hex,
  verifiedAsset,
} from "../sources.ts";
import { bytesOf, CURRENT, ghSha, image, NODE, PYTHON, sha256, World, wheelSha } from "./world.ts";

const ports = (world: World, githubToken?: string) => ({
  fetch: world.fetch,
  ...(githubToken ? { githubToken } : {}),
});

describe("compareVersions", () => {
  it("orders numeric dotted versions", () => {
    expect(compareVersions("2.1.312", "2.1.311")).toBeGreaterThan(0);
    expect(compareVersions("0.13.6", "0.12.10")).toBeGreaterThan(0);
    expect(compareVersions("0.12.10", "0.12.9")).toBeGreaterThan(0);
    expect(compareVersions("1.7", "1.7.0")).toBe(0);
    expect(compareVersions("2026.10.23", "2026.10.30")).toBeLessThan(0);
    expect(() => compareVersions("0.166.0-alpha.6", "0.165.0")).toThrow(/not a release/);
  });
});

describe("npm", () => {
  it("reads the latest dist-tag and a version's integrity, signatures and provenance", async () => {
    const world = new World();
    world.codexWithProvenance("0.165.0");
    expect(await npmLatest(ports(world), "@openai/codex")).toBe("0.165.0");
    const v = await npmVersion(ports(world), "@openai/codex", "0.165.0");
    expect(v.signed).toBe(true);
    expect(v.provenance).toBe(true);
    expect(v.linuxX64).toEqual({ name: "@openai/codex", version: "0.165.0-linux-x64" });
    expect(v.integrity).toMatch(/^sha512-/);
    expect(JSON.parse(v.shape)).toEqual({
      bin: { codex: "bin/x" },
      scripts: { postinstall: "node install.cjs" },
    });
    const claude = await npmVersion(ports(world), "@anthropic-ai/claude-code", CURRENT.claude);
    expect(claude.provenance).toBe(false);
    expect(claude.linuxX64).toEqual({
      name: "@anthropic-ai/claude-code-linux-x64",
      version: CURRENT.claude,
    });
  });

  it("refuses an answer for another version, or one without a SHA-512 integrity", async () => {
    const world = new World();
    const lying: typeof world.fetch = async (url, init) => {
      const r = await world.fetch(url, init);
      const doc = (await r.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...doc, version: "9.9.9" }));
    };
    await expect(npmVersion({ fetch: lying }, "@openai/codex", "0.164.0")).rejects.toThrow(
      /disagrees/,
    );
    const sha1: typeof world.fetch = async () =>
      new Response(JSON.stringify({ version: "1.0.0", dist: { integrity: "sha1-abc" } }));
    await expect(npmVersion({ fetch: sha1 }, "@openai/codex", "1.0.0")).rejects.toThrow(/SHA-512/);
  });

  it("throws on an HTTP error", async () => {
    const world = new World();
    world.broken.push("registry.npmjs.org");
    await expect(npmLatest(ports(world), "@openai/codex")).rejects.toThrow(/HTTP 500/);
  });
});

describe("GitHub releases", () => {
  it("reads the latest release, or one by tag, and sends the token to the API only", async () => {
    const world = new World();
    world.latest.gh = "2.104.0";
    const latest = await githubRelease(ports(world, "t0ken"), "cli/cli");
    expect(latest).toMatchObject({ tag: "v2.104.0", version: "2.104.0" });
    const byTag = await githubRelease(ports(world, "t0ken"), "tsl0922/ttyd", "1.7.7");
    expect(byTag.tag).toBe("1.7.7");
    await verifiedAsset(
      ports(world, "t0ken"),
      latest,
      "cli/cli",
      "gh_2.104.0_linux_amd64.tar.gz",
      "gh_2.104.0_checksums.txt",
    );
    for (const r of world.requests) {
      const sent = r.headers.authorization === "Bearer t0ken";
      expect(sent).toBe(new URL(r.url).hostname === "api.github.com");
    }
  });

  it("refuses a draft, a pre-release, or another tag than asked", async () => {
    const answer = (doc: object) => async () => new Response(JSON.stringify(doc));
    const base = { tag_name: "v1.0.0", html_url: "https://github.com/x", assets: [] };
    await expect(githubRelease({ fetch: answer({ ...base, draft: true }) }, "a/b")).rejects.toThrow(
      /draft or a pre-release/,
    );
    await expect(
      githubRelease({ fetch: answer({ ...base, prerelease: true }) }, "a/b"),
    ).rejects.toThrow(/draft or a pre-release/);
    await expect(githubRelease({ fetch: answer(base) }, "a/b", "v2.0.0")).rejects.toThrow(
      /asked for v2.0.0/,
    );
    await expect(
      githubRelease({ fetch: answer({ ...base, assets: null }) }, "a/b"),
    ).rejects.toThrow(/no assets/);
  });

  it("finds exactly one checksum line, in text or binary mode", () => {
    const a = "1".repeat(64);
    const b = "2".repeat(64);
    expect(checksumFor(`${a}  x.tar.gz\n${b} *y.bin\n`, "y.bin")).toBe(b);
    expect(() => checksumFor(`${a}  x.tar.gz\n`, "y.bin")).toThrow(/0 lines/);
    expect(() => checksumFor(`${a}  y.bin\n${b}  y.bin\n`, "y.bin")).toThrow(/2 lines/);
  });

  it("verifies an asset against the checksum file and GitHub's upload digest", async () => {
    const world = new World();
    const release = await githubRelease(ports(world), "cli/cli", `v${CURRENT.gh}`);
    const args = [
      release,
      "cli/cli",
      `gh_${CURRENT.gh}_linux_amd64.tar.gz`,
      `gh_${CURRENT.gh}_checksums.txt`,
    ] as const;
    expect(await verifiedAsset(ports(world), ...args)).toBe(ghSha(CURRENT.gh));

    world.checksumText[`gh_${CURRENT.gh}_checksums.txt`] = `${"3".repeat(64)}  ${args[2]}\n`;
    await expect(verifiedAsset(ports(world), ...args)).rejects.toThrow(/checksums.txt says/);
    world.checksumText = {};

    world.uploadDigest[args[2]] = `sha256:${"4".repeat(64)}`;
    const tampered = await githubRelease(ports(world), "cli/cli", `v${CURRENT.gh}`);
    await expect(
      verifiedAsset(ports(world), tampered, ...(args.slice(1) as [string, string, string])),
    ).rejects.toThrow(/GitHub recorded/);

    await expect(
      verifiedAsset(ports(world), release, "cli/cli", "gh_arm64.tar.gz", args[3]),
    ).rejects.toThrow(/no asset gh_arm64/);
  });
});

describe("PyPI", () => {
  it("reads the latest version and one hash per pattern, skipping yanked files", async () => {
    const world = new World();
    world.latest.uv = "0.13.6";
    expect(await pypiLatest(ports(world), "uv")).toBe("0.13.6");
    const patterns = [/manylinux.*x86_64\.whl$/, /musllinux.*x86_64\.whl$/];
    const hashes = await pypiHashes(ports(world), "uv", "0.13.6", patterns);
    expect(hashes).toEqual([
      wheelSha("uv-0.13.6-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"),
      wheelSha("uv-0.13.6-py3-none-musllinux_1_1_x86_64.whl"),
    ]);
    world.yanked.add("uv-0.13.6-py3-none-musllinux_1_1_x86_64.whl");
    await expect(pypiHashes(ports(world), "uv", "0.13.6", patterns)).rejects.toThrow(
      /0 files match/,
    );
    world.yanked.clear();
    await expect(pypiHashes(ports(world), "uv", "0.13.6", [/\.whl$/])).rejects.toThrow(
      /2 files match/,
    );
  });

  it("refuses an answer without files or with a malformed hash", async () => {
    const answer = (doc: object) => async () => new Response(JSON.stringify(doc));
    await expect(pypiHashes({ fetch: answer({}) }, "pip", "1.0", [/x/])).rejects.toThrow(
      /no files/,
    );
    const bad = { urls: [{ filename: "pip-1.0-py3-none-any.whl", digests: { sha256: "XYZ" } }] };
    await expect(pypiHashes({ fetch: answer(bad) }, "pip", "1.0", [/whl$/])).rejects.toThrow(
      /bad SHA-256/,
    );
  });
});

describe("Docker Hub", () => {
  it("reads a tag's index digest and an image's environment, each checked", async () => {
    const world = new World();
    world.node = image("node", "NODE_VERSION", "22.24.0");
    expect(await hubDigest(ports(world), "library/node", "22-slim")).toBe(world.node.digest);
    expect(await hubImageEnv(ports(world), "library/node", world.node.digest, "NODE_VERSION")).toBe(
      "22.24.0",
    );
    expect(await hubImageEnv(ports(world), "library/python", PYTHON.digest, "PYTHON_VERSION")).toBe(
      CURRENT.python,
    );
    await expect(
      hubImageEnv(ports(world), "library/python", PYTHON.digest, "NODE_VERSION"),
    ).rejects.toThrow(/no NODE_VERSION/);
    // The registry token goes with every registry request.
    const registry = world.requests.filter((r) => r.url.includes("registry-1.docker.io"));
    expect(registry.every((r) => r.headers.authorization === "Bearer registry-token")).toBe(true);
  });

  it("refuses bytes that do not match the digest they are served as", async () => {
    const world = new World();
    const wrong: typeof world.fetch = async (url, init) => {
      const r = await world.fetch(url, init);
      if (!url.includes("/manifests/")) return r;
      return new Response(await r.text(), {
        headers: { "docker-content-digest": `sha256:${"0".repeat(64)}` },
      });
    };
    await expect(hubDigest({ fetch: wrong }, "library/node", "22-slim")).rejects.toThrow(
      /do not match/,
    );
    const blob: typeof world.fetch = async (url, init) =>
      url.includes("/blobs/") ? new Response("tampered") : world.fetch(url, init);
    await expect(
      hubImageEnv({ fetch: blob }, "library/node", NODE.digest, "NODE_VERSION"),
    ).rejects.toThrow(/config blob digest/);
  });

  it("refuses a single-platform manifest, or an index without exactly one linux/amd64", async () => {
    const serve = (doc: object) => async (url: string) => {
      if (url.startsWith("https://auth.docker.io")) {
        return new Response(JSON.stringify({ token: "t" }));
      }
      const body = JSON.stringify(doc);
      return new Response(body, { headers: { "docker-content-digest": `sha256:${sha256(body)}` } });
    };
    const single = { mediaType: "application/vnd.oci.image.manifest.v1+json" };
    await expect(hubDigest({ fetch: serve(single) }, "library/node", "22-slim")).rejects.toThrow(
      /not a multi-platform index/,
    );
    const noAmd64 = { mediaType: "application/vnd.oci.image.index.v1+json", manifests: [] };
    await expect(hubDigest({ fetch: serve(noAmd64) }, "library/node", "22-slim")).rejects.toThrow(
      /0 linux\/amd64/,
    );
  });
});

describe("sha256Hex", () => {
  it("hashes bytes", () => {
    expect(sha256Hex(new TextEncoder().encode(bytesOf("gh", "1")))).toBe(ghSha("1"));
  });
});
