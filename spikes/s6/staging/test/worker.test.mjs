// Spike S6: tests of the staging Durable Object (../worker.js) in the in-memory harness, for the
// s6-r3 review findings: Force stop and lost credentials (1), the terminal's lifetime (4), the
// confirmation page's options (5), and X-S6-Intent reaching the computer (optional hardening).
//
//   node --test spikes/s6/staging/test/
import assert from "node:assert/strict";
import { test } from "node:test";
import { clickConfirmButton, makeWorld, ORIGIN, runtime, sleepReal, until } from "./harness.mjs";

const said = (r, re) => r.lines.some((l) => re.test(JSON.stringify(l)));

async function signedInComputer(world, startQuery = "name=start&fake=1") {
  const s = await world.phase(startQuery);
  assert.ok(s.done, `start: ${s.error}`);
  const f = await world.phase("name=fake-sign-in&fake=1");
  assert.ok(f.done, `fake-sign-in: ${f.error}`);
  assert.equal(world.active.size, 2, "two synthetic logins are active at the provider");
}

// ------------------------------------------------------------------ finding 1 (P1)
test("force stop with an unpublished login: Recover does not claim a verified sign-out, Wipe and Start refuse until revocation is recorded", async () => {
  const world = await makeWorld();
  await signedInComputer(world); // never checkpointed: the only copy is in the computer
  const fs = await world.phase("name=force-stop&fake=1&confirm=credentials-may-be-lost");
  assert.ok(fs.done, `force-stop: ${fs.error}`);
  assert.equal(world.container.running, false);

  const rec = await world.phase("name=recover&fake=1");
  assert.equal(world.active.size, 2, "the lost logins are still active at the provider");
  assert.ok(!rec.done, "Recover must not complete as if the sign-out were verified");
  assert.ok(
    !rec.lines.some((l) => l.ok === true && /verified signed out/.test(l.step ?? "")),
    "Recover reported a verified sign-out although the lost credentials were never signed out",
  );
  assert.ok(said(rec, /unresolved/i), "Recover says the credentials are unresolved");
  assert.ok(
    said(rec, /revoke/i) && said(rec, /Claude/) && said(rec, /ChatGPT/),
    "Recover tells the owner to revoke in the Claude and ChatGPT account settings",
  );
  assert.equal((await world.state()).credentials_may_be_lost, true);

  const wipe = await world.phase("name=wipe");
  assert.ok(!wipe.done, "Wipe must refuse while the lost credentials are unresolved");
  assert.equal((await world.state()).credentials_may_be_lost, true, "the warning survives");
  const start = await world.phase("name=start&fake=1");
  assert.ok(!start.done, "Start must refuse while the lost credentials are unresolved");
  assert.equal(world.container.running, false);

  const noConfirm = await world.phase("name=confirm-revoked");
  assert.ok(!noConfirm.done, "the revocation record needs its explicit confirmation");
  assert.equal((await world.state()).credentials_may_be_lost, true);

  const confirmed = await world.phase("name=confirm-revoked&confirm=revoked-at-providers");
  assert.ok(confirmed.done, `confirm-revoked: ${confirmed.error}`);
  const st = await world.state();
  assert.equal(st.credentials_may_be_lost, false);
  assert.equal(st.revocations_confirmed.length, 1, "the owner's confirmation is recorded");
  assert.match(st.revocations_confirmed[0].cleared, /force stop/i);

  const wipe2 = await world.phase("name=wipe");
  assert.ok(wipe2.done, `wipe after the recorded revocation: ${wipe2.error}`);
  assert.equal((await world.state()).revocations_confirmed.length, 1, "the record survives a wipe");
  const start2 = await world.phase("name=start&fake=1");
  assert.ok(start2.done, `start after the recorded revocation: ${start2.error}`);
});

test("a computer that stops unexpectedly with an unpublished login is unresolved, not signed out", async () => {
  const world = await makeWorld();
  await signedInComputer(world);
  world.container.crash();
  const rec = await world.phase("name=recover&fake=1");
  assert.ok(!rec.done, "Recover must not complete as if the sign-out were verified");
  assert.ok(said(rec, /unresolved/i));
  const st = await world.state();
  assert.equal(st.credentials_may_be_lost, true);
  assert.match(st.credentials_lost.reason, /unexpectedly/);
  assert.ok(!(await world.phase("name=wipe")).done, "Wipe refuses");
  assert.ok(!(await world.phase("name=start&fake=1")).done, "Start refuses");
});

test("control: a published checkpoint, then Stop: Recover verifies the sign-out and Wipe works", async () => {
  const world = await makeWorld();
  await signedInComputer(world);
  const after = await world.phase("name=after-sign-in&fake=1");
  assert.ok(after.done, `after-sign-in: ${after.error}`);
  const stop = await world.phase("name=stop&fake=1");
  assert.ok(stop.done, `stop: ${stop.error}`);
  const rec = await world.phase("name=recover&fake=1");
  assert.ok(rec.done, `recover: ${rec.error}`);
  assert.equal(world.active.size, 0, "every synthetic login was revoked");
  assert.ok(
    rec.lines.some((l) => l.ok === true && /verified signed out/.test(l.step ?? "")),
    "Recover reports the verified sign-out",
  );
  const wipe = await world.phase("name=wipe");
  assert.ok(wipe.done, `wipe: ${wipe.error}`);
  assert.equal((await world.state()).objects, 0);
});

test("the owner page carries the revocation instructions and the confirmation control", async () => {
  const world = await makeWorld();
  const html = await (await world.obj.fetch(new Request(`${ORIGIN}/`))).text();
  assert.ok(/id="unresolved"/.test(html), "a warning element driven by the state");
  assert.ok(/Claude and ChatGPT account settings/.test(html), "the revocation instruction");
  assert.ok(/data-phase="confirm-revoked"/.test(html), "the revocation-record control");
});

// ------------------------------------------------------------------ finding 4 (P2)
const EFFECTS = new Set(["exec", "container-destroy", "container-start", "container-crash"]);
for (const query of [
  "name=after-sign-in&fake=1",
  "name=recover&fake=1",
  "name=stop&fake=1",
  "name=force-stop&fake=1&confirm=credentials-may-be-lost",
  "name=wipe",
  "name=close-terminal",
]) {
  const name = new URLSearchParams(query).get("name");
  test(`an already-connected terminal is closed before ${name} takes any step`, async () => {
    const world = await makeWorld();
    await signedInComputer(world);
    const term = await world.connectTerminal();
    assert.equal(term.res.status, 101);
    await term.type("0echo S6TERM$((40+2))OK\r");
    assert.ok(
      term.received.some((d) => d.includes("S6TERM42OK")),
      "the terminal works first",
    );
    const mark = world.events.length;
    await world.phase(query);
    const after = world.events.slice(mark);
    const closedAt = after.findIndex((e) => e.type === "ttyd-closed");
    const firstEffect = after.findIndex((e) => EFFECTS.has(e.type));
    assert.ok(closedAt >= 0, `${name}: the computer's end of the terminal was never closed`);
    assert.ok(
      firstEffect < 0 || closedAt < firstEffect,
      `${name}: the terminal was still open at the phase's first step (${after[firstEffect]?.detail})`,
    );
    assert.ok(await until(() => term.closed()), `${name}: the browser's end was not closed`);
    const ttyd = world.container.ttyd.at(-1);
    const inputs = ttyd.input.length;
    await term.type("0echo AFTER\r");
    assert.equal(ttyd.input.length, inputs, `${name}: input still reached the shell`);
  });
}

test("the terminal is closed when its window expires, with no further traffic", async () => {
  const world = await makeWorld({ injection: true });
  await signedInComputer(world, "name=start&fake=1&window_s=2");
  const term = await world.connectTerminal();
  assert.equal(term.res.status, 101);
  const deadline = Number(world.obj.meta("terminal_open_until"));
  assert.ok(await until(() => Date.now() > deadline + 1000, 8000), "the window has passed");
  assert.ok(await until(() => term.closed(), 500), "the open terminal was not closed at expiry");
  assert.ok(world.container.ttyd.at(-1).closed, "the shell's connection was not closed");
});

test("input that arrives after the window has closed is not forwarded", async () => {
  const world = await makeWorld();
  await signedInComputer(world);
  const term = await world.connectTerminal();
  await term.type("0echo S6TERM$((40+2))OK\r");
  const ttyd = world.container.ttyd.at(-1);
  const inputs = ttyd.input.length;
  // The deadline passes before any timer runs (a stalled timer, or one not yet due).
  world.obj.meta("terminal_open_until", Date.now() - 1);
  await term.type("0echo LATE\r");
  assert.equal(ttyd.input.length, inputs, "input reached the shell after the window closed");
  assert.ok(await until(() => term.closed(), 500), "the terminal stayed open");
});

test("the terminal WebSocket: 101 with the tty subprotocol, no handshake headers of its own, no owner material to the computer", async () => {
  const world = await makeWorld();
  await signedInComputer(world);
  const term = await world.connectTerminal();
  assert.equal(term.res.status, 101);
  assert.ok(term.res.webSocket, "a WebSocket is returned");
  assert.equal(term.res.headers.get("sec-websocket-protocol"), "tty");
  assert.equal(term.res.headers.get("upgrade"), null);
  assert.equal(term.res.headers.get("connection"), null);
  const sent = world.container.termRequests.at(-1).headers;
  assert.equal(sent.get("upgrade"), "websocket", "the upgrade still reaches ttyd");
  assert.equal(sent.get("sec-websocket-protocol"), "tty");
  for (const h of ["cookie", "x-s6-intent", "authorization", "cf-access-jwt-assertion"]) {
    assert.equal(sent.get(h), null, `${h} reached the computer`);
  }
});

test("binary terminal frames reach the shell as bytes and come back as bytes", async () => {
  // workerd delivers binary messages as Blobs unless binaryType is "arraybuffer", and send()
  // turns a Blob into the text "[object Blob]": found under wrangler dev, where ttyd logged
  // "ignored unknown message type: [".
  const world = await makeWorld();
  await signedInComputer(world);
  const term = await world.connectTerminal();
  await term.type("0echo S6TERM$((40+2))OK\r");
  const ttyd = world.container.ttyd.at(-1);
  assert.ok(
    ttyd.input.length > 0 && ttyd.input.every((t) => !t.startsWith("[object")),
    `ttyd got ${JSON.stringify(ttyd.input)}`,
  );
  assert.ok(
    await until(() => term.received.some((d) => d.includes("S6TERM42OK")), 500),
    `the browser got ${JSON.stringify(term.received)}`,
  );
});

test("binary frames still pass, in order, on a runtime that ignores binaryType (Blobs)", async () => {
  runtime.ignoreBinaryType = true;
  try {
    const world = await makeWorld();
    await signedInComputer(world);
    const term = await world.connectTerminal();
    for (const n of [1, 2, 3]) term.ws.send(new TextEncoder().encode(`0echo S6ORDER${n}\r`));
    await sleepReal(30);
    const ttyd = world.container.ttyd.at(-1);
    assert.deepEqual(
      ttyd.input.map((t) => /S6ORDER(\d)/.exec(t)?.[1]),
      ["1", "2", "3"],
      `ttyd got ${JSON.stringify(ttyd.input)}`,
    );
  } finally {
    runtime.ignoreBinaryType = false;
  }
});

test("the window_s test knob is refused when fault injection is off (as deployed)", async () => {
  const world = await makeWorld();
  const r = await world.phase("name=start&fake=1&window_s=2");
  assert.equal(r.status, 403);
  assert.equal(world.container.running, false);
});

// ------------------------------------------------------------------ finding 5 (P2)
const confirmPage = async (world, query) =>
  (await world.obj.fetch(new Request(`${ORIGIN}/api/phase?${query}`))).text();

for (const query of [
  "name=fake-sign-in&fake=1",
  "name=stop&fake=1&fail=capture",
  "name=force-stop&confirm=credentials-may-be-lost&fake=1",
  "name=recover&fake=1&case=a%26b%22%3Cx%3E",
]) {
  test(`the confirmation button sends every option: ${query}`, async () => {
    const world = await makeWorld({ injection: true });
    const call = await clickConfirmButton(await confirmPage(world, query));
    const sent = new URL(call.url, ORIGIN);
    assert.equal(sent.pathname, "/api/phase");
    assert.deepEqual(
      [...sent.searchParams].sort(),
      [...new URLSearchParams(query)].sort(),
      `sent ${call.url}`,
    );
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["X-S6-Intent"], world.token());
  });
}

// Click the confirmation page's button, then deliver its request to the Worker as the browser
// would (same origin, the page's token header).
async function confirmAndRun(world, query) {
  const call = await clickConfirmButton(await confirmPage(world, query));
  const res = await world.obj.fetch(
    new Request(new URL(call.url, ORIGIN), {
      method: call.init.method,
      headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", ...call.init.headers },
    }),
  );
  const text = await res.text();
  return { status: res.status, text, done: text.includes('"done":true') };
}

test("the confirmation button really runs a dry-run phase (fake=1)", async () => {
  const world = await makeWorld();
  assert.ok((await world.phase("name=start&fake=1")).done);
  const r = await confirmAndRun(world, "name=fake-sign-in&fake=1");
  assert.ok(r.done, `fake-sign-in through the confirmation page: ${r.text.slice(0, 300)}`);
  assert.equal(world.active.size, 2);
});

test("the confirmation button keeps a failure option (fail=capture)", async () => {
  const world = await makeWorld({ injection: true });
  await signedInComputer(world);
  const r = await confirmAndRun(world, "name=stop&fake=1&fail=capture");
  assert.ok(!r.done, "the injected capture failure must stop the Stop");
  assert.match(r.text, /injected failure/);
  assert.equal(world.container.running, true, "the computer keeps running");
});

test("the confirmation button keeps the force-stop confirmation", async () => {
  const world = await makeWorld();
  await signedInComputer(world);
  const r = await confirmAndRun(world, "name=force-stop&confirm=credentials-may-be-lost&fake=1");
  assert.ok(r.done, `force-stop through the confirmation page: ${r.text.slice(0, 300)}`);
  assert.equal(world.container.running, false);
  assert.equal((await world.state()).credentials_may_be_lost, true);
});

test("harness sanity: refusals still happen before any effect", async () => {
  const world = await makeWorld();
  const r = await world.phase("name=start&fake=1", { origin: "https://attacker.invalid" });
  assert.equal(r.status, 403);
  assert.equal(world.container.running, false);
  await sleepReal(1);
});
