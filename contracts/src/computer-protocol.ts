import { z } from "zod";
import { ComputerId, Generation, HostId } from "./ids.ts";

/** Protocol versions this contract package understands. Version 1 is the first. */
export const SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS = [1] as const;

/** First message a computer's supervisor sends to its WorkspaceDO after start. */
export const SupervisorHello = z.strictObject({
  type: z.literal("hello"),
  protocolVersion: z.number().int().min(1),
  computerId: ComputerId,
  generation: Generation,
  hostId: HostId,
  supervisorVersion: z.string().min(1).max(64),
});
export type SupervisorHello = z.infer<typeof SupervisorHello>;
