/**
 * A fake ttyd 1.7.7 for the local journeys (WP3.5): answers the terminal port's upgrade with a
 * WebSocket speaking ttyd's protocol, and a tiny shell that knows the two sign-in commands. It
 * never contacts a provider: `claude auth login --claudeai` prints a synthetic link and takes a
 * pasted code; `codex login --device-auth` prints a synthetic device code. Each completed sign-in
 * calls `onSignIn`, which makes the fake supervisor's credential watcher publish a login, as the
 * real CLIs' writes do. `echo $$` prints the shell's number, so a journey can tell a reattach
 * (same shell) from a new one. Runs in workerd.
 *
 * With `sessions` (WP3.28), shells are kept per window on the computer as tmux keeps them behind
 * the real ttyd: the dial's URL arguments `new <window>` start or join the window's shell (and end
 * every other window's), `attach <window>` joins it or ends the stream at once, and a shell
 * outlives its stream, so a reconnect after a Durable Object reset finds it. The supervisor's
 * `terminal_end` and its backstops end them. Without arguments, each stream gets a new shell that
 * ends with it, as before.
 */

import type { FakeTerminalSessions } from "../support/fake-supervisor.ts";

const OUTPUT = 0x30; // ttyd: "0" output (server), "0" input (client)
const RESIZE = 0x31;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let shells = 0;

export interface ShellHooks {
  readonly onSignIn: (provider: "claude" | "codex") => void;
  /** The computer's sessions per window (WP3.28); absent: a new shell per stream. */
  readonly sessions?: FakeTerminalSessions;
}

/** One shell, which a stream binds to; output goes to the stream bound now, or nowhere. */
interface Shell {
  readonly id: number;
  socket: WebSocket | null;
  line: string;
  waitingFor: "claude_code" | null;
  /** Its first stream has started it. */
  started: boolean;
}

/** The shell kept for each session the computer holds (WP3.28). */
const kept = new WeakMap<object, Shell>();

/** The terminal port's handler: a 101 with a stream to a shell, as ttyd answers `/ws`. */
export function fakeTtyd(hooks: ShellHooks): (request: Request) => Response {
  return (request) => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("ttyd's page is never served to the platform", { status: 404 });
    }
    const args = new URL(request.url).searchParams.getAll("arg");
    const pair = new WebSocketPair();
    const socket = pair[1];
    socket.accept();
    socket.binaryType = "arraybuffer";
    const window =
      args.length === 2 && /^[1-9][0-9]{0,8}$/.test(args[1] ?? "") ? Number(args[1]) : 0;
    const sessions = hooks.sessions;
    if (sessions !== undefined && window > 0 && (args[0] === "new" || args[0] === "attach")) {
      const session = args[0] === "new" ? sessions.open(window) : sessions.attach(window);
      if (session === null) {
        // The wrapper exits before ttyd reads anything: the stream ends at once.
        setTimeout(() => socket.close(1000, ""), 5);
      } else {
        let shell = kept.get(session);
        if (shell === undefined) {
          shell = newShell();
          kept.set(session, shell);
        }
        bind(shell, socket, hooks, () => sessions.attach(window) === session);
      }
    } else {
      bind(newShell(), socket, hooks, () => true);
    }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": "tty" },
    });
  };
}

function newShell(): Shell {
  shells += 1;
  return { id: 4000 + shells, socket: null, line: "", waitingFor: null, started: false };
}

/**
 * Binds a stream to `shell`. `alive` says whether the computer still holds its session; a shell
 * whose session ended answers nothing and closes the stream, as ttyd does when its process exits.
 */
function bind(shell: Shell, socket: WebSocket, hooks: ShellHooks, alive: () => boolean): void {
  let started = false;
  const write = (text: string) => {
    if (shell.socket !== socket) return;
    const body = encoder.encode(text);
    const frame = new Uint8Array(body.length + 1);
    frame[0] = OUTPUT;
    frame.set(body, 1);
    try {
      socket.send(frame);
    } catch {
      // the bridge closed it
    }
  };
  const prompt = () => write("omnigent@computer:~$ ");
  const run = (command: string) => {
    if (shell.waitingFor === "claude_code") {
      shell.waitingFor = null;
      if (command.trim().length < 8) {
        write("Invalid code.\r\n");
      } else {
        write("Login successful.\r\n");
        hooks.onSignIn("claude");
      }
      prompt();
      return;
    }
    const trimmed = command.trim();
    if (trimmed === "claude auth login --claudeai") {
      write(
        "Browser didn't open? Use the url below to sign in:\r\n\r\nhttps://claude.example.invalid/oauth/authorize?code=true&state=synthetic\r\n\r\nPaste code here if prompted > ",
      );
      shell.waitingFor = "claude_code";
      return;
    }
    if (trimmed === "codex login --device-auth") {
      write(
        "Follow these steps to sign in with ChatGPT using device code authorization:\r\n1. Open https://auth.example.invalid/codex/device\r\n2. Enter this one-time code: SYNT-HETC\r\n",
      );
      setTimeout(() => {
        write("Successfully logged in\r\n");
        hooks.onSignIn("codex");
        prompt();
      }, 300);
      return;
    }
    if (trimmed === "echo $$") write(`${shell.id}\r\n`);
    else if (trimmed !== "") write(`bash: ${trimmed.split(" ")[0]}: command not found\r\n`);
    prompt();
  };
  socket.addEventListener("close", () => {
    if (shell.socket === socket) shell.socket = null;
  });
  socket.addEventListener("message", (event) => {
    const data = new Uint8Array(event.data as ArrayBuffer);
    if (!alive()) {
      shell.socket = null;
      socket.close(1000, "");
      return;
    }
    if (!started) {
      // ttyd's first message: JSON with AuthToken, columns and rows; then the shell starts, or
      // its session is joined (tmux redraws its screen: here, a prompt).
      started = true;
      shell.socket = socket;
      write(shell.started ? "\r\n" : `Fake shell ${shell.id} on the computer\r\n`);
      shell.started = true;
      if (shell.waitingFor === null) prompt();
      return;
    }
    if (data[0] === RESIZE) return;
    if (data[0] !== OUTPUT) return;
    for (const ch of decoder.decode(data.subarray(1))) {
      if (ch === "\r") {
        write("\r\n");
        const command = shell.line;
        shell.line = "";
        run(command);
      } else if (ch === "\u007f") {
        if (shell.line.length > 0) {
          shell.line = shell.line.slice(0, -1);
          write("\b \b");
        }
      } else if (ch >= " ") {
        shell.line += ch;
        write(shell.waitingFor === "claude_code" ? "*" : ch);
      }
    }
  });
}
