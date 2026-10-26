import type { z } from "zod";
import { AccessAssertionClaims } from "./access.ts";
import { BootstrapStatus } from "./bootstrap.ts";
import { CheckpointPolicy } from "./checkpoint-policy.ts";
import {
  InterceptProps,
  SupervisorMessage,
  SupervisorReply,
  WorkspaceCommand,
  WorkspaceCommandReply,
} from "./computer-protocol.ts";
import {
  ControlCall,
  ControlResult,
  PagesCall,
  PagesResult,
  ReservationState,
} from "./controllers.ts";
import { DurabilityUnconfirmed, DurabilityUnconfirmedAuth } from "./durability.ts";
import { ErrorBody } from "./errors.ts";
import { LauncherRequest, LauncherResult } from "./launcher.ts";
import {
  CredentialBundle,
  CredentialManifest,
  LayerIndex,
  WorkspaceManifest,
} from "./manifests.ts";
import { OutageRecord } from "./outage.ts";
import { PageFrontCall, PageFrontResult, TerminalUpgrade } from "./pages.ts";
import { ReplicationHealth, ReplicationPosition } from "./replication.ts";

export * from "./access.ts";
export * from "./bootstrap.ts";
export * from "./checkpoint-policy.ts";
export * from "./computer-protocol.ts";
export * from "./controllers.ts";
export * from "./durability.ts";
export * from "./errors.ts";
export * from "./ids.ts";
export * from "./launcher.ts";
export * from "./lifecycle.ts";
export * from "./manifests.ts";
export * from "./outage.ts";
export * from "./pages.ts";
export * from "./replication.ts";
export * from "./setup-cards.ts";

/**
 * Every wire schema, by name. The JSON Schema export, the golden fixtures and the Python contract
 * tests are all driven from this registry. M3's contracts (3.C): the launcher API, the computer
 * API, the intercept props, the checkpoint formats and policy, and the controllers' RPC payloads.
 */
export const wireSchemas = {
  AccessAssertionClaims,
  BootstrapStatus,
  CheckpointPolicy,
  ControlCall,
  ControlResult,
  CredentialBundle,
  CredentialManifest,
  DurabilityUnconfirmed,
  DurabilityUnconfirmedAuth,
  ErrorBody,
  InterceptProps,
  LauncherRequest,
  LauncherResult,
  LayerIndex,
  OutageRecord,
  PagesCall,
  PagesResult,
  PageFrontCall,
  PageFrontResult,
  ReplicationHealth,
  ReplicationPosition,
  ReservationState,
  SupervisorMessage,
  SupervisorReply,
  TerminalUpgrade,
  WorkspaceCommand,
  WorkspaceCommandReply,
  WorkspaceManifest,
} as const satisfies Record<string, z.ZodType>;

export type WireSchemaName = keyof typeof wireSchemas;
