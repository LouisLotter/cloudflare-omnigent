import { describe, expect, it } from "vitest";
import {
  MCP_REVISION_ENV,
  mcpAdminServicesOf,
  mcpRegistryOf,
  mcpRevisionOf,
} from "../../src/server/mcp-services.ts";

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

  it("reads the page's MCP servers the entrypoint counted (WP8.14), or null when it does not say", () => {
    expect(mcpAdminServicesOf({ mcpAdminServices: { stored: 2, served: 2 } })).toEqual({
      stored: 2,
      served: 2,
    });
    // Either count may be "cannot say" (null): the database unreadable, the app not reported.
    expect(mcpAdminServicesOf({ mcpAdminServices: { stored: 3, served: null } })).toEqual({
      stored: 3,
      served: null,
    });
    expect(mcpAdminServicesOf({ mcpAdminServices: { stored: null, served: 0 } })).toEqual({
      stored: null,
      served: 0,
    });
    for (const status of [
      null,
      undefined,
      7,
      [],
      {},
      { mcpAdminServices: null },
      { mcpAdminServices: [] },
      { mcpAdminServices: { stored: 1 } },
      { mcpAdminServices: { served: 1 } },
      { mcpAdminServices: { stored: -1, served: 0 } },
      { mcpAdminServices: { stored: 1.5, served: 0 } },
      { mcpAdminServices: { stored: "1", served: 1 } },
      { mcpAdminServices: { stored: 1, served: true } },
      { mcpAdminServices: { stored: 1_000_001, served: 0 } },
    ]) {
      expect(mcpAdminServicesOf(status)).toBeNull();
    }
    // Extra members are ignored, and never repeated: only the two counts come back.
    expect(
      mcpAdminServicesOf({ mcpAdminServices: { stored: 1, served: 1, names: ["linear"] } }),
    ).toEqual({ stored: 1, served: 1 });
  });
});
