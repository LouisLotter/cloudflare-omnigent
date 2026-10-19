import type { z } from "zod";
import { SupervisorHello } from "./computer-protocol.ts";
import { ErrorBody } from "./errors.ts";

export * from "./computer-protocol.ts";
export * from "./errors.ts";
export * from "./ids.ts";

/**
 * Every wire schema, by name. The JSON Schema export, the golden fixtures and
 * the Python contract tests are all driven from this registry.
 */
export const wireSchemas = {
  ErrorBody,
  SupervisorHello,
} as const satisfies Record<string, z.ZodType>;

export type WireSchemaName = keyof typeof wireSchemas;
