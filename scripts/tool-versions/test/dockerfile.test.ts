// Reading and rewriting Dockerfile build arguments exactly (WP3.37): only an `ARG NAME=value`
// line's value changes, and nothing else in the file, on synthetic files and on the real ones.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { argDefault, argDefaults, argValue, setArgs } from "../dockerfile.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const real = (path: string) => readFileSync(join(ROOT, path), "utf8");

const SAMPLE = [
  "# syntax=docker/dockerfile:1.17",
  "ARG PLAIN=1.2.3",
  'ARG QUOTED="pkg==1.0 --hash=sha256:abc"',
  "ARG NO_DEFAULT",
  "FROM scratch",
  'RUN echo "ARG PLAIN=9.9.9"',
  "  ARG INDENTED=not-read",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile's own expansion
  "ARG EXPANDED=${PLAIN}",
  "",
].join("\n");

/** The indexes of the lines that differ between two texts with the same number of lines. */
function changedLines(a: string, b: string): number[] {
  const [x, y] = [a.split("\n"), b.split("\n")];
  expect(y.length).toBe(x.length);
  return x.flatMap((line, i) => (line === y[i] ? [] : [i]));
}

describe("argDefaults", () => {
  it("lists every ARG with a default, quoted or not, and nothing else", () => {
    expect(argDefaults(SAMPLE)).toEqual([
      { name: "PLAIN", value: "1.2.3", quoted: false, plain: true, line: 1 },
      { name: "QUOTED", value: "pkg==1.0 --hash=sha256:abc", quoted: true, plain: true, line: 2 },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile's own expansion
      { name: "EXPANDED", value: "${PLAIN}", quoted: false, plain: false, line: 7 },
    ]);
  });

  it("refuses CR line endings", () => {
    expect(() => argDefaults("ARG A=1\r\n")).toThrow(/CR line endings/);
  });

  it("reads exactly one default, and only a plain one", () => {
    expect(argValue(SAMPLE, "PLAIN")).toBe("1.2.3");
    expect(argDefault(SAMPLE, "QUOTED").quoted).toBe(true);
    expect(() => argValue(SAMPLE, "MISSING")).toThrow(/found 0/);
    expect(() => argValue(`${SAMPLE}ARG PLAIN=2\n`, "PLAIN")).toThrow(/found 2/);
    expect(() => argValue(SAMPLE, "NO_DEFAULT")).toThrow(/found 0/);
    expect(() => argValue(SAMPLE, "EXPANDED")).toThrow(/cannot read/);
  });
});

describe("setArgs", () => {
  it("changes only the value on each named argument's line", () => {
    const out = setArgs(SAMPLE, { PLAIN: "1.2.4", QUOTED: "pkg==1.1 --hash=sha256:def" });
    expect(changedLines(SAMPLE, out)).toEqual([1, 2]);
    expect(out.split("\n")[1]).toBe("ARG PLAIN=1.2.4");
    expect(out.split("\n")[2]).toBe('ARG QUOTED="pkg==1.1 --hash=sha256:def"');
    // The echo line that looks like an ARG, and the trailing newline, are untouched.
    expect(out).toContain('RUN echo "ARG PLAIN=9.9.9"');
    expect(out.endsWith("\n")).toBe(true);
  });

  it("makes no change when nothing, or the current values, are given", () => {
    expect(setArgs(SAMPLE, {})).toBe(SAMPLE);
    expect(setArgs(SAMPLE, { PLAIN: "1.2.3" })).toBe(SAMPLE);
  });

  it("keeps the line's quoting rules and refuses values that would break them", () => {
    expect(() => setArgs(SAMPLE, { PLAIN: "has space" })).toThrow(/cannot be written/);
    expect(() => setArgs(SAMPLE, { PLAIN: "x$y" })).toThrow(/cannot be written/);
    expect(() => setArgs(SAMPLE, { QUOTED: 'a"b' })).toThrow(/cannot be written/);
    expect(() => setArgs(SAMPLE, { QUOTED: "a\\b" })).toThrow(/cannot be written/);
    expect(() => setArgs(SAMPLE, { QUOTED: "a\nARG X=1" })).toThrow(/cannot be written/);
  });

  it("throws, returning nothing, if any name is missing or duplicated", () => {
    expect(() => setArgs(SAMPLE, { PLAIN: "2", MISSING: "1" })).toThrow(/found 0/);
    expect(() => setArgs(`${SAMPLE}ARG QUOTED="x"\n`, { PLAIN: "2", QUOTED: "y" })).toThrow(
      /found 2/,
    );
  });

  it("changes exactly the named lines of any Dockerfile (property)", () => {
    const name = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}$/);
    const value = fc.stringMatching(/^[a-z0-9.:@=-]{1,20}$/);
    const other = fc.stringMatching(/^(#|RUN|FROM|COPY) [ -~]{0,30}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(name, value), { selector: ([n]) => n, minLength: 1, maxLength: 6 }),
        fc.array(other, { maxLength: 6 }),
        fc.array(value, { minLength: 6, maxLength: 6 }),
        (args, others, next) => {
          const lines = [...others, ...args.map(([n, v]) => `ARG ${n}=${v}`), ...others];
          const text = `${lines.join("\n")}\n`;
          const updates = Object.fromEntries(args.map(([n], i) => [n, next[i] as string]));
          const out = setArgs(text, updates);
          const changed = changedLines(text, out);
          for (const i of changed) expect(lines[i]?.startsWith("ARG ")).toBe(true);
          for (const [n] of args) expect(argValue(out, n)).toBe(updates[n]);
          expect(setArgs(out, Object.fromEntries(args.map(([n]) => [n, argValue(out, n)])))).toBe(
            out,
          );
        },
      ),
    );
  });

  it("reads and rewrites the real Dockerfiles without changing anything else", () => {
    for (const path of ["images/computer/Dockerfile", "images/server/Dockerfile"]) {
      const text = real(path);
      const current = argValue(text, "PYTHON_IMAGE");
      expect(setArgs(text, { PYTHON_IMAGE: current })).toBe(text);
      const out = setArgs(text, { PYTHON_IMAGE: `python:3.12-slim@sha256:${"f".repeat(64)}` });
      expect(changedLines(text, out)).toEqual([argDefault(text, "PYTHON_IMAGE").line]);
    }
  });
});
