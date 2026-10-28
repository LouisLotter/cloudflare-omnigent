// The pages' backend over the bindings (WP3.5, `pages/backend.ts`): the narrow calls, and what a
// failure turns into.
import { describe, expect, it } from "vitest";
import { bindingsBackend, type PagesBindings } from "../../src/pages/backend.ts";
import { platformError } from "../../src/shared/errors.ts";
import { PAGE_CMP, pageState } from "../support/page-states.ts";

const OWNER = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };

function bindings(over: {
  control?: (call: unknown) => unknown;
  pages?: (call: unknown) => unknown;
  fetch?: (request: Request) => unknown;
  outages?: () => unknown;
  replication?: () => unknown;
}) {
  const names: string[] = [];
  const env: PagesBindings = {
    WORKSPACE: {
      getByName: (name) => {
        names.push(name);
        return {
          pages: async (c: unknown) => over.pages?.(c),
          fetch: async (r: Request) => over.fetch?.(r),
        };
      },
    },
    CONTROL: { getByName: () => ({ control: async (c: unknown) => over.control?.(c) }) },
    OMNIGENT: {
      getByName: () => ({
        outages: async () => over.outages?.(),
        replication: async () => over.replication?.(),
      }),
    },
  };
  return { backend: bindingsBackend(env), names };
}

describe("bindingsBackend", () => {
  it("lists ControlDO's computers, and nothing for another answer", async () => {
    const computers = [{ computerId: PAGE_CMP, name: "managed-1" }];
    const seen: unknown[] = [];
    const { backend } = bindings({
      control: (c) => {
        seen.push(c);
        return { method: "list_computers", computers };
      },
    });
    expect(await backend.computers()).toEqual(computers);
    expect(seen).toEqual([{ method: "list_computers", interfaceVersion: 1 }]);
    expect(await bindings({ control: () => ({ method: "limits" }) }).backend.computers()).toEqual(
      [],
    );
  });

  it("reads a computer's state with the owner, by its object name", async () => {
    const seen: unknown[] = [];
    const result = { action: "state", computer: pageState(), intentToken: "c3".repeat(32) };
    const { backend, names } = bindings({
      pages: (c) => {
        seen.push(c);
        return result;
      },
    });
    expect(await backend.state(PAGE_CMP, OWNER)).toEqual(result);
    expect(names).toEqual([PAGE_CMP]);
    expect(seen).toEqual([{ action: "state", interfaceVersion: 1, owner: OWNER }]);
    expect(
      await bindings({ pages: () => ({ action: "set_size" }) }).backend.state(PAGE_CMP, OWNER),
    ).toBeNull();
  });

  it("answers null for a computer that does not exist, and passes other failures on", async () => {
    const missing = bindings({ pages: () => Promise.reject(platformError("not_found", "x")) });
    expect(await missing.backend.state(PAGE_CMP, OWNER)).toBeNull();
    const down = bindings({ pages: () => Promise.reject(platformError("unavailable", "x")) });
    await expect(down.backend.state(PAGE_CMP, OWNER)).rejects.toThrow("[unavailable]");
  });

  it("passes actions and the terminal's upgrade to the computer's object", async () => {
    const request = new Request("https://workspace.internal/x");
    const { backend } = bindings({ pages: (c) => c, fetch: () => new Response("bridged") });
    const call = { action: "restart", interfaceVersion: 1 } as never;
    expect(await backend.act(PAGE_CMP, call)).toBe(call);
    expect(await (await backend.upgrade(PAGE_CMP, request)).text()).toBe("bridged");
  });

  it("passes the page GETs' reads (WP3.23) to the computer's object", async () => {
    const { backend, names } = bindings({ pages: (c) => c });
    const call = { action: "computer_status", interfaceVersion: 1, owner: OWNER } as const;
    expect(await backend.read(PAGE_CMP, call)).toBe(call);
    expect(names).toEqual([PAGE_CMP]);
  });

  it("reads outages and replication, null when they cannot be read", async () => {
    const ok = bindings({ outages: () => [], replication: () => ({ state: "replicating" }) });
    expect(
      await ok.backend.outages("2026-10-15T00:00:00.000Z", "2026-10-22T00:00:00.000Z"),
    ).toEqual([]);
    expect(await ok.backend.replication()).toEqual({ state: "replicating" });
    const down = bindings({
      outages: () => Promise.reject(new Error("down")),
      replication: () => Promise.reject(new Error("down")),
    });
    expect(await down.backend.outages("a", "b")).toBeNull();
    expect(await down.backend.replication()).toBeNull();
  });
});
