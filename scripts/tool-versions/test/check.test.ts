// The daily check (WP3.37) against the fake registries: "already current" proposes nothing,
// each kind of update gets its computed pins, the CLIs' tree digests come from the recorder,
// and any failed lookup or check rejects the whole check.

import { describe, expect, it, vi } from "vitest";
import { type CliDigests, checkTools, parseCliDigests } from "../check.ts";
import { parsePyPin } from "../pins.ts";
import {
  CURRENT,
  computerDockerfile,
  DIGESTS,
  ghSha,
  image,
  NODE,
  serverDockerfile,
  texts,
  ttydSha,
  World,
  wheelSha,
} from "./world.ts";

const NEW_DIGESTS: CliDigests = {
  CLAUDE_CODE_TREE_SHA256: "d".repeat(64),
  CLAUDE_CODE_INSTALLED_SHA256: "e".repeat(64),
  CODEX_TREE_SHA256: "f".repeat(64),
};

function setup(digests: CliDigests = NEW_DIGESTS) {
  const world = new World();
  const record = vi.fn(async (_args: Readonly<Record<string, string>>) => digests);
  const logs: string[] = [];
  const ports = { fetch: world.fetch, recordCliDigests: record, log: (m: string) => logs.push(m) };
  return { world, record, logs, ports };
}

describe("checkTools", () => {
  it("proposes nothing, and builds nothing, when every tool is current", async () => {
    const { ports, record } = setup();
    const bump = await checkTools(texts(), ports);
    expect(bump).toEqual({ schema: 1, changes: [], args: {}, warnings: [] });
    expect(record).not.toHaveBeenCalled();
  });

  it("bumps Claude Code and Codex with the recorded tree digests", async () => {
    const { world, ports, record, logs } = setup();
    world.latest.claude = "2.1.312";
    world.codexWithProvenance("0.165.0");
    const bump = await checkTools(texts(), ports);
    expect(bump.args).toEqual({
      CLAUDE_CODE_VERSION: "2.1.312",
      CODEX_VERSION: "0.165.0",
      ...NEW_DIGESTS,
    });
    expect(bump.changes).toEqual([
      {
        tool: "claude-code",
        from: "2.1.311",
        to: "2.1.312",
        link: "https://github.com/anthropics/claude-code/releases/tag/v2.1.312",
      },
      {
        tool: "codex",
        from: "0.164.0",
        to: "0.165.0",
        link: "https://github.com/openai/codex/releases/tag/rust-v0.165.0",
      },
    ]);
    const inputs = record.mock.calls[0]?.[0];
    expect(inputs?.CLAUDE_CODE_VERSION).toBe("2.1.312");
    expect(inputs?.CODEX_VERSION).toBe("0.165.0");
    expect(inputs?.PYTHON_IMAGE).toContain("python:3.12-slim@sha256:");
    expect(logs).toContain(
      "@openai/codex@0.165.0 and @openai/codex@0.165.0-linux-x64: SHA-512 integrity, registry signatures, provenance published",
    );
  });

  it("keeps a digest that did not move out of the bump", async () => {
    const { world, ports } = setup({ ...DIGESTS, CLAUDE_CODE_TREE_SHA256: "d".repeat(64) });
    world.latest.claude = "2.1.312";
    const bump = await checkTools(texts(), ports);
    expect(Object.keys(bump.args).sort()).toEqual([
      "CLAUDE_CODE_TREE_SHA256",
      "CLAUDE_CODE_VERSION",
    ]);
  });

  it("notes a CLI tree digest that moved without a version change", async () => {
    const { world, ports, record } = setup({ ...DIGESTS, CODEX_TREE_SHA256: "f".repeat(64) });
    world.node = image("node", "NODE_VERSION", "22.24.0");
    const bump = await checkTools(texts(), ports);
    expect(record).toHaveBeenCalledOnce();
    expect(bump.args.NODE_IMAGE).toBe(`node:22-slim@sha256:${world.node.digest}`);
    expect(bump.args.CODEX_TREE_SHA256).toBe("f".repeat(64));
    expect(bump.changes.map((c) => [c.tool, c.from, c.to])).toEqual([
      [
        "node-image",
        `22.23.4 (sha256:${NODE.digest.slice(0, 12)})`,
        `22.24.0 (sha256:${world.node.digest.slice(0, 12)})`,
      ],
      ["codex", CURRENT.codex, CURRENT.codex],
    ]);
    expect(bump.changes[0]?.link).toBe("https://github.com/nodejs/node/releases/tag/v22.24.0");
    expect(bump.changes[1]?.note).toMatch(/Same version, new installed-tree digest/);
  });

  it("links Docker Hub for a new digest of the same version", async () => {
    const { world, ports } = setup(DIGESTS);
    world.python = image("python", "PYTHON_VERSION", CURRENT.python, "debian security fix");
    const bump = await checkTools(texts(), ports);
    expect(bump.changes).toHaveLength(1);
    expect(bump.changes[0]?.link).toBe("https://hub.docker.com/_/python");
    expect(Object.keys(bump.args)).toEqual(["PYTHON_IMAGE"]);
  });

  it("bumps gh and ttyd with checksums verified against their releases", async () => {
    const { world, ports, record } = setup();
    world.latest.gh = "2.104.0";
    world.latest.ttyd = "1.7.8";
    const bump = await checkTools(texts(), ports);
    expect(bump.args).toEqual({
      GH_VERSION: "2.104.0",
      GH_SHA256_AMD64: ghSha("2.104.0"),
      TTYD_VERSION: "1.7.8",
      TTYD_SHA256: ttydSha("1.7.8"),
    });
    expect(bump.changes.map((c) => c.link)).toEqual([
      "https://github.com/cli/cli/releases/tag/v2.104.0",
      "https://github.com/tsl0922/ttyd/releases/tag/1.7.8",
    ]);
    expect(record).not.toHaveBeenCalled();
  });

  it("bumps certifi, pip and uv with PyPI's hashes; pip also re-records the CLIs", async () => {
    const { world, ports, record } = setup(DIGESTS);
    world.latest.certifi = "2026.10.30";
    world.latest.pip = "26.3";
    world.latest.uv = "0.13.6";
    const bump = await checkTools(texts(), ports);
    expect(parsePyPin(bump.args.UV_PIN as string).hashes).toEqual([
      wheelSha("uv-0.13.6-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"),
      wheelSha("uv-0.13.6-py3-none-musllinux_1_1_x86_64.whl"),
    ]);
    expect(bump.args.CERTIFI_PIN).toBe(
      `certifi==2026.10.30 --hash=sha256:${wheelSha("certifi-2026.10.30-py3-none-any.whl")}`,
    );
    expect(bump.args.PIP_PIN).toContain("pip==26.3 ");
    expect(record).toHaveBeenCalledOnce();
    expect(bump.changes.map((c) => c.tool)).toEqual(["certifi", "pip", "uv"]);
  });

  it("never downgrades: an older or non-release latest is only a warning", async () => {
    const { world, ports } = setup();
    world.latest.claude = "2.1.300";
    world.latest.uv = "0.14.0rc1\u0007";
    const bump = await checkTools(texts(), ports);
    expect(bump.changes).toEqual([]);
    expect(bump.warnings).toEqual([
      "Claude Code: the latest release, 2.1.300, is older than 2.1.311",
      "uv: the latest release, 0.14.0rc1?, is not a plain version",
    ]);
  });

  it("notes a changed bin entry or install script", async () => {
    const { world, ports } = setup();
    world.latest.claude = "2.1.312";
    world.npmShape["@anthropic-ai/claude-code@2.1.312"] = { claude: "bin/claude.js" };
    const bump = await checkTools(texts(), ports);
    expect(bump.changes[0]?.note).toMatch(/bin entry or install scripts changed/);
  });

  it.each([
    [
      "an unsigned version",
      (w: World) => w.unsigned.add("@anthropic-ai/claude-code@2.1.312"),
      /no registry signatures/,
    ],
    [
      "lost provenance",
      (w: World) => {
        w.latest.codex = "0.165.0";
      },
      /@openai\/codex@0.165.0: no provenance attestation/,
    ],
    [
      "lost provenance on the native binary's part",
      (w: World) => {
        w.codexWithProvenance("0.165.0");
        w.provenance.delete("@openai/codex@0.165.0-linux-x64");
      },
      /@openai\/codex@0.165.0-linux-x64: no provenance attestation/,
    ],
    [
      "an unsigned native binary part",
      (w: World) => w.unsigned.add("@anthropic-ai/claude-code-linux-x64@2.1.312"),
      /claude-code-linux-x64@2.1.312: no registry signatures/,
    ],
    [
      "no linux-x64 part",
      (w: World) => w.noLinuxPart.add("@anthropic-ai/claude-code@2.1.312"),
      /no linux-x64 package/,
    ],
    ["a registry error", (w: World) => w.broken.push("pypi.org/pypi/pip"), /HTTP 500/],
    [
      "a bad checksum file",
      (w: World) => {
        w.latest.gh = "2.104.0";
        w.checksumText["gh_2.104.0_checksums.txt"] = "";
      },
      /0 lines/,
    ],
  ])("rejects the whole check on %s", async (_what, breakIt, error) => {
    const { world, ports, record } = setup();
    world.latest.claude = "2.1.312";
    breakIt(world);
    await expect(checkTools(texts(), ports)).rejects.toThrow(error);
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects the whole check when the digest recorder fails", async () => {
    const { world, ports } = setup();
    world.codexWithProvenance("0.165.0");
    const failing = {
      ...ports,
      recordCliDigests: async () => Promise.reject(new Error("build failed")),
    };
    await expect(checkTools(texts(), failing)).rejects.toThrow(/build failed/);
  });

  it("refuses a release whose tag the Dockerfile's URL would not build", async () => {
    const { world, ports } = setup();
    world.latest.ttyd = "1.7.8";
    const vTagged: typeof world.fetch = async (url, init) => {
      const r = await world.fetch(url, init);
      if (!url.includes("tsl0922/ttyd/releases/latest")) return r;
      const doc = (await r.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...doc, tag_name: "v1.7.8" }));
    };
    await expect(checkTools(texts(), { ...ports, fetch: vTagged })).rejects.toThrow(
      /tag v1.7.8 is not 1.7.8/,
    );
  });

  it("refuses a requirement whose hash count does not fit its file patterns", async () => {
    const { ports } = setup();
    const pin = `"pip==26.2.2 --hash=sha256:${"1".repeat(64)} --hash=sha256:${"2".repeat(64)}"`;
    const files = {
      "images/computer/Dockerfile": computerDockerfile({ PIP_PIN: pin }),
      "images/server/Dockerfile": serverDockerfile({ PIP_PIN: pin }),
    };
    await expect(checkTools(files, ports)).rejects.toThrow(/PIP_PIN: 2 hashes, but 1 file/);
  });

  describe("reproduce", () => {
    it("recomputes every current pin, reading each pinned release, and accepts them", async () => {
      const { world, ports, record } = setup(DIGESTS);
      world.latest.gh = "2.104.0";
      world.latest.ttyd = "1.7.8";
      const bump = await checkTools(texts(), ports, { reproduce: true });
      expect(bump.changes).toEqual([]);
      expect(record).toHaveBeenCalledOnce();
      expect(world.requests.some((r) => r.url.endsWith("/releases/tags/v2.103.3"))).toBe(true);
    });

    it("fails, naming them, when computed pins differ from the committed ones", async () => {
      const { ports } = setup(NEW_DIGESTS);
      await expect(checkTools(texts(), ports, { reproduce: true })).rejects.toThrow(
        /reproduced pins differ: CLAUDE_CODE_TREE_SHA256, CLAUDE_CODE_INSTALLED_SHA256, CODEX_TREE_SHA256/,
      );
    });
  });
});

describe("parseCliDigests", () => {
  const good = [
    `CLAUDE_CODE_TREE_SHA256=${"a".repeat(64)}`,
    `CODEX_TREE_SHA256=${"c".repeat(64)}`,
    `CLAUDE_CODE_INSTALLED_SHA256=${"b".repeat(64)}`,
    "CLAUDE_CODE_VERSION=2.1.312",
    "CODEX_VERSION=0.165.0",
    "",
  ].join("\n");
  const versions = { claudeCode: "2.1.312", codex: "0.165.0" };

  it("reads exactly the three digests for the requested versions", () => {
    expect(parseCliDigests(good, versions)).toEqual({
      CLAUDE_CODE_TREE_SHA256: "a".repeat(64),
      CLAUDE_CODE_INSTALLED_SHA256: "b".repeat(64),
      CODEX_TREE_SHA256: "c".repeat(64),
    });
  });

  it.each([
    ["a duplicate", `${good}CODEX_VERSION=0.165.0\n`, /unexpected line/],
    ["a stray line", `${good}junk\n`, /unexpected line/],
    ["an extra key", `${good}EXTRA=1\n`, /expected/],
    ["a missing key", good.replace(/^CODEX_TREE.*\n/m, ""), /expected/],
    ["another Claude Code", good.replace("2.1.312", "2.1.311"), /another Claude Code/],
    [
      "another Codex",
      good.replace("CODEX_VERSION=0.165.0", "CODEX_VERSION=0.164.0"),
      /another Codex/,
    ],
    ["a malformed digest", good.replace("a".repeat(64), "a".repeat(63)), /not a SHA-256/],
  ])("refuses %s", (_what, text, error) => {
    expect(() => parseCliDigests(text, versions)).toThrow(error);
  });
});
