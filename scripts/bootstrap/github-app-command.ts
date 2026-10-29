// `bootstrap.ts github-app`: wires the GitHub App step (github-app.ts) to the installation's state
// file, its locks and the bootstrap's own Cloudflare adapter, the one `run` uses: the installer's
// account (cloud.ts) or, for a staging installation, the guarded staging tool (staging.ts). The
// secrets reach Cloudflare only through that adapter's transport (an unlinked file on a
// descriptor), never an argument, a file that stays, or the output.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readWranglerConfig } from "../staging/cloud.ts";
import { acquireLock } from "../staging/lock.ts";
import { accountCloud } from "./cloud.ts";
import { browserCommand, createGitHubApp, GitHubAppRefusal } from "./github-app.ts";
import { stagingCloud } from "./staging.ts";
import { fileStateStore, resourceLockPaths, stagingStateProblem } from "./state.ts";

export interface GitHubAppCommandOptions {
  readonly root: string;
  readonly org?: string;
  readonly replace: boolean;
  /** Print the address instead of opening a browser. */
  readonly noOpen: boolean;
}

/** Opens the URL, detached; a missing opener only means the person uses the printed address. */
function openInBrowser(url: string): void {
  const [command, args] = browserCommand(process.platform, url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The address is printed; nothing else to do.
  }
}

/** Runs the step for the installation in the state file at `path`. Exit status 0, or throws. */
export async function githubAppCommand(
  path: string,
  options: GitHubAppCommandOptions,
): Promise<number> {
  const store = fileStateStore(path);
  const installation = store.load().installation;
  const misplaced = stagingStateProblem(installation, path);
  if (misplaced !== undefined) throw new GitHubAppRefusal(misplaced);
  const releases: (() => void)[] = [];
  try {
    // Never alongside a bootstrap run on the same Workers: the same locks as `run`.
    for (const lock of resourceLockPaths(installation)) {
      releases.push(acquireLock(lock, 0, `pid ${process.pid}, bootstrap github-app, ${path}`));
    }
    const worker = join(options.root, "worker");
    const cloud =
      installation.target.kind === "staging"
        ? stagingCloud(installation, {
            root: options.root,
            base: { web: readWranglerConfig(join(worker, "wrangler.web.jsonc"), worker).raw },
          })
        : accountCloud(installation, { workerDir: worker });
    const created = await createGitHubApp(
      installation,
      {
        cloud,
        openBrowser: options.noOpen ? () => undefined : openInBrowser,
        githubApi: (url, init) => fetch(url, init),
        random: (n) => new Uint8Array(randomBytes(n)),
        log: (message) => console.log(`bootstrap: ${message}`),
      },
      {
        ...(options.org === undefined ? {} : { org: options.org }),
        replace: options.replace,
      },
    );
    console.log(`bootstrap: GitHub App ${created.slug} is ready to install.`);
    return 0;
  } finally {
    for (const release of releases.reverse()) release();
  }
}
