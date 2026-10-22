// Spike S6 follow-up: tests of the staging Durable Object (../worker.js) for DC-37 (a start right
// after a stop is refused for a while) and DC-38 (a planned stop is never an unexpected one), as
// they hit Part 2 on 19 Oct: computer B's start was refused, and the Worker then recorded the
// credentials as lost, locking C, D and Wipe.
//
//   node --test spikes/s6/staging/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWorld, START_REFUSED_TEXT, until } from "./harness.mjs";

const stepLine = (r, re) => r.lines.find((l) => re.test(l.step ?? ""));

async function partTwoUpToB(world) {
  for (const q of ["name=start&fake=1", "name=fake-sign-in&fake=1", "name=after-sign-in&fake=1"]) {
    const r = await world.phase(q);
    assert.ok(r.done, `${q}: ${r.error}`);
  }
}

test("DC-37: with every start refused for 12 s after a stop, computers B, C and D complete and each start records its attempts", async () => {
  const world = await makeWorld();
  world.container.refuseWithinMs = 12_000;
  await partTwoUpToB(world);
  for (const [q, letter] of [
    ["name=restore-b&fake=1", "B"],
    ["name=restore-c-sign-out&fake=1", "C"],
    ["name=restore-d&fake=1", "D"],
  ]) {
    const r = await world.phase(q);
    assert.ok(r.done, `${q}: ${r.error}`);
    const start = stepLine(r, new RegExp(`^start computer ${letter}$`));
    assert.ok(start?.ok, `start computer ${letter} succeeded`);
    assert.ok(start.attempts.length > 1, "the first attempt, right after the stop, was refused");
    assert.match(start.attempts[0].result, /refused/);
    assert.equal(start.attempts.at(-1).result, "started");
    assert.equal(start.within_design_retry_budget, true, "the design's minute was enough here");
    assert.ok(start.attempts[0].since_stop_ms !== null, "the time since the stop is measured");
  }
  const st = await world.state();
  assert.equal(st.credentials_may_be_lost, false, "a refused start lost nothing");
  assert.equal(world.active.size, 0, "C signed out of both synthetic logins");
  const wipe = await world.phase("name=wipe");
  assert.ok(wipe.done, `wipe: ${wipe.error}`);
});

test("DC-37 and DC-38: a start refused beyond every retry fails as 'could not start', records nothing as lost, and the same button works again", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  world.container.refuseStarts = Number.POSITIVE_INFINITY;
  const b = await world.phase("name=restore-b&fake=1");
  assert.ok(!b.done, "B cannot complete without a computer");
  const start = stepLine(b, /^start computer B$/);
  assert.equal(start.ok, false);
  assert.equal(start.started, false);
  assert.equal(start.attempts.length, 7, "the design's four retries and the spike's two more");
  assert.ok(start.attempts.every((a) => /refused/.test(a.result)));
  assert.match(start.advice, /Nothing was lost/);
  let st = await world.state();
  assert.equal(
    st.credentials_may_be_lost,
    false,
    "19 Oct: this was recorded as an unexpected stop",
  );
  assert.equal(st.last_start_failure.attempts.length, 7);
  assert.equal(st.last_stop.reason, "before starting computer B");
  assert.ok(
    st.last_stop.final_credential_checkpoint >= 1,
    "the stop followed a published checkpoint",
  );

  world.container.refuseStarts = 0;
  for (const q of [
    "name=restore-b&fake=1",
    "name=restore-c-sign-out&fake=1",
    "name=restore-d&fake=1",
    "name=wipe",
  ]) {
    const r = await world.phase(q);
    assert.ok(r.done, `${q} after the refusals ended: ${r.error}`);
  }
  st = await world.state();
  assert.equal(world.active.size, 0);
  assert.equal(st.revocations_confirmed.length, 0, "no revocation had to be recorded");
});

test("DC-38 (review s6-fu-r1): a stop intent that was never confirmed proves nothing: a computer gone after it is recorded as lost", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  const gen = (await world.state()).generation;
  // The intent is persisted, the computer goes, and the confirmation never gets written.
  world.obj.meta(
    "stop_record",
    JSON.stringify({ generation: gen, reason: "test", intent_at: Date.now(), confirmed_at: null }),
  );
  world.container.stopNow("container stopped");
  const rec = await world.phase("name=recover&fake=1");
  assert.ok(!rec.done, "Recover must not claim a verified sign-out");
  const st = await world.state();
  assert.equal(st.credentials_may_be_lost, true);
  assert.match(st.credentials_lost.reason, /before it was confirmed/);
});

test("DC-38 (review s6-fu-r1, P1): destroy() fails, the computer keeps running and refreshes, then crashes: lost, Recover does not verify, Wipe refuses", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world); // both logins checkpointed after their refresh
  world.container.destroyThrows = true;
  const stop = await world.phase("name=stop&fake=1");
  assert.ok(!stop.done, "the stop failed");
  assert.equal(world.container.running, true);
  assert.equal((await world.state()).last_stop, null, "the failed stop's record was withdrawn");
  world.container.destroyThrows = false;
  // Both logins refresh in the still-running computer, and nothing checkpoints them.
  const home = world.container.home("/root");
  world.container.rotate(home, "claude");
  world.container.rotate(home, "codex");
  world.container.crash();
  const rec = await world.phase("name=recover&fake=1");
  assert.ok(!rec.done, "Recover must end unresolved");
  assert.ok(
    !rec.lines.some((l) => l.ok === true && /verified signed out/.test(l.step ?? "")),
    "no verified sign-out is claimed",
  );
  assert.equal(world.active.size, 2, "the refreshed logins are still active at the provider");
  assert.ok(
    !(await world.phase("name=wipe")).done,
    "Wipe refuses until the revocation is recorded",
  );
});

test("DC-38 (review s6-fu-r2, P1): destroy() pending, the computer refreshes and crashes, then destroy() rejects: a possible loss, never a confirmed stop", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  world.container.holdDestroy = true;
  const stopping = world.phase("name=stop&fake=1");
  assert.ok(await until(() => world.container.heldDestroy !== null), "destroy() is pending");
  const home = world.container.home("/root");
  world.container.rotate(home, "claude");
  world.container.rotate(home, "codex");
  world.container.crash();
  world.container.heldDestroy.reject(new Error("destroy failed (test)"));
  world.container.holdDestroy = false;
  const stop = await stopping;
  assert.ok(!stop.done, "Stop must not report success");
  let st = await world.state();
  assert.equal(st.last_stop, null, "no confirmed stop is recorded");
  assert.equal(st.credentials_may_be_lost, true);
  assert.match(st.credentials_lost.reason, /stop failed/);
  const rec = await world.phase("name=recover&fake=1");
  assert.ok(!rec.done, "Recover ends unresolved");
  assert.ok(!rec.lines.some((l) => l.ok === true && /verified signed out/.test(l.step ?? "")));
  assert.ok(
    !(await world.phase("name=wipe")).done,
    "Wipe refuses until the revocation is recorded",
  );
  assert.equal(world.active.size, 2, "the refreshed logins are still active at the provider");
  st = await world.state();
  assert.equal(st.credentials_may_be_lost, true);
});

test("DC-38 (review s6-fu-r1): an intent left by an interrupted stop is withdrawn as soon as the computer is seen running", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  const gen = (await world.state()).generation;
  world.obj.meta(
    "stop_record",
    JSON.stringify({ generation: gen, reason: "test", intent_at: Date.now(), confirmed_at: null }),
  );
  const close = await world.phase("name=close-terminal");
  assert.ok(close.done);
  assert.equal((await world.state()).last_stop, null, "withdrawn: the computer did not stop");
  world.container.crash();
  await world.phase("name=recover&fake=1");
  assert.equal((await world.state()).credentials_may_be_lost, true);
});

test("DC-37 (review s6-fu-r1): a refusal that arrives after start() returns, through monitor(), is retried", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  world.container.refuseLateStarts = 2;
  const b = await world.phase("name=restore-b&fake=1");
  assert.ok(b.done, `restore-b: ${b.error}`);
  const start = stepLine(b, /^start computer B$/);
  assert.deepEqual(
    start.attempts.map((a) => a.result),
    ["refused: no container instance", "refused: no container instance", "started"],
  );
  assert.equal((await world.state()).credentials_may_be_lost, false);
});

test("DC-37 (review s6-fu-r1): another error that says 'try again later' is not retried, and loses nothing", async () => {
  const world = await makeWorld();
  world.container.startErrors = ["Internal error, try again later"];
  const a = await world.phase("name=start&fake=1");
  assert.ok(!a.done);
  const start = stepLine(a, /^start computer A$/);
  assert.equal(start.attempts.length, 1);
  assert.match(start.attempts[0].result, /^error: Internal error/);
  assert.equal(start.started, false);
  assert.equal((await world.state()).credentials_may_be_lost, false);
  const again = await world.phase("name=start&fake=1");
  assert.ok(again.done, `start again: ${again.error}`);
});

test("review s6-fu-r1 (P2): Recover's sign-out fails in a running computer: Stop, the owner's revocation covers the signed-in checkpoint, Wipe works", async () => {
  const world = await makeWorld({ injection: true });
  await partTwoUpToB(world);
  const rec = await world.phase("name=recover&fake=1&fail=logout");
  assert.ok(!rec.done, "Recover fails when the logouts fail");
  assert.equal(world.container.running, true, "the computer that holds the login keeps running");
  const early = await world.phase("name=confirm-revoked&confirm=revoked-at-providers");
  assert.match(early.error, /stop the computer first/);
  const stop = await world.phase("name=stop&fake=1");
  assert.ok(stop.done, `stop: ${stop.error}`);
  const wipe1 = await world.phase("name=wipe");
  assert.match(wipe1.error, /still signed in/, "Wipe refuses a signed-in checkpoint");
  const conf = await world.phase("name=confirm-revoked&confirm=revoked-at-providers");
  assert.ok(conf.done, `confirm-revoked: ${conf.error}`);
  assert.match(conf.lines.find((l) => l.recorded).recorded.cleared, /still holds a login/);
  const wipe2 = await world.phase("name=wipe");
  assert.ok(wipe2.done, `wipe after the recorded revocation: ${wipe2.error}`);
  const st = await world.state();
  assert.equal(st.objects, 0);
  assert.equal(st.revocations_confirmed.length, 1, "the record survives the wipe");
});

test("review s6-fu-r1 (P2): Force stop after a checkpoint: the revocation clears the loss and covers the signed-in checkpoint", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  const fs = await world.phase("name=force-stop&fake=1&confirm=credentials-may-be-lost");
  assert.ok(fs.done);
  assert.ok(!(await world.phase("name=wipe")).done);
  const conf = await world.phase("name=confirm-revoked&confirm=revoked-at-providers");
  assert.ok(conf.done, `confirm-revoked: ${conf.error}`);
  const cleared = conf.lines.find((l) => l.recorded).recorded.cleared;
  assert.match(cleared, /force stop/);
  assert.match(cleared, /still holds a login/);
  assert.ok((await world.phase("name=wipe")).done);
});

test("control: with nothing at risk, a revocation statement is refused", async () => {
  const world = await makeWorld();
  const conf = await world.phase("name=confirm-revoked&confirm=revoked-at-providers");
  assert.match(conf.error, /nothing to record/);
});

test("DC-38 control: a stop that did not happen withdraws its record, so a later crash is still unexpected", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  world.container.ignoreDestroy = true;
  const stop = await world.phase("name=stop&fake=1");
  assert.ok(!stop.done, "the computer did not stop");
  assert.equal((await world.state()).last_stop, null, "the stop record was withdrawn");
  world.container.ignoreDestroy = false;
  world.container.crash();
  const rec = await world.phase("name=recover&fake=1");
  assert.ok(!rec.done);
  const st = await world.state();
  assert.equal(st.credentials_may_be_lost, true);
  assert.match(st.credentials_lost.reason, /unexpectedly/);
});

test("DC-38 control: a stop record of an earlier generation does not cover a crash of the current one", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  const b = await world.phase("name=restore-b&fake=1"); // stops A (recorded), starts B
  assert.ok(b.done, `restore-b: ${b.error}`);
  world.container.crash();
  const st = await world.state();
  assert.equal(st.credentials_may_be_lost, true, "B's crash is unexpected");
});

test("fault injection: refuse-start:2 is a dry-run knob, off unless injection is on", async () => {
  const off = await makeWorld();
  const refused = await off.phase("name=start&fake=1&fail=refuse-start:2");
  assert.equal(refused.status, 403);
  assert.equal(off.container.running, false);

  const on = await makeWorld({ injection: true });
  const r = await on.phase("name=start&fake=1&fail=refuse-start:2");
  assert.ok(r.done, `start: ${r.error}`);
  const start = stepLine(r, /^start computer A$/);
  assert.deepEqual(
    start.attempts.map((a) => a.result),
    ["refused: no container instance", "refused: no container instance", "started"],
  );
  assert.ok(START_REFUSED_TEXT.length > 0);
});

test("the Part 2 steps run the resume and key-report actions in A, B and C", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  const b = await world.phase("name=restore-b&fake=1");
  assert.ok(b.done, `restore-b: ${b.error}`);
  const c = await world.phase("name=restore-c-sign-out&fake=1");
  assert.ok(c.done, `restore-c: ${c.error}`);
  const execs = world.events.filter((e) => e.type === "exec").map((e) => e.detail);
  for (const action of [
    "claude-remember",
    "codex-remember",
    "claude-resume",
    "codex-resume",
    "login-values A after sign-in",
    "login-values A at W1",
    "login-values A after refresh",
    "login-values B after resume",
    "login-values C before sign-out",
  ]) {
    assert.ok(
      execs.some((e) => e.endsWith(`inner.sh ${action}`)),
      `inner.sh ${action} ran`,
    );
  }
  const order = (a) => execs.findIndex((e) => e.endsWith(`inner.sh ${a}`));
  assert.ok(order("codex-remember") < order("login-values A at W1"));
  const w1 = execs.findIndex((e) => /cli\.py export --kind workspace/.test(e));
  assert.ok(order("login-values A at W1") < w1, "the A-at-W1 report runs before W1 is taken");
});
