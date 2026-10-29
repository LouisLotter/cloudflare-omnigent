// Writing a bump into the Dockerfiles, and the pull request's words for it (WP3.37).
//
// The bump is checked whole (pins.ts, parseBump and bumpTexts) before any file is touched; then
// every new file is written next to its original and only then renamed over it, so a failure
// leaves both Dockerfiles as they were.

import { join } from "node:path";
import {
  type Bump,
  bumpTexts,
  DOCKERFILES,
  type DockerfilePath,
  type Texts,
  TOOLS,
} from "./pins.ts";

/** The file operations `applyBump` needs; tests replace them to fail part way. */
export interface Files {
  readonly read: (path: string) => string;
  readonly write: (path: string, text: string) => void;
  readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
}

/** Writes the bump into the Dockerfiles under `root`. Returns the files it changed. */
export function applyBump(root: string, bump: Bump, files: Files): DockerfilePath[] {
  const texts = Object.fromEntries(
    DOCKERFILES.map((path) => [path, files.read(join(root, path))]),
  ) as unknown as Texts;
  const changed = bumpTexts(texts, bump);
  const paths = Object.keys(changed) as DockerfilePath[];
  const staged: string[] = [];
  try {
    for (const path of paths) {
      const temp = `${join(root, path)}.tool-versions.tmp`;
      staged.push(temp);
      files.write(temp, changed[path] as string);
    }
  } catch (error) {
    for (const temp of staged) {
      try {
        files.remove(temp);
      } catch {
        // Best effort: the original files are untouched either way.
      }
    }
    throw error;
  }
  const renamed: DockerfilePath[] = [];
  try {
    for (const path of paths) {
      files.rename(`${join(root, path)}.tool-versions.tmp`, join(root, path));
      renamed.push(path);
    }
  } catch (error) {
    // A rename in one directory hardly fails; if one does, put back what was already replaced.
    for (const path of renamed) files.write(join(root, path), texts[path]);
    for (const path of paths.filter((p) => !renamed.includes(p))) {
      files.remove(`${join(root, path)}.tool-versions.tmp`);
    }
    throw error;
  }
  return paths;
}

function line(c: Bump["changes"][number]): string {
  const name = TOOLS[c.tool];
  const what = c.from === c.to ? `${name} ${c.to}` : `${name} ${c.from} → ${c.to}`;
  return `- ${what} ([release notes](${c.link}))${c.note ? `. ${c.note}` : ""}`;
}

/** The pull request's (and the commit's) title: the tools and their new versions. */
export function title(bump: Bump): string {
  const parts = bump.changes.map((c) =>
    c.tool.endsWith("-image") ? TOOLS[c.tool] : `${TOOLS[c.tool]} ${c.to}`,
  );
  const text = `Tool versions: ${parts.join(", ")}`;
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

/** The pull request's body: short and plain, one line per tool. */
export function body(bump: Bump): string {
  return [
    "Newer releases of tools the images pin, found by the daily tool version check (`.github/workflows/tool-versions.yml`).",
    "",
    ...bump.changes.map(line),
    "",
    "The workflow computed every checksum itself, from the publisher's own data: npm's integrity values, registry signatures and Codex's provenance (checked with `npm audit signatures`), then the installed trees from the image's own install stage; gh's and ttyd's release checksum files; PyPI's file hashes; Docker Hub's index digests. The image builds check them all again.",
    "",
    "CI runs on this branch (dispatched by the workflow; see this commit's checks). After merging: run `node scripts/bootstrap/bootstrap.ts update` for each installation; each cloud computer takes the new image at its next start or wake.",
    ...(bump.changes.some((c) => c.tool === "claude-code" || c.tool === "codex")
      ? [
          "",
          'The setup page\'s sign-in parser is tested against login transcripts of older CLI versions (`images/computer/fakes/login_transcripts.json`); see docs/testing.md, "Signing in from the page".',
        ]
      : []),
    ...(bump.warnings.length > 0 ? ["", "Also seen:", ...bump.warnings.map((w) => `- ${w}`)] : []),
    "",
  ].join("\n");
}
