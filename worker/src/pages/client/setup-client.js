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
// Nothing here stores or logs what the terminal shows.
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
    intent: panel?.dataset.intent || "",
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
      const cards = document.getElementById("cards");
      if (cards !== null && Array.isArray(json.cards)) {
        cards.innerHTML = json.cards.map((card) => card.html).join("\n");
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
