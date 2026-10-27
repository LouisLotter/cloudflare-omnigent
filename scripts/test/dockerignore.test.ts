// The repository root's .dockerignore against the per-Dockerfile ignore files and every COPY
// from the root context (WP3.19). Wrangler passes a Dockerfile on stdin, so BuildKit reads the
// root file, never `Dockerfile.dockerignore`: the root file must let in everything each image
// copies, and keep out the same caches.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");

/** The lines of an ignore file that are patterns: no blanks, no comments. */
function patterns(path: string): string[] {
  return readFileSync(join(ROOT, path), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * The context paths a Dockerfile reads: `COPY <src>... <dest>` without `--from`, and each
 * `RUN --mount=type=bind,source=<src>` without `from=` (the trust scripts, WP3.20).
 */
function copied(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of readFileSync(join(ROOT, dockerfile), "utf8").split("\n")) {
    for (const mount of line.matchAll(/--mount=(\S+)/g)) {
      const options = mount[1]?.split(",") ?? [];
      if (!options.includes("type=bind") || options.some((o) => o.startsWith("from="))) continue;
      const source = options.find((o) => o.startsWith("source="));
      if (source) sources.push(source.slice("source=".length));
    }
    const match = /^COPY\s+(?!--from)(.+)$/.exec(line.trim());
    if (!match?.[1]) continue;
    const parts = match[1].split(/\s+/).filter((part) => !part.startsWith("--"));
    sources.push(...parts.slice(0, -1));
  }
  return sources;
}

/**
 * Whether a copied path is let in by one of the `!` patterns: the entry itself, a file in an
 * allowed directory, or a directory the ignore file narrows to an allowed part of it (the
 * computer's test stage copies `contracts/`, of which only three directories come in).
 */
function letIn(allowed: readonly string[], path: string): boolean {
  return allowed.some(
    (entry) =>
      path === entry ||
      (entry.endsWith("/") && path.startsWith(entry)) ||
      (path.endsWith("/") && entry.startsWith(path)),
  );
}

describe("the root .dockerignore (Wrangler's stdin builds)", () => {
  const root = patterns(".dockerignore");
  const allowed = root.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const perDockerfile = [
    "images/server/Dockerfile.dockerignore",
    "images/computer/Dockerfile.dockerignore",
  ];

  it("excludes everything first, then lets in each image's own paths and the drill's", () => {
    expect(root[0]).toBe("*");
    for (const file of perDockerfile) {
      for (const pattern of patterns(file)) {
        if (pattern.startsWith("!"))
          expect(allowed, `${file}: ${pattern}`).toContain(pattern.slice(1));
        else expect(root, `${file}: ${pattern}`).toContain(pattern);
      }
    }
    expect(allowed).toContain("scripts/restore-drill/cfo_drill/");
  });

  it("lets in every path a root-context Dockerfile copies or bind-mounts", () => {
    for (const dockerfile of [
      "images/server/Dockerfile",
      "images/computer/Dockerfile",
      "scripts/restore-drill/staging/Dockerfile",
    ]) {
      const sources = copied(dockerfile);
      expect(sources.length, dockerfile).toBeGreaterThan(0);
      for (const source of sources)
        expect(letIn(allowed, source), `${dockerfile}: ${source}`).toBe(true);
    }
  });

  it("keeps Python's caches out, so a checkout's state never changes an image", () => {
    expect(root).toEqual(expect.arrayContaining(["**/__pycache__/", "**/*.pyc"]));
  });
});
