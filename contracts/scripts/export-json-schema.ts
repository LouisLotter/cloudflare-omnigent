// Writes contracts/schema/<Name>.schema.json for every wire schema.
// CI re-runs this and fails if the committed files differ.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { wireSchemas } from "../src/index.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
mkdirSync(outDir, { recursive: true });
for (const file of readdirSync(outDir)) {
  if (file.endsWith(".schema.json")) rmSync(join(outDir, file));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

for (const [name, schema] of Object.entries(wireSchemas)) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12" });
  const document = sortKeys({ ...json, title: name });
  writeFileSync(join(outDir, `${name}.schema.json`), `${JSON.stringify(document, null, 2)}\n`);
}
console.log(`exported ${Object.keys(wireSchemas).length} schemas to ${outDir}`);
