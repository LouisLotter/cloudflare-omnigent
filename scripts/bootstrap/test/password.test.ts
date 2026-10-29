// The owner's password at install time (WP3.34): only the typed fallback is left. No clipboard
// path anywhere in the installer, and the default needs no password from the person at all.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type PasswordIo, promptOwnerPassword } from "../password.ts";
import { OWNER_PASSWORD, ROOT } from "./fixtures.ts";

function io(answers: string[], isTTY = true): PasswordIo & { said: string[]; asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    isTTY,
    said,
    asked,
    prompt: async (question) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    say: (line) => said.push(line),
  };
}

describe("promptOwnerPassword (--password-prompt)", () => {
  it("takes the password typed twice", async () => {
    const terminal = io([OWNER_PASSWORD, OWNER_PASSWORD]);
    expect(await promptOwnerPassword(terminal, { replaces: false })).toBe(OWNER_PASSWORD);
    expect(terminal.asked).toEqual(["The owner's Omnigent password (not shown): ", "Again: "]);
    expect(terminal.said).toEqual([]);
  });

  it("refuses two different ones, and one the server would not accept", async () => {
    await expect(
      promptOwnerPassword(io([OWNER_PASSWORD, `${OWNER_PASSWORD}x`]), { replaces: false }),
    ).rejects.toThrow("the passwords differ");
    await expect(promptOwnerPassword(io(["short"]), { replaces: false })).rejects.toThrow(
      /at least 8 characters/,
    );
    await expect(
      promptOwnerPassword(io([` ${OWNER_PASSWORD}`]), { replaces: false }),
    ).rejects.toThrow(/whitespace/);
  });

  it("needs a terminal, and says why", async () => {
    await expect(promptOwnerPassword(io([], false), { replaces: false })).rejects.toThrow(
      /needs a terminal; without it, the owner chooses the password on the site/,
    );
  });

  it("says when an earlier run's password never arrived, without any password", async () => {
    const terminal = io([OWNER_PASSWORD, OWNER_PASSWORD]);
    await promptOwnerPassword(terminal, { replaces: true });
    expect(terminal.said).toHaveLength(1);
    expect(terminal.said[0]).not.toContain(OWNER_PASSWORD);
  });
});

describe("no clipboard anywhere", () => {
  it("the installer and the staging harness name no clipboard tool", () => {
    const files = [
      ...readdirSync(join(ROOT, "scripts", "bootstrap"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "scripts", "bootstrap", name)),
      join(ROOT, "worker", "test", "staging", "wp318", "run.sh"),
      join(ROOT, "docs", "install.md"),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/wl-copy|xclip|xsel|pbcopy|clipboard/);
    }
  });
});
