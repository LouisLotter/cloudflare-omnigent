// OmnigentServer's report of a team's move behind Access (WP8.11), in workerd with real storage,
// alarms and eviction, and a fake server container: while the version holds `CFO_TEAM_MOVE`, every
// status line carries the move, the server's identity mode, the team's binding state from the
// signed team-status call and the admission revision applied; the installer's reading of it
// (events.ts, team-move.ts) decides from those lines; without a move, no line carries them.
import { evictAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ReplicationPosition,
  TEAM_STATUS_CALL_PATH,
  type TeamStatusReport,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newest, parseLogs } from "../../../scripts/bootstrap/events.ts";
import { checkMove } from "../../../scripts/bootstrap/team-move.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION } from "../../src/shared/rpc.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
const MOVE = "tm-20261103T150000Z-0a1b2c3d";
const PC = "a".repeat(32);
const COOKIE_SECRET = "c".repeat(64);
const DURABLE = { accounts_enabled: true, needs_setup: false, enabled_connections: [] };
const REPORT: TeamStatusReport = {
  owners: 1,
  ownersBound: 1,
  revision: 0,
  hosts: [{ hostId: PC, launchToken: false, installationOwner: true, identity: "owner" }],
};

let serial = 0;
type Stub = DurableObjectStub<OmnigentServer>;
let logs: string[] = [];

beforeEach(() => {
  testServers.clock.reset();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
});

const statusLines = () =>
  logs
    .map((line) => JSON.parse(line) as { cfo: string; event: string } & Record<string, unknown>)
    .filter((e) => e.cfo === "bootstrap" && e.event === "status");

const position = (txid: number): ReplicationPosition => ({
  protocolVersion: 1,
  bootId: "c".repeat(32),
  txid,
  replicatedTxid: txid,
});

async function nextCheck(stub: Stub): Promise<void> {
  const at = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  testServers.clock.advance(Math.max(0, (at as number) - testServers.clock.now()));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

async function runningServer(vars: Record<string, string>) {
  const stub = env.OMNIGENT.getByName(`team-move-${++serial}`) as Stub;
  testServers.release(stub.id, {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
    ...vars,
  });
  const fake = testServers.create(stub.id);
  fake.info = DURABLE;
  fake.position = position(5);
  const asked: Request[] = [];
  fake.handler = (_port: number, request: Request) => {
    if (new URL(request.url).pathname !== TEAM_STATUS_CALL_PATH)
      return new Response(null, { status: 404 });
    asked.push(request);
    return Response.json(REPORT);
  };
  await stub.bootstrapStatus(call);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await nextCheck(stub);
  return { stub, fake: fake as FakeServerContainer, asked };
}

describe("OmnigentServer: the team move on the status line (WP8.11)", () => {
  it("reports the move, the mode and the team, signed, on every check while the move is held", async () => {
    const { stub, asked } = await runningServer({
      CFO_TEAM_MOVE: MOVE,
      SERVER_ENV_OMNIGENT_EXTERNAL_IDENTITY_MODE: "bind",
    });
    await nextCheck(stub);
    await nextCheck(stub);
    const lines = statusLines().filter((l) => "teamMove" in l);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.at(-1)).toMatchObject({
      teamMove: MOVE,
      identityMode: "bind",
      team: REPORT,
      admissionApplied: null,
    });
    // Each read is a signed platform call, never named after a person.
    expect(asked.at(-1)?.headers.get("x-cfo-call-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(lines)).not.toMatch(/@/);
    // The installer reads those lines, and decides from them.
    const read = parseLogs(
      statusLines().map((source, i) => ({
        timestamp: 1_000 + i,
        $workers: {
          scriptName: "cloudflare-omnigent",
          scriptVersion: { id: "v2" },
          eventType: "alarm",
          entrypoint: "OmnigentServer",
        },
        source,
      })),
      "cloudflare-omnigent",
    );
    const line = newest(read.statuses.filter((s) => s.teamMove !== undefined))?.teamMove;
    expect(
      checkMove(line, { moveId: MOVE, mode: "bind", hostId: PC, hostname: "h.example.test" }),
    ).toEqual({ kind: "ready", computers: 0 });
  });

  it("carries no team fields without a move", async () => {
    const { stub } = await runningServer({});
    await nextCheck(stub);
    expect(statusLines().some((l) => "teamMove" in l)).toBe(false);
  });
});
