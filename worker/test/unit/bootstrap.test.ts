import { BootstrapStatus, type ReplicationPosition } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type BootstrapTarget, checkBootstrap } from "../../src/server/bootstrap.ts";

const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const BOOT_A = "a".repeat(32);
const BOOT_B = "b".repeat(32);
const NOW = Date.parse("2026-10-22T09:15:00.000Z");
const OWNER = { accounts_enabled: true, needs_setup: false, server_version: "x" };

const pos = (bootId: string, txid: number, replicatedTxid: number): ReplicationPosition => ({
  protocolVersion: 1,
  bootId,
  txid,
  replicatedTxid,
});

describe("checkBootstrap", () => {
  it("reports the owner initialized only once a replicated position covers the target", () => {
    // Replication held back while /v1/info already shows the owner: not initialized.
    const held = checkBootstrap(
      INSTALLATION,
      null,
      { before: pos(BOOT_A, 40, 30), info: OWNER, after: pos(BOOT_A, 41, 30) },
      NOW,
    );
    expect(held).toMatchObject({
      reason: "not_replicated",
      target: { bootId: BOOT_A, txid: 41 },
      status: { initialized: false, installationId: INSTALLATION },
    });
    // One short of the target is not enough.
    const short = checkBootstrap(
      INSTALLATION,
      held.target,
      { before: pos(BOOT_A, 60, 40), info: OWNER, after: pos(BOOT_A, 61, 40) },
      NOW + 30_000,
    );
    expect(short).toMatchObject({ reason: "not_replicated", status: { initialized: false } });
    // Later writes move txid on, but the target stays: the replica catching up to it suffices.
    const caughtUp = checkBootstrap(
      INSTALLATION,
      held.target,
      { before: pos(BOOT_A, 90, 41), info: OWNER, after: pos(BOOT_A, 95, 41) },
      NOW + 60_000,
    );
    expect(caughtUp).toMatchObject({ reason: "durable", status: { initialized: true } });
    expect(caughtUp.target).toEqual({ bootId: BOOT_A, txid: 41 });
    expect(BootstrapStatus.safeParse(caughtUp.status).success).toBe(true);
    expect(caughtUp.status?.checkedAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("does not accept needs_setup false alone (header and OIDC modes)", () => {
    for (const info of [
      { accounts_enabled: false, needs_setup: false },
      { accounts_enabled: true, needs_setup: true },
    ]) {
      const check = checkBootstrap(
        INSTALLATION,
        { bootId: BOOT_A, txid: 1 },
        { before: pos(BOOT_A, 5, 5), info, after: pos(BOOT_A, 5, 5) },
        NOW,
      );
      expect(check).toMatchObject({ reason: "not_initialized", target: null });
      expect(check.status?.initialized).toBe(false);
    }
  });

  it("starts over when the server's boot changes, between the reads or since the target", () => {
    const between = checkBootstrap(
      INSTALLATION,
      null,
      { before: pos(BOOT_A, 9, 9), info: OWNER, after: pos(BOOT_B, 3, 3) },
      NOW,
    );
    expect(between).toMatchObject({ reason: "boot_changed", target: null });
    expect(between.status?.initialized).toBe(false);

    // A target from boot A means nothing to boot B: B's own position after the info read counts.
    const old: BootstrapTarget = { bootId: BOOT_A, txid: 2 };
    const replaced = checkBootstrap(
      INSTALLATION,
      old,
      { before: pos(BOOT_B, 7, 5), info: OWNER, after: pos(BOOT_B, 7, 5) },
      NOW,
    );
    expect(replaced).toMatchObject({
      reason: "not_replicated",
      target: { bootId: BOOT_B, txid: 7 },
    });
  });

  it("keeps the target but reports not initialized while a read fails", () => {
    const target: BootstrapTarget = { bootId: BOOT_A, txid: 10 };
    const noInfo = checkBootstrap(
      INSTALLATION,
      target,
      { before: null, info: null, after: null },
      NOW,
    );
    expect(noInfo).toMatchObject({ reason: "info_unavailable", target });
    const noPosition = checkBootstrap(
      INSTALLATION,
      target,
      { before: pos(BOOT_A, 10, 10), info: OWNER, after: "not json" },
      NOW,
    );
    expect(noPosition).toMatchObject({ reason: "position_unavailable", target });
    expect(noPosition.status?.initialized).toBe(false);
    const newer = checkBootstrap(
      INSTALLATION,
      target,
      {
        before: pos(BOOT_A, 10, 10),
        info: OWNER,
        after: { ...pos(BOOT_A, 10, 10), protocolVersion: 2 },
      },
      NOW,
    );
    expect(newer.reason).toBe("position_unavailable");
  });

  it("produces no status without a valid installation ID", () => {
    for (const id of [undefined, "", "ins_short", 42]) {
      const check = checkBootstrap(
        id,
        null,
        { before: pos(BOOT_A, 1, 1), info: OWNER, after: pos(BOOT_A, 1, 1) },
        NOW,
      );
      expect(check).toMatchObject({ status: null, reason: "no_installation" });
    }
  });

  it("never reports initialized unless the owner shows and one boot's replica covers the target", () => {
    const posArb = (boots: string[]) =>
      fc.record({
        protocolVersion: fc.constantFrom(1, 2),
        bootId: fc.constantFrom(...boots),
        txid: fc.nat(100),
        replicatedTxid: fc.nat(100),
      });
    const probeArb = fc.record({
      before: fc.oneof(posArb([BOOT_A, BOOT_B]), fc.constant(null)),
      info: fc.oneof(
        fc.record({ accounts_enabled: fc.boolean(), needs_setup: fc.boolean() }),
        fc.constant(null),
      ),
      after: fc.oneof(posArb([BOOT_A, BOOT_B]), fc.constant(null)),
    });
    const targetArb = fc.oneof(
      fc.constant(null),
      fc.record({ bootId: fc.constantFrom(BOOT_A, BOOT_B), txid: fc.nat(100) }),
    );
    fc.assert(
      fc.property(targetArb, probeArb, (previous, probe) => {
        const check = checkBootstrap(INSTALLATION, previous, probe, NOW);
        if (!check.status?.initialized) return true;
        const info = probe.info as { accounts_enabled: boolean; needs_setup: boolean };
        const before = probe.before as ReplicationPosition;
        const after = probe.after as ReplicationPosition;
        const target = check.target as BootstrapTarget;
        return (
          info.accounts_enabled &&
          !info.needs_setup &&
          before.protocolVersion === 1 &&
          after.protocolVersion === 1 &&
          before.bootId === after.bootId &&
          target.bootId === after.bootId &&
          // The target was read after the owner was seen: never above this check's own position.
          target.txid <= after.txid + (previous?.bootId === after.bootId ? 100 : 0) &&
          after.replicatedTxid >= target.txid
        );
      }),
      { numRuns: 2000 },
    );
  });
});
