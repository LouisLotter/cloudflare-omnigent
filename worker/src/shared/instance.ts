// Pure: a Durable Object instance's random identity (WP3.27). WorkspaceDO, OmnigentServer and
// ControlDO each log `instance_started` with a fresh one when an instance starts, so a reset, an
// eviction or a version switch shows in the logs as a new instance ID, and a line carries its
// Worker version. On 28 Oct WorkspaceDO's unplanned new instance could only be inferred from a
// repeated status line, and OmnigentServer's from its first alarm.

/** 8 random bytes as 16 lowercase hex characters: not a secret, and it names nothing. */
export function newInstanceId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
