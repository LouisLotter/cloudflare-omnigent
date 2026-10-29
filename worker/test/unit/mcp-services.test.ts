import { describe, expect, it } from "vitest";
import { MCP_REVISION_ENV, mcpRegistryOf, mcpRevisionOf } from "../../src/server/mcp-services.ts";

describe("the MCP report's pure parts (WP5.10)", () => {
  it("reads the revision the installer writes, and nothing else", () => {
    expect(MCP_REVISION_ENV).toBe("SERVER_ENV_CFO_MCP_REVISION");
    const revision = "0a".repeat(16);
    expect(mcpRevisionOf({ [MCP_REVISION_ENV]: revision })).toBe(revision);
    expect(mcpRevisionOf({ [MCP_REVISION_ENV]: ` ${revision}\n` })).toBe(revision);
    expect(mcpRevisionOf({ [MCP_REVISION_ENV]: "0a".repeat(32) })).toBe("0a".repeat(32));
    for (const value of [
      undefined,
      7,
      "",
      "short",
      "A".repeat(32),
      "0a".repeat(33),
      "g".repeat(32),
    ]) {
      expect(mcpRevisionOf({ [MCP_REVISION_ENV]: value })).toBeNull();
    }
    expect(mcpRevisionOf({})).toBeNull();
  });

  it("reads whether Omnigent lists MCP, or null when its answer does not say", () => {
    expect(mcpRegistryOf({ enabled_connections: ["github", "mcp"] })).toBe(true);
    expect(mcpRegistryOf({ enabled_connections: ["github"] })).toBe(false);
    expect(mcpRegistryOf({ enabled_connections: [] })).toBe(false);
    for (const info of [null, undefined, 7, [], {}, { enabled_connections: "mcp" }]) {
      expect(mcpRegistryOf(info)).toBeNull();
    }
  });
});
