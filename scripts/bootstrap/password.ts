// The owner's Omnigent password at install time, only when the person asks to choose it there
// (WP3.34). By default the installer chooses none: it uploads a random password nobody sees
// (machine.ts, settings.ts), and the owner chooses theirs on the site's password page after
// Cloudflare Access (`https://<hostname>`, which sends a first visit there). That is the happy
// path; the earlier step that handed a generated password to the person is gone (owner, 29 Oct).
//
// The fallbacks: `--password-prompt` asks for it here, typed twice and never echoed, in a
// terminal only; `--secrets-stdin` reads it from a JSON object on stdin (bootstrap.ts). Either
// way it is never printed, logged, put in argv or the environment, or written to a named file:
// it reaches Wrangler as every uploaded secret does (staging/cloud.ts, withSecretsDescriptor).

import { passwordProblem } from "./settings.ts";

/** What the prompt needs of the terminal. */
export interface PasswordIo {
  readonly isTTY: boolean;
  /** Reads a line without echoing it. */
  readonly prompt: (question: string) => Promise<string>;
  readonly say: (line: string) => void;
}

export interface PasswordOptions {
  /** An earlier run took a password that never reached the installation. */
  readonly replaces: boolean;
}

/** The owner's password, typed twice (--password-prompt). */
export async function promptOwnerPassword(
  io: PasswordIo,
  options: PasswordOptions,
): Promise<string> {
  if (!io.isTTY) {
    throw new Error(
      "--password-prompt needs a terminal; without it, the owner chooses the password on the site",
    );
  }
  if (options.replaces) {
    io.say("The password an earlier, unfinished run took never reached the installation.");
  }
  const password = await io.prompt("The owner's Omnigent password (not shown): ");
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  if ((await io.prompt("Again: ")) !== password) throw new Error("the passwords differ");
  return password;
}
