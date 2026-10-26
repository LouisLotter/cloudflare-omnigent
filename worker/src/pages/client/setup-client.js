// The setup page's terminal client (WP3.5). Served by the web Worker from this origin only; it
// speaks ttyd 1.7.7's WebSocket protocol through the platform's bridge. It asks for a capability
// with a guarded POST, offers it as a WebSocket subprotocol (never in the URL), and after a drop
// that the platform did not cause (a web Worker deploy, FH-38) asks for a fresh capability for the
// same window and reconnects, within about ten seconds. It refreshes the sign-in cards from the
// page's state every few seconds. Nothing here stores or logs what the terminal shows.
(() => {
  const panel = document.getElementById("terminal-panel");
  if (panel === null) return;
  const openButton = document.getElementById("terminal-open");
  const closeButton = document.getElementById("terminal-close");
  const statusLine = document.getElementById("terminal-status");
  const screen = document.getElementById("terminal");
  const cards = document.getElementById("cards");
  const encoder = new TextEncoder();
  const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";
  /** Waits between reconnect attempts after a drop: about 8 s in all, under the 10 s target. */
  const RECONNECT_WAITS = [250, 500, 1000, 2000, 4000];
  /** The platform closed the stream on purpose, or the computer's side ended. */
  const CLOSED_BY_PLATFORM = 4001;
  const CLOSED_BY_COMPUTER = 4002;

  const state = {
    intent: panel.dataset.intent || "",
    window: panel.dataset.window ? Number(panel.dataset.window) : null,
    socket: null,
    term: null,
    fit: null,
    closing: false,
    reconnecting: false,
  };

  function operationId() {
    const bytes = crypto.getRandomValues(new Uint8Array(26));
    let id = "op_";
    for (const b of bytes) id += BASE32[b % 32];
    return id;
  }

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

  function connect(capability, windowNumber) {
    ensureTerminal();
    const url = new URL(panel.dataset.terminalUrl, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url.href, ["tty", `cfo-capability.${capability}`]);
    socket.binaryType = "arraybuffer";
    state.socket = socket;
    state.window = windowNumber;
    socket.addEventListener("open", () => {
      state.reconnecting = false;
      showOpen(true);
      say("Connected. The terminal closes at its deadline, and before a sign-out or a stop.");
      state.fit.fit();
      // ttyd's first message: its auth token (unused: the platform checked the capability) and
      // the terminal's size.
      send(JSON.stringify({ AuthToken: "", columns: state.term.cols, rows: state.term.rows }));
      state.term.focus();
    });
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) return;
      const command = new Uint8Array(event.data, 0, 1)[0];
      if (command === 0x30) state.term.write(new Uint8Array(event.data, 1));
    });
    socket.addEventListener("close", (event) => {
      if (state.socket !== socket) return;
      state.socket = null;
      if (state.closing) {
        state.closing = false;
        return;
      }
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
  }

  async function reconnect() {
    if (state.reconnecting || state.window === null) return;
    state.reconnecting = true;
    say("Reconnecting…");
    for (const wait of RECONNECT_WAITS) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      let answer;
      try {
        answer = await post({ mode: "reconnect", window: state.window });
      } catch {
        continue;
      }
      if (answer.status === 403) {
        await refresh();
        continue;
      }
      const json = answer.json;
      if (json && json.action === "open_terminal" && json.outcome === "accepted") {
        connect(json.capability, json.window);
        return;
      }
      if (json && json.outcome === "refused") break;
    }
    state.reconnecting = false;
    state.window = null;
    showOpen(false);
    say("The terminal could not reconnect. Open it again.");
  }

  async function open() {
    openButton.disabled = true;
    say("Opening…");
    try {
      const answer = await post({ mode: "open" });
      const json = answer.json;
      if (json && json.action === "open_terminal" && json.outcome === "accepted") {
        connect(json.capability, json.window);
        return;
      }
      const reason = json?.reason;
      say(
        reason === "not_running"
          ? "The computer is not running. Start it from Omnigent, then reload this page."
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
    state.closing = true;
    const socket = state.socket;
    try {
      await post({ mode: "close" });
    } catch {
      // the platform closes it at its deadline anyway
    }
    if (socket !== null) socket.close(1000, "closed");
    state.socket = null;
    state.window = null;
    showOpen(false);
    say("Closed. The computer may go to sleep again.");
  }

  async function refresh() {
    try {
      const response = await fetch(panel.dataset.stateUrl, { credentials: "same-origin" });
      if (!response.ok) return;
      const json = await response.json();
      if (typeof json.intent === "string") state.intent = json.intent;
      if (cards !== null && Array.isArray(json.cards)) {
        cards.innerHTML = json.cards.map((card) => card.html).join("\n");
      }
      for (const node of document.querySelectorAll("[data-saving]")) {
        node.textContent = json.saving;
      }
      openButton.disabled = !json.running;
    } catch {
      // the next refresh tries again
    }
  }

  openButton.addEventListener("click", () => void open());
  closeButton.addEventListener("click", () => void close());
  setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 5000);
  // For the local journeys only: lets a test drop the stream as a web Worker deploy would.
  window.cfoTerminal = state;
})();
