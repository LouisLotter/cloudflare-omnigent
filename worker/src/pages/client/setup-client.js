// The setup page's script (WP3.5). Served by the web Worker from this origin only.
//
// - It refreshes the page's state every few seconds: the status, the notices, the two sign-in
//   cards and the removal steps, from server-rendered, escaped markup, and the page's
//   request-intent token.
// - When the page has a terminal, it speaks ttyd 1.7.7's WebSocket protocol through the platform's
//   bridge. It asks for a capability with a guarded POST and offers it as a WebSocket subprotocol,
//   never in the URL. After a drop the platform did not cause (a web Worker deploy, FH-38), it asks
//   for a fresh capability for the same window and reconnects, retrying a failed handshake too,
//   within about ten seconds.
// - Sign-in from the page (WP3.23): each card's button starts its CLI's own login on the computer;
//   the card then shows the provider's link (and Codex's code), takes Claude's pasted code, polls
//   the attempt's state every 2 seconds, and offers Cancel; a failure offers the terminal. A
//   reload resumes the session's running attempts. The markup comes from the server, escaped.
// - "Computer status": read on load and on Refresh; on staging, the RC-53 and keep-awake switches.
// - Waking for a sign-in or the terminal (WP3.53): while the computer is not running, a card's
//   button and "Open the terminal" stay offered. Pressing one wakes the computer through Omnigent
//   (`POST /v1/hosts/{id}/start`, Omnigent owns its sleep), from this browser with the person's
//   own Omnigent session, waits until the platform says it runs, then starts what was pressed as
//   its button would on an awake computer. Every button pressed meanwhile shares that one wake.
//   It lives in memory only: a reload shows the computer's state now.
// Nothing here stores or logs what the terminal shows, the provider's link, Codex's code or the
// code the person pastes.

// The wake's sequence (WP3.53), apart from the page so that tests can drive it: `cfoWake(deps)`
// makes the page's one shared wake, `wake(hostUrl)`. It knows nothing of the page's state; the
// page supplies the calls:
//   startHost(hostUrl)  Omnigent's `POST …/start`: its HTTP status; throws when unreachable;
//   readRunning()       whether the platform says the computer runs; null when it cannot say;
//   readHost(hostUrl)   Omnigent's `persistent_status` ({ state, failure }); null when unread;
//   wait(ms), now()     the clock.
// The wake resolves { ok: true } once the platform says the computer runs, else { ok: false,
// reason, detail }: `signed_out` (401), `refused` (403), `unknown` (404), `unavailable` (any other
// answer, or none), `failed` (Omnigent's reason in `detail`, text only), `not_woken` (asleep again
// with no reason) or `timeout` (5 minutes; nothing keeps polling after it).
globalThis.cfoWake = (() => {
  const POLL_MS = 2000;
  const GIVE_UP_MS = 5 * 60_000;
  /** Omnigent's reason is shown as text, cut to a sensible length. */
  const MAX_DETAIL = 500;

  async function quietly(fn, ...args) {
    try {
      return await fn(...args);
    } catch {
      return null;
    }
  }

  async function run(deps, hostUrl) {
    const deadline = deps.now() + GIVE_UP_MS;
    let status;
    try {
      status = await deps.startHost(hostUrl);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (status === 401) return { ok: false, reason: "signed_out" };
    if (status === 403) return { ok: false, reason: "refused" };
    if (status === 404) return { ok: false, reason: "unknown" };
    if (!(status >= 200 && status < 300)) return { ok: false, reason: "unavailable" };
    for (;;) {
      // A read that fails is asked again next time: never taken as a refusal.
      if ((await quietly(deps.readRunning)) === true) return { ok: true };
      const host = await quietly(deps.readHost, hostUrl);
      // Omnigent answered 202 once its wake had begun: from then on it reports `waking` until
      // the wake ends, so `failed` or `asleep` here is this wake's end.
      if (host?.state === "failed") {
        const detail = typeof host.failure === "string" ? host.failure.slice(0, MAX_DETAIL) : null;
        return { ok: false, reason: "failed", detail };
      }
      if (host?.state === "asleep") return { ok: false, reason: "not_woken" };
      const left = deadline - deps.now();
      if (left <= 0) return { ok: false, reason: "timeout" };
      await deps.wait(Math.min(POLL_MS, left));
    }
  }

  return (deps) => {
    let inFlight = null;
    return (hostUrl) => {
      if (inFlight === null) {
        inFlight = run(deps, hostUrl).finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    };
  };
})();

(() => {
  const root = document.getElementById("computer-page");
  if (root === null) return;
  const panel = document.getElementById("terminal-panel");
  const encoder = new TextEncoder();
  const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
  /** Waits before each reconnect attempt after a drop: about 8 s in all, under the 10 s target. */
  const RECONNECT_WAITS = [250, 500, 1000, 2000, 4000];
  /** A handshake that has not opened by then counts as failed. */
  const HANDSHAKE_MS = 5000;
  /** The platform closed the stream on purpose, or the computer's side ended. */
  const CLOSED_BY_PLATFORM = 4001;
  const CLOSED_BY_COMPUTER = 4002;

  const state = {
    intent: panel?.dataset.intent || root.dataset.intent || "",
    window: panel?.dataset.window ? Number(panel.dataset.window) : null,
    socket: null,
    term: null,
    fit: null,
    reconnecting: false,
    /** Counts open, close and reconnect attempts: a late answer or handshake of an older one is
     * ignored and its socket closed (Codex r2-3). */
    attempt: 0,
    /** The socket whose handshake is in progress, so a close can cancel it. */
    pending: null,
  };

  function operationId() {
    const bytes = crypto.getRandomValues(new Uint8Array(26));
    let id = "op_";
    for (const b of bytes) id += BASE32[b % 32];
    return id;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * What the page last learned (WP3.53): whether the computer runs, and where Omnigent wakes it
   * (null when the page cannot). `terminalWake`: the terminal press a wake runs for, or null.
   */
  const live = {
    running: root.dataset.running === "yes",
    hostUrl: root.dataset.hostUrl || null,
    terminalWake: null,
  };
  // The script runs: what only it can do (waking the computer from the page) may be said now.
  root.dataset.script = "on";

  // ------------------------------------------------------------------------------------------
  // The page's state.

  function replace(id, html) {
    const node = document.getElementById(id);
    if (node !== null && typeof html === "string") node.outerHTML = html;
  }

  /** A read that does not answer by then counts as unread: no read here waits longer. */
  const READ_MS = 10_000;

  async function readJson(url) {
    const response = await fetch(url, {
      credentials: "same-origin",
      signal: AbortSignal.timeout(READ_MS),
    });
    return response.ok ? response.json() : null;
  }

  /**
   * Every read of the page's state takes a ticket when it is sent. An answer is applied only if
   * no read sent after it was applied first, so an older read that answers late never replaces
   * newer state, such as the generation and intent a wake's last read found (Codex WP3.53 r1-1).
   */
  let sent = 0;
  let applied = 0;

  /** Reads the page's state (bounded) and applies it: the JSON, or null when it was not read. */
  async function readState() {
    sent += 1;
    const ticket = sent;
    let json;
    try {
      json = await readJson(root.dataset.stateUrl);
    } catch {
      return null;
    }
    if (json === null || typeof json !== "object") return null;
    if (ticket > applied) {
      applied = ticket;
      applyState(json);
    }
    return json;
  }

  async function refresh() {
    await readState();
  }

  function applyState(json) {
    try {
      if (typeof json.intent === "string") state.intent = json.intent;
      if (Number.isSafeInteger(json.generation)) root.dataset.generation = String(json.generation);
      live.running = json.running === true;
      live.hostUrl = typeof json.hostUrl === "string" ? json.hostUrl : null;
      if (Array.isArray(json.cards)) {
        for (const card of json.cards) updateCard(card.provider, card.html);
      }
      const status = document.getElementById("status");
      if (status !== null && typeof json.statusHtml === "string")
        status.innerHTML = json.statusHtml;
      const notices = document.getElementById("notices");
      if (notices !== null && typeof json.noticesHtml === "string") {
        notices.innerHTML = json.noticesHtml;
      }
      replace("removal", json.removalHtml);
      for (const node of document.querySelectorAll("[data-saving]")) {
        node.textContent = json.saving;
      }
      const openButton = document.getElementById("terminal-open");
      if (openButton !== null) {
        openButton.disabled =
          live.terminalWake !== null || !(live.running || live.hostUrl !== null);
      }
    } catch {
      // the next refresh tries again
    }
  }

  setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 5000);

  // ------------------------------------------------------------------------------------------
  // Waking the computer through Omnigent (WP3.53).

  /**
   * What the wake's last read found once the computer ran: its generation and intent, which the
   * page's own state may not hold yet. Page-private: the wake sequence never sees it.
   */
  let awake = null;

  /** The page's one wake: shared by the cards and the terminal. */
  const shared = globalThis.cfoWake({
    // Omnigent's own call, as its computer list makes it: the person's Omnigent session, no body.
    startHost: async (hostUrl) => {
      awake = null;
      return (
        await fetch(`${hostUrl}/start`, {
          method: "POST",
          credentials: "same-origin",
          signal: AbortSignal.timeout(READ_MS),
        })
      ).status;
    },
    // Each read is the page's own state read, bounded and applied in order.
    readRunning: async () => {
      const json = await readState();
      if (json === null) return null;
      if (json.running !== true) return false;
      awake =
        Number.isSafeInteger(json.generation) &&
        typeof json.intent === "string" &&
        /^[0-9a-f]{64}$/.test(json.intent)
          ? { generation: json.generation, intent: json.intent }
          : null;
      return true;
    },
    readHost: async (hostUrl) => {
      const status = (await readJson(hostUrl))?.persistent_status;
      return status && typeof status === "object" ? status : null;
    },
    wait,
    now: () => Date.now(),
  });

  /**
   * Wakes the computer; once it runs, the outcome carries `awake`: the generation and intent to
   * act with, from the read that found it running (Codex WP3.53 r1-1). No other read follows, so
   * nothing after the wake can hold a button (r1-2).
   */
  async function wake(hostUrl) {
    let outcome;
    try {
      outcome = await shared(hostUrl);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    return outcome.ok ? { ok: true, awake } : outcome;
  }

  /** The computer runs, but the page could not read what it needs to go on: press again. */
  const AWAKE_PRESS_AGAIN = "The computer is awake now. Press the button again.";

  /** What a failed wake tells the person: text only, never markup. */
  function wakeFailure(outcome) {
    switch (outcome.reason) {
      case "signed_out":
        return "Omnigent needs you to sign in before it can wake the computer. Open Omnigent in this browser, sign in, then press the button again.";
      case "refused":
        return "Omnigent did not wake the computer for the account this browser is signed in with. Open Omnigent, check that you are signed in as yourself, then try again.";
      case "unknown":
        return "Omnigent does not know this computer. Check that Omnigent still lists it.";
      case "failed":
        return outcome.detail
          ? `The computer did not wake. Omnigent says: ${outcome.detail} Try again later.`
          : "The computer did not wake. Try again later.";
      case "not_woken":
        return "The computer did not wake. Press the button to try again.";
      case "timeout":
        return "The computer did not wake within 5 minutes. Check it in Omnigent's list of computers, then press the button again.";
      default:
        return "Omnigent could not be reached to wake the computer. Try again shortly.";
    }
  }

  // ------------------------------------------------------------------------------------------
  // Sign-in from the page.

  /** Running flows by service: { attempt, state, shown, timer }. `shown`: what the markup shows. */
  const flows = {};
  /**
   * A failed wake's message by service (WP3.53): kept until the person's next press, so the
   * state refresh, which replaces the card, never wipes what went wrong.
   */
  const wakeNotes = {};
  const POLL_MS = 2000;
  const ACTIVE = new Set(["starting", "awaiting_user", "completing"]);

  function cardOf(service) {
    return document.querySelector(`#cards [data-card="${service}"]`);
  }

  function slotOf(service) {
    return document.querySelector(`#cards [data-sign-in="${service}"]`);
  }

  /** A card from the state refresh: whole, unless a flow runs in it, which keeps its slot. */
  function updateCard(service, html) {
    const card = cardOf(service);
    if (card === null || typeof html !== "string") return;
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const fresh = template.content.firstElementChild;
    if (fresh === null) return;
    const flow = flows[service];
    if (flow === undefined || flow.state === null) {
      card.replaceWith(fresh);
      if (wakeNotes[service]) tell(service, wakeNotes[service], "tone-danger");
      return;
    }
    const slot = slotOf(service);
    const freshSlot = fresh.querySelector("[data-sign-in]");
    if (slot !== null && freshSlot !== null) freshSlot.replaceWith(slot);
    card.replaceWith(fresh);
  }

  function showFlow(service, html) {
    const slot = slotOf(service);
    if (slot !== null && typeof html === "string") slot.innerHTML = html;
  }

  async function signInPost(body) {
    const response = await fetch(root.dataset.signInUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: operationId(), intent: state.intent, ...body }),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  function stopPolling(service) {
    const flow = flows[service];
    if (flow?.timer) clearTimeout(flow.timer);
    if (flow) flow.timer = null;
  }

  /** Applies an answer: the server's markup, and polling while the attempt is active. */
  function apply(service, json) {
    const flow = flows[service] ?? { attempt: null, state: null, shown: null, timer: null };
    flows[service] = flow;
    const view = json?.view;
    if (json?.outcome === "accepted" && view) {
      // The markup changes only with the attempt, its state, its notice or a pending cleanup,
      // so a code being typed is never wiped by a poll (Codex WP3.23 r1-5).
      const shown = `${view.attempt}/${view.state}/${view.notice ?? ""}/${view.pending === true}`;
      const changed = shown !== flow.shown;
      // A cleanup not yet confirmed keeps polling, as an active attempt does.
      const active = ACTIVE.has(view.state) || view.pending === true;
      flow.attempt = view.attempt;
      flow.state = active ? view.state : null;
      flow.shown = shown;
      if (changed) showFlow(service, json.html);
      if (active) schedule(service);
      else {
        stopPolling(service);
        if (view.state === "done") void refresh();
      }
      return;
    }
    if (json?.outcome === "refused") {
      if (json.reason === "unreachable" && flow.state !== null) {
        schedule(service); // the computer may answer again
        return;
      }
      flow.state = null;
      stopPolling(service);
      showFlow(service, json.html);
      return;
    }
    flow.state = null;
    stopPolling(service);
  }

  function schedule(service) {
    const flow = flows[service];
    if (flow === undefined) return;
    stopPolling(service);
    flow.timer = setTimeout(() => void poll(service), POLL_MS);
  }

  async function poll(service) {
    const flow = flows[service];
    if (flow === undefined || flow.attempt === null) return;
    try {
      const url = new URL(root.dataset.signInUrl, location.href);
      url.searchParams.set("service", service);
      url.searchParams.set("attempt", String(flow.attempt));
      const response = await fetch(url.href, { credentials: "same-origin" });
      if (!response.ok) {
        schedule(service);
        return;
      }
      apply(service, await response.json());
    } catch {
      schedule(service);
    }
  }

  function tell(service, text, tone = "tone-warn") {
    const slot = slotOf(service);
    if (slot === null) return;
    let line = slot.querySelector("[data-sign-in-message]");
    if (line === null) {
      line = document.createElement("p");
      line.setAttribute("data-sign-in-message", "");
      slot.append(line);
    }
    line.className = tone;
    line.textContent = text;
  }

  async function act(service, body, button) {
    delete wakeNotes[service];
    if (button) button.disabled = true;
    try {
      const answer = await signInPost({ service, ...body });
      if (answer.status === 403) {
        await refresh();
        tell(service, "This page was out of date. Try again.");
        return;
      }
      if (answer.status === 400 && answer.json?.error?.field === "code") {
        tell(service, "Paste the whole code, without spaces.");
        return;
      }
      if (answer.json?.error) {
        tell(service, "The computer could not be reached now. Try again shortly.");
        return;
      }
      apply(service, answer.json);
      // Asleep after all: learn it now, so the button wakes it next time.
      if (answer.json?.reason === "not_running") void refresh();
    } catch {
      tell(service, "The computer could not be reached now. Try again shortly.");
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  /** The card while the wake runs: static markup, no value from anywhere. */
  const WAKING_CARD =
    '<p data-sign-in-state="waking" role="status">Waking the computer… this takes about a minute. The sign-in starts by itself once it is awake.</p>';

  /**
   * Wakes the computer, then starts this card's sign-in as its button does on an awake computer
   * (WP3.53), with the generation and intent the wake's last read found: no further read can
   * fail or hang in between (Codex WP3.53 r1-1, r1-2). The card keeps its slot while the wake
   * runs; then its button comes back, with what went wrong if anything did.
   */
  async function wakeThenStart(service) {
    const slot = slotOf(service);
    const hostUrl = live.hostUrl;
    if (slot === null || hostUrl === null) return;
    delete wakeNotes[service];
    slot.querySelector("[data-sign-in-message]")?.remove();
    const before = slot.innerHTML;
    const flow = flows[service] ?? { attempt: null, state: null, shown: null, timer: null };
    flows[service] = flow;
    stopPolling(service);
    const press = {};
    flow.attempt = null;
    flow.shown = null;
    flow.state = "waking";
    flow.press = press;
    slot.innerHTML = WAKING_CARD;
    const outcome = await wake(hostUrl);
    // A press the card has moved on from never acts.
    if (flows[service] !== flow || flow.press !== press) return;
    flow.press = null;
    flow.state = null;
    const current = slotOf(service);
    if (current === null) return; // the card no longer offers it (an older computer, a removal)
    current.innerHTML = before;
    if (!outcome.ok || outcome.awake === null) {
      wakeNotes[service] = outcome.ok ? AWAKE_PRESS_AGAIN : wakeFailure(outcome);
      tell(service, wakeNotes[service], "tone-danger");
      return;
    }
    const { generation, intent } = outcome.awake;
    await act(
      service,
      { mode: "start", generation: String(generation), intent },
      current.querySelector('[data-act="start"]'),
    );
  }

  async function copyCode(button) {
    const code = button.closest("[data-sign-in]")?.querySelector("[data-user-code]");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent ?? "");
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select the code to copy it";
    }
  }

  document.getElementById("cards")?.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("[data-act]") : null;
    const slot = button?.closest("[data-sign-in]");
    if (!button || !slot) return;
    const service = slot.getAttribute("data-sign-in");
    const flow = flows[service];
    switch (button.getAttribute("data-act")) {
      case "start":
        if (!live.running && live.hostUrl !== null) void wakeThenStart(service);
        else void act(service, { mode: "start", generation: root.dataset.generation }, button);
        break;
      case "cancel":
        if (flow?.attempt) void act(service, { mode: "cancel", attempt: flow.attempt }, button);
        break;
      case "continue": {
        const input = slot.querySelector("[data-code]");
        const code = input ? input.value : "";
        if (input) input.value = "";
        if (flow?.attempt) {
          void act(service, { mode: "input", attempt: flow.attempt, code }, button);
        }
        break;
      }
      case "copy":
        void copyCode(button);
        break;
      case "terminal": {
        const terminal = document.getElementById("terminal-panel");
        terminal?.scrollIntoView({ behavior: "smooth", block: "start" });
        document.getElementById("terminal-open")?.focus();
        break;
      }
    }
  });

  document.getElementById("cards")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !(event.target instanceof Element)) return;
    if (!event.target.matches("[data-code]")) return;
    event.preventDefault();
    event.target.closest("[data-sign-in]")?.querySelector('[data-act="continue"]')?.click();
  });

  // A reload resumes this session's attempts that still run.
  try {
    for (const { service, attempt } of JSON.parse(root.dataset.resume || "[]")) {
      flows[service] = { attempt, state: "starting", shown: null, timer: null };
      void poll(service);
    }
  } catch {
    // nothing to resume
  }

  // ------------------------------------------------------------------------------------------
  // Computer status, and the staging-only switches: RC-53's save check and keep-awake.

  const statusSection = document.getElementById("computer-status");
  const statusBody = document.getElementById("status-body");
  const statusRefresh = document.getElementById("status-refresh");

  async function readStatus() {
    if (statusSection === null || statusBody === null) return;
    if (statusRefresh) statusRefresh.disabled = true;
    try {
      const response = await fetch(statusSection.dataset.statusUrl, { credentials: "same-origin" });
      const json = await response.json();
      if (response.ok && typeof json.html === "string") statusBody.innerHTML = json.html;
      else statusBody.textContent = "The status could not be read now. Try Refresh shortly.";
    } catch {
      statusBody.textContent = "The status could not be read now. Try Refresh shortly.";
    } finally {
      if (statusRefresh) statusRefresh.disabled = false;
    }
  }

  statusRefresh?.addEventListener("click", () => void readStatus());
  statusBody?.addEventListener("click", async (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest('[data-act="rc53"], [data-act="keep-awake"]')
        : null;
    if (!button || statusSection === null) return;
    const which = button.getAttribute("data-act") === "rc53" ? "rc53" : "keepAwake";
    const value = button.getAttribute(which === "rc53" ? "data-rc53" : "data-keep-awake");
    button.disabled = true;
    try {
      await fetch(statusSection.dataset.stagingUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: operationId(), intent: state.intent, [which]: value }),
      });
    } catch {
      // the status below shows what holds
    }
    await readStatus();
    // The computer applies the switch moments later: read it again then.
    setTimeout(() => void readStatus(), 3000);
  });
  void readStatus();

  if (panel === null) return;

  // ------------------------------------------------------------------------------------------
  // The terminal.

  const openButton = document.getElementById("terminal-open");
  const closeButton = document.getElementById("terminal-close");
  const statusLine = document.getElementById("terminal-status");
  const screen = document.getElementById("terminal");

  function say(text) {
    statusLine.textContent = text;
  }

  function showOpen(open) {
    openButton.hidden = open;
    closeButton.hidden = !open;
    screen.hidden = !open;
  }

  async function post(body) {
    const response = await fetch(panel.dataset.terminalUrl, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: operationId(), intent: state.intent, ...body }),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  function ensureTerminal() {
    if (state.term !== null) return;
    state.term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000 });
    state.fit = new FitAddon.FitAddon();
    state.term.loadAddon(state.fit);
    screen.hidden = false;
    state.term.open(screen);
    state.fit.fit();
    state.term.onData((data) => send(`0${data}`));
    state.term.onBinary((data) => {
      const bytes = new Uint8Array(data.length + 1);
      bytes[0] = 0x30;
      for (let i = 0; i < data.length; i += 1) bytes[i + 1] = data.charCodeAt(i) & 0xff;
      sendBytes(bytes);
    });
    state.term.onResize(({ cols, rows }) => send(`1${JSON.stringify({ columns: cols, rows })}`));
    window.addEventListener("resize", () => {
      if (state.fit !== null && !screen.hidden) state.fit.fit();
    });
  }

  function sendBytes(bytes) {
    const socket = state.socket;
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(bytes);
  }

  function send(text) {
    sendBytes(encoder.encode(text));
  }

  /** Opens a stream with this capability. Resolves true once it is open, false if it never opens. */
  function connect(capability, windowNumber, attempt) {
    if (attempt !== state.attempt) return Promise.resolve(false);
    ensureTerminal();
    state.window = windowNumber;
    const url = new URL(panel.dataset.terminalUrl, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return new Promise((resolve) => {
      let opened = false;
      const socket = new WebSocket(url.href, ["tty", `cfo-capability.${capability}`]);
      socket.binaryType = "arraybuffer";
      state.pending = socket;
      const timer = setTimeout(() => {
        if (!opened) socket.close();
      }, HANDSHAKE_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        if (state.pending === socket) state.pending = null;
        if (attempt !== state.attempt) {
          // Closed or superseded while the handshake ran: never show it.
          socket.close(1000, "cancelled");
          resolve(false);
          return;
        }
        opened = true;
        state.socket = socket;
        state.reconnecting = false;
        showOpen(true);
        say("Connected. The terminal closes at its deadline, and before a sign-out or a stop.");
        state.fit.fit();
        // ttyd's first message: its auth token (unused: the platform checked the capability) and
        // the terminal's size.
        send(JSON.stringify({ AuthToken: "", columns: state.term.cols, rows: state.term.rows }));
        state.term.focus();
        resolve(true);
      });
      socket.addEventListener("message", (event) => {
        if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) return;
        const command = new Uint8Array(event.data, 0, 1)[0];
        if (command === 0x30) state.term.write(new Uint8Array(event.data, 1));
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        if (state.pending === socket) state.pending = null;
        if (!opened) {
          resolve(false);
          return;
        }
        // A socket the page let go of (closed, or replaced) ends quietly.
        if (state.socket !== socket) return;
        state.socket = null;
        if (event.code === CLOSED_BY_PLATFORM) {
          state.window = null;
          showOpen(false);
          say(
            event.reason ? `Closed: ${event.reason.replace(/^terminal closed: /, "")}.` : "Closed.",
          );
          return;
        }
        if (event.code === CLOSED_BY_COMPUTER) {
          state.window = null;
          showOpen(false);
          say("The terminal session on the computer ended. Open it again for a new one.");
          return;
        }
        void reconnect();
      });
    });
  }

  async function reconnect() {
    if (state.reconnecting || state.window === null) return;
    state.reconnecting = true;
    state.attempt += 1;
    const attempt = state.attempt;
    say("Reconnecting…");
    try {
      for (const pause of RECONNECT_WAITS) {
        await wait(pause);
        if (attempt !== state.attempt || state.window === null) return;
        let answer;
        try {
          answer = await post({ mode: "reconnect", window: state.window });
        } catch {
          continue;
        }
        if (attempt !== state.attempt) return;
        if (answer.status === 403) {
          await refresh();
          continue;
        }
        const json = answer.json;
        if (json?.action === "open_terminal" && json.outcome === "accepted") {
          // A handshake that fails is retried with the next fresh capability.
          if (await connect(json.capability, json.window, attempt)) return;
          if (attempt !== state.attempt) return;
          continue;
        }
        if (json?.outcome === "refused") break;
      }
      state.window = null;
      showOpen(false);
      say("The terminal could not reconnect. Open it again.");
    } finally {
      state.reconnecting = false;
    }
  }

  /** `intent`: the one a wake's last read found (WP3.53); otherwise the page's own. */
  async function open(intent = null) {
    openButton.disabled = true;
    state.attempt += 1;
    const attempt = state.attempt;
    say("Opening…");
    try {
      const answer = await post({ mode: "open", ...(intent === null ? {} : { intent }) });
      if (attempt !== state.attempt) return;
      const json = answer.json;
      if (json?.action === "open_terminal" && json.outcome === "accepted") {
        if (!(await connect(json.capability, json.window, attempt)) && attempt === state.attempt) {
          say("The terminal could not connect. Try again.");
        }
        return;
      }
      const reason = json?.reason;
      if (reason === "not_running") void refresh();
      say(
        reason === "not_running"
          ? live.hostUrl !== null
            ? "The computer is not running. Press Open the terminal again to wake it."
            : "The computer is not running. Start a new thread on it in Omnigent to wake it, then reload this page."
          : reason === "busy"
            ? "The computer is stopping or signing out. Try again shortly."
            : answer.status === 403
              ? "This page is out of date. Reload it, then try again."
              : "The terminal could not be opened now.",
      );
    } catch {
      say("The terminal could not be opened now.");
    } finally {
      openButton.disabled = false;
    }
  }

  async function close() {
    // Cancels everything in flight first: a pending handshake, a reconnect, a late answer.
    state.attempt += 1;
    if (state.pending !== null) {
      state.pending.close(1000, "closed");
      state.pending = null;
    }
    const socket = state.socket;
    state.socket = null;
    try {
      await post({ mode: "close" });
    } catch {
      // the platform closes it at its deadline anyway
    }
    if (socket !== null) socket.close(1000, "closed");
    state.window = null;
    showOpen(false);
    say("Closed. The computer may go to sleep again.");
  }

  /**
   * Wakes the computer through Omnigent, then opens the terminal as the button does (WP3.53),
   * with the intent the wake's last read found. The button is released when the wake ends, which
   * is bounded, whatever its outcome; a press the page has moved on from never opens.
   */
  async function wakeThenOpen() {
    const hostUrl = live.hostUrl;
    if (hostUrl === null || live.terminalWake !== null) return;
    const press = {};
    live.terminalWake = press;
    openButton.disabled = true;
    say(
      "Waking the computer… this takes about a minute. The terminal opens by itself once it is awake.",
    );
    const outcome = await wake(hostUrl);
    if (live.terminalWake !== press) return;
    live.terminalWake = null;
    openButton.disabled = false;
    if (!outcome.ok) say(wakeFailure(outcome));
    else if (outcome.awake === null) say(AWAKE_PRESS_AGAIN);
    else await open(outcome.awake.intent);
  }

  openButton.addEventListener("click", () => {
    if (!live.running && live.hostUrl !== null) void wakeThenOpen();
    else void open();
  });
  closeButton.addEventListener("click", () => void close());
  // For the local journeys only: lets a test drop the stream as a web Worker deploy would.
  window.cfoTerminal = state;
})();
