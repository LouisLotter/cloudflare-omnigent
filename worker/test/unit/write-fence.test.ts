import { describe, expect, it } from "vitest";
import {
  checkWrite,
  fencePrefix,
  WRITE_FENCE_INTERFACE_VERSION,
  type WriteCheck,
  withTimeout,
} from "../../src/egress/write-fence.ts";

const COMPUTER = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
const fence = (kind: "workspace" | "credential", generation = 3) => ({
  fenceVersion: 1,
  computerId: COMPUTER,
  generation,
  kind,
});
const LAYER = `workspace/${COMPUTER}/00000000-0000-4000-8000-0000000000aa.tar.zst`;
const BUNDLE = `credentials/${COMPUTER}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n3.json`;

describe("the write fence", () => {
  it("asks WorkspaceDO with the computer, generation, kind and key, and allows on its yes", async () => {
    const asked: WriteCheck[] = [];
    const verdict = await checkWrite(fence("workspace"), LAYER, async (check) => {
      asked.push(check);
      return { allowed: true };
    });
    expect(verdict).toEqual({ allowed: true });
    expect(asked).toEqual([
      {
        interfaceVersion: WRITE_FENCE_INTERFACE_VERSION,
        computerId: COMPUTER,
        generation: 3,
        kind: "workspace",
        objectKey: LAYER,
      },
    ]);
  });

  it.each(["removed", "stale_generation", "not_pending", "unknown_computer"] as const)(
    "refuses when WorkspaceDO says %s",
    async (reason) => {
      expect(
        await checkWrite(fence("credential"), BUNDLE, async () => ({ allowed: false, reason })),
      ).toEqual({
        allowed: false,
        reason,
      });
    },
  );

  it("refuses when WorkspaceDO cannot be reached, or answers nothing usable (fail closed)", async () => {
    expect(
      await checkWrite(fence("workspace"), LAYER, async () => {
        throw new Error("Network connection lost.");
      }),
    ).toEqual({ allowed: false, reason: "workspace_unreachable" });
    expect(await checkWrite(fence("workspace"), LAYER, async () => ({ allowed: false }))).toEqual({
      allowed: false,
      reason: "refused",
    });
    expect(
      await checkWrite(
        fence("workspace"),
        LAYER,
        async () => null as unknown as { allowed: boolean },
      ),
    ).toEqual({ allowed: false, reason: "refused" });
  });

  it("refuses without asking: no fence, a malformed fence, a key outside the computer's prefix", async () => {
    let asked = 0;
    const ask = async () => {
      asked += 1;
      return { allowed: true };
    };
    for (const [raw, key] of [
      [undefined, LAYER],
      [{ ...fence("workspace"), fenceVersion: 2 }, LAYER],
      [{ ...fence("workspace"), extra: 1 }, LAYER],
      [fence("workspace"), BUNDLE],
      [fence("credential"), LAYER],
      [fence("workspace"), `workspace/cmp_01hzy3m8k6q4t2v9w7x5r0s1n4/x.tar.zst`],
      [fence("workspace"), `workspace/${COMPUTER}/`],
      [fence("workspace"), `workspace/${COMPUTER}/a/b.tar.zst`],
      [fence("workspace"), `workspace/${COMPUTER}/..tar.zst`],
      [fence("workspace"), `workspace/${COMPUTER}/${"x".repeat(1100)}`],
    ] as const) {
      expect((await checkWrite(raw, key, ask)).allowed, `${JSON.stringify(raw)} ${key}`).toBe(
        false,
      );
    }
    expect(asked).toBe(0);
  });

  it("names each kind's prefix as the contracts do", () => {
    expect(fencePrefix(fence("workspace") as never)).toBe(`workspace/${COMPUTER}/`);
    expect(fencePrefix(fence("credential") as never)).toBe(`credentials/${COMPUTER}/`);
  });

  it("bounds a promise, and passes its result through", async () => {
    expect(await withTimeout(Promise.resolve(5), 1_000, "x")).toBe(5);
    await expect(withTimeout(new Promise(() => undefined), 10, "the put")).rejects.toThrow(
      /the put took longer than 10 ms/,
    );
  });
});
