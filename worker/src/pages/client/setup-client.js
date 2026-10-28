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
// - "Computer status": read on load and on Refresh; on staging, the RC-53 switch.
// Nothing here stores or logs what the terminal shows, the provider's link, Codex's code or the
// code the person pastes.
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

  // ------------------------------------------------------------------------------------------
  // The page's state.

  function replace(id, html) {
    const node = document.getElementById(id);
    if (node !== null && typeof html === "string") node.outerHTML = html;
  }

  async function refresh() {
    try {
      const response = await fetch(root.dataset.stateUrl, { credentials: "same-origin" });
      if (!response.ok) return;
      const json = await response.json();
      if (typeof json.intent === "string") state.intent = json.intent;
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
      if (openButton !== null) openButton.disabled = !json.running;
    } catch {
      // the next refresh tries again
    }
  }

  setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 5000);

  // ------------------------------------------------------------------------------------------
  // Sign-in from the page.

  /** Running flows by service: { attempt, state, notice, timer }. */
  const flows = {};
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
    const flow = flows[service] ?? { attempt: null, state: null, notice: null, timer: null };
    flows[service] = flow;
    const view = json?.view;
    if (json?.outcome === "accepted" && view) {
      const changed = view.state !== flow.state || view.notice !== flow.notice;
      flow.attempt = view.attempt;
      flow.state = ACTIVE.has(view.state) ? view.state : null;
      flow.notice = view.notice ?? null;
      // An unchanged state keeps the markup, so a code being typed is never wiped.
      if (changed) showFlow(service, json.html);
      if (ACTIVE.has(view.state)) schedule(service);
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

  function tell(service, text) {
    const slot = slotOf(service);
    if (slot === null) return;
    let line = slot.querySelector("[data-sign-in-message]");
    if (line === null) {
      line = document.createElement("p");
      line.className = "tone-warn";
      line.setAttribute("data-sign-in-message", "");
      slot.append(line);
    }
    line.textContent = text;
  }

  async function act(service, body, button) {
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
    } catch {
      tell(service, "The computer could not be reached now. Try again shortly.");
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
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
        void act(service, { mode: "start" }, button);
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
      flows[service] = { attempt, state: "starting", notice: null, timer: null };
      void poll(service);
    }
  } catch {
    // nothing to resume
  }

  // ------------------------------------------------------------------------------------------
  // Computer status, and the staging-only RC-53 switch.

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
      event.target instanceof Element ? event.target.closest('[data-act="rc53"]') : null;
    if (!button || statusSection === null) return;
    button.disabled = true;
    try {
      await fetch(statusSection.dataset.stagingUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: operationId(),
          intent: state.intent,
          rc53: button.getAttribute("data-rc53"),
        }),
      });
    } catch {
      // the status below shows what holds
    }
    await readStatus();
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

  async function open() {
    openButton.disabled = true;
    state.attempt += 1;
    const attempt = state.attempt;
    say("Opening…");
    try {
      const answer = await post({ mode: "open" });
      if (attempt !== state.attempt) return;
      const json = answer.json;
      if (json?.action === "open_terminal" && json.outcome === "accepted") {
        if (!(await connect(json.capability, json.window, attempt)) && attempt === state.attempt) {
          say("The terminal could not connect. Try again.");
        }
        return;
      }
      const reason = json?.reason;
      say(
        reason === "not_running"
          ? "The computer is not running. Send it work in Omnigent to wake it, then reload this page."
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

  openButton.addEventListener("click", () => void open());
  closeButton.addEventListener("click", () => void close());
  // For the local journeys only: lets a test drop the stream as a web Worker deploy would.
  window.cfoTerminal = state;
})();
