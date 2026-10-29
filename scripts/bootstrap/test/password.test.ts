// The owner's generated password on the clipboard (WP3.31): generation, the tool for each
// platform, a fake clipboard tool on PATH, and the fallbacks.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClipboardTool,
  clipboardTool,
  copyToClipboard,
  generatePassword,
  onPath,
  ownerPassword,
  PASSWORD_ALPHABET,
  PASSWORD_LENGTH,
  type PasswordIo,
} from "../password.ts";
import { passwordProblem } from "../settings.ts";

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37) % 256));

describe("generatePassword", () => {
  it("is 24 characters of the alphabet, which the server accepts, whatever the random bytes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 24, maxLength: 24 }), { minLength: 30, maxLength: 30 }),
        (draws) => {
          let i = 0;
          const password = generatePassword(() => draws[i++ % draws.length] ?? new Uint8Array(24));
          expect(password).toHaveLength(PASSWORD_LENGTH);
          expect([...password].every((c) => PASSWORD_ALPHABET.includes(c))).toBe(true);
          expect(passwordProblem(password)).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("skips the bytes that would bias it, and has no look-alike characters", () => {
    // 228 and above are rejected (57 * 4 = 228); 0 is "A", 57 is "A" again.
    const draws = [new Uint8Array(24).fill(250), new Uint8Array(24).fill(57)];
    let i = 0;
    expect(generatePassword(() => draws[i++] ?? new Uint8Array(24))).toBe("A".repeat(24));
    expect(PASSWORD_ALPHABET).not.toMatch(/[0O1lI]/);
    expect(new Set(PASSWORD_ALPHABET).size).toBe(57);
    expect(generatePassword(bytes)).not.toBe(generatePassword((n) => bytes(n).reverse()));
  });
});

describe("clipboardTool", () => {
  const all = () => true;
  it.each([
    ["macOS", {}, "darwin", { command: "pbcopy", args: [] }],
    [
      "Wayland",
      { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      "linux",
      { command: "wl-copy", args: [] },
    ],
    ["X11", { DISPLAY: ":0" }, "linux", { command: "xclip", args: ["-selection", "clipboard"] }],
    ["a terminal without a display", {}, "linux", undefined],
  ] as const)("%s", (_name, env, platform, tool) => {
    expect(clipboardTool(env, platform, all)).toEqual(tool);
  });

  it("falls back to xsel, then to X11 from Wayland, and to nothing when no tool is installed", () => {
    const only =
      (...have: string[]) =>
      (command: string) =>
        have.includes(command);
    expect(clipboardTool({ DISPLAY: ":0" }, "linux", only("xsel"))).toEqual({
      command: "xsel",
      args: ["--clipboard", "--input"],
    });
    expect(clipboardTool({ WAYLAND_DISPLAY: "w", DISPLAY: ":0" }, "linux", only("xclip"))).toEqual({
      command: "xclip",
      args: ["-selection", "clipboard"],
    });
    expect(clipboardTool({ WAYLAND_DISPLAY: "w" }, "linux", only())).toBeUndefined();
    expect(clipboardTool({}, "darwin", only())).toBeUndefined();
  });
});

describe("a fake clipboard tool on PATH", () => {
  let dir: string;
  let bin: string;
  let out: string;
  let saved: string | undefined;

  /** A clipboard tool that writes what it reads to `out`, and its arguments beside it. */
  function tool(name: string, status = 0): void {
    const script = `#!/bin/sh\nprintf '%s' "$*" > "${out}.args"\ncat > "${out}"\nexit ${status}\n`;
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cfo-clipboard-"));
    bin = join(dir, "bin");
    mkdirSync(bin);
    out = join(dir, "clipboard");
    saved = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the tool on PATH and gives it the password on stdin only", () => {
    tool("wl-copy");
    const env = { PATH: `${bin}:/usr/bin:/bin`, WAYLAND_DISPLAY: "wayland-test" };
    expect(onPath("wl-copy", env)).toBe(true);
    expect(onPath("wl-copy", { PATH: "/nonexistent" })).toBe(false);
    expect(onPath("wl-copy", {})).toBe(false);
    const found = clipboardTool(env, "linux");
    expect(found).toEqual({ command: "wl-copy", args: [] });
    process.env.PATH = env.PATH;
    const password = generatePassword(bytes);
    expect(copyToClipboard(found as ClipboardTool, password)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe(password);
    expect(readFileSync(`${out}.args`, "utf8")).toBe("");
  });

  it("passes xclip its selection, and reports a tool that fails or is missing", () => {
    tool("xclip");
    tool("broken", 1);
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(copyToClipboard({ command: "xclip", args: ["-selection", "clipboard"] }, "x")).toBe(
      true,
    );
    expect(readFileSync(`${out}.args`, "utf8")).toBe("-selection clipboard");
    expect(copyToClipboard({ command: "broken", args: [] }, "x")).toBe(false);
    expect(copyToClipboard({ command: "cfo-no-such-tool", args: [] }, "x")).toBe(false);
    expect(existsSync(join(dir, "anything-else"))).toBe(false);
  });
});

describe("ownerPassword", () => {
  interface Fake extends PasswordIo {
    readonly said: string[];
    readonly copied: string[];
    readonly asked: string[];
    confirmed: number;
  }

  function io(overrides: Partial<PasswordIo> = {}, answers: string[] = []): Fake {
    const f: Fake = {
      isTTY: true,
      said: [],
      copied: [],
      asked: [],
      confirmed: 0,
      prompt: async (q) => {
        f.asked.push(q);
        return answers.shift() ?? "";
      },
      confirm: async () => {
        f.confirmed++;
      },
      say: (line) => f.said.push(line),
      clipboard: { command: "wl-copy", args: [] },
      copy: (_tool, text) => {
        f.copied.push(text);
        return true;
      },
      random: bytes,
      ...overrides,
    };
    return f;
  }
  const options = {
    choose: false,
    hostname: "omnigent.example.test",
    username: "owner",
    replaces: false,
  };

  it("generates one onto the clipboard, says where it is without showing it, and waits for Enter", async () => {
    const f = io();
    const password = await ownerPassword(f, options);
    expect(password).toBe(generatePassword(bytes));
    expect(f.copied).toEqual([password]);
    expect(f.confirmed).toBe(1);
    expect(f.asked).toEqual([]);
    expect(f.said).toEqual([
      "The owner's Omnigent password is on your clipboard (it is not shown). Store it in your password manager now: the owner signs in to Omnigent at https://omnigent.example.test as owner with it.",
    ]);
    expect(f.said.join("\n")).not.toContain(password);
  });

  it("says when it replaces a password an unfinished run gave", async () => {
    const f = io();
    await ownerPassword(f, { ...options, replaces: true });
    expect(f.said[0]).toContain(
      "it replaces the one an earlier, unfinished run gave you, which never reached the installation",
    );
  });

  it.each([
    ["no clipboard tool", { clipboard: undefined }, false],
    ["a clipboard tool that fails", { copy: () => false }, false],
    ["--password-prompt", {}, true],
  ])("asks the person to choose with %s", async (_name, overrides, choose) => {
    const f = io(overrides, ["cfo-canary-owner-password-0001", "cfo-canary-owner-password-0001"]);
    expect(await ownerPassword(f, { ...options, choose })).toBe("cfo-canary-owner-password-0001");
    expect(f.asked).toEqual(["The owner's Omnigent password (not shown): ", "Again: "]);
    expect(f.confirmed).toBe(0);
    expect(f.said.join("\n")).not.toContain("cfo-canary-owner-password-0001");
  });

  it("refuses outside a terminal, a weak password and two that differ", async () => {
    await expect(ownerPassword(io({ isTTY: false }), options)).rejects.toThrow(
      "the owner's password is needed: run in a terminal, or use --secrets-stdin",
    );
    await expect(ownerPassword(io({ clipboard: undefined }, ["short"]), options)).rejects.toThrow(
      /at least 8 characters/,
    );
    await expect(
      ownerPassword(
        io({ clipboard: undefined }, ["cfo-canary-a-long-one", "cfo-canary-b-long-one"]),
        options,
      ),
    ).rejects.toThrow("the passwords differ");
  });
});
