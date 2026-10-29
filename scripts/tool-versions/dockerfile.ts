// Dockerfile build arguments, read and rewritten exactly (WP3.37). Only the value of an
// `ARG NAME=value` line changes; every other byte of the file stays as it was.

/** One `ARG NAME=value` line: a build argument with a default. */
export interface ArgDefault {
  readonly name: string;
  readonly value: string;
  /** Whether the value is in double quotes; a rewrite keeps the quoting. */
  readonly quoted: boolean;
  /** False for a value this tool never reads or writes (an expansion, a quote, a backslash). */
  readonly plain: boolean;
  /** The line's index, from 0. */
  readonly line: number;
}

const ARG_LINE = /^ARG ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// A quoted value with no quote, backslash or expansion inside; an unquoted one with no space.
const QUOTED = /^"([^"\\$\n]*)"$/;
const UNQUOTED = /^[^\s"'\\$]+$/;

/** Every `ARG NAME=value` line of a Dockerfile. `ARG NAME` (no default) lines are not listed. */
export function argDefaults(text: string): ArgDefault[] {
  if (text.includes("\r")) throw new Error("Dockerfile has CR line endings; refusing to rewrite");
  const found: ArgDefault[] = [];
  text.split("\n").forEach((line, index) => {
    const m = ARG_LINE.exec(line);
    if (!m) return;
    const name = m[1] as string;
    const raw = m[2] as string;
    const quoted = QUOTED.exec(raw);
    if (quoted) {
      found.push({ name, value: quoted[1] as string, quoted: true, plain: true, line: index });
    } else {
      found.push({ name, value: raw, quoted: false, plain: UNQUOTED.test(raw), line: index });
    }
  });
  return found;
}

/** The one default of `name`; throws unless exactly one `ARG name=…` line exists. */
export function argDefault(text: string, name: string): ArgDefault {
  const matches = argDefaults(text).filter((a) => a.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one "ARG ${name}=" line, found ${matches.length}`);
  }
  const arg = matches[0] as ArgDefault;
  if (!arg.plain)
    throw new Error(`ARG ${name} on line ${arg.line + 1} has a value this tool cannot read`);
  return arg;
}

/** The default value of `name` (exactly one `ARG name=…` line). */
export function argValue(text: string, name: string): string {
  return argDefault(text, name).value;
}

/**
 * The Dockerfile with each named argument's default replaced, and nothing else changed. Every
 * name must have exactly one `ARG name=…` line; a value must keep its line's quoting rules.
 * Throws before changing anything if any of that fails.
 */
export function setArgs(text: string, values: Readonly<Record<string, string>>): string {
  const lines = text.split("\n");
  for (const [name, value] of Object.entries(values)) {
    const arg = argDefault(text, name);
    if (arg.quoted ? !QUOTED.test(`"${value}"`) : !UNQUOTED.test(value)) {
      throw new Error(`ARG ${name}: the new value cannot be written as the line's value`);
    }
    lines[arg.line] = `ARG ${name}=${arg.quoted ? `"${value}"` : value}`;
  }
  return lines.join("\n");
}
