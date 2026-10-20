import type { z } from "zod";
import { AccessAssertionClaims } from "./access.ts";
import { BootstrapStatus } from "./bootstrap.ts";
import { SupervisorHello } from "./computer-protocol.ts";
import { DurabilityUnconfirmed, DurabilityUnconfirmedAuth } from "./durability.ts";
import { ErrorBody } from "./errors.ts";
import { OutageRecord } from "./outage.ts";

export * from "./access.ts";
export * from "./bootstrap.ts";
export * from "./computer-protocol.ts";
export * from "./durability.ts";
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./outage.ts";

/**
 * Every wire schema, by name. The JSON Schema export, the golden fixtures and
 * the Python contract tests are all driven from this registry.
 */
export const wireSchemas = {
  AccessAssertionClaims,
  BootstrapStatus,
  DurabilityUnconfirmed,
  DurabilityUnconfirmedAuth,
  ErrorBody,
  OutageRecord,
  SupervisorHello,
} as const satisfies Record<string, z.ZodType>;

export type WireSchemaName = keyof typeof wireSchemas;
