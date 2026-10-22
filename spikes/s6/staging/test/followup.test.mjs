// Spike S6 follow-up: tests of the staging Durable Object (../worker.js) for DC-37 (a start right
// after a stop is refused for a while) and DC-38 (a planned stop is never an unexpected one), as
// they hit Part 2 on 19 Oct: computer B's start was refused, and the Worker then recorded the
// credentials as lost, locking C, D and Wipe.
//
//   node --test spikes/s6/staging/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWorld, START_REFUSED_TEXT } from "./harness.mjs";

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

test("DC-38: a stop recorded but not confirmed (the object was interrupted) is a planned stop", async () => {
  const world = await makeWorld();
  await partTwoUpToB(world);
  const gen = (await world.state()).generation;
  // The intent is persisted, the computer goes, and the confirmation never gets written.
  world.obj.meta(
    "stop_record",
    JSON.stringify({ generation: gen, reason: "test", intent_at: Date.now(), confirmed_at: null }),
  );
  world.container.stopNow("container stopped");
  const st = await world.state();
  assert.equal(st.credentials_may_be_lost, false);
  const b = await world.phase("name=restore-b&fake=1");
  assert.ok(b.done, `restore-b: ${b.error}`);
  assert.equal((await world.state()).credentials_may_be_lost, false);
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
