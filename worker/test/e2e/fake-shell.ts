/**
 * A fake ttyd 1.7.7 for the local journeys (WP3.5): answers the terminal port's upgrade with a
 * WebSocket speaking ttyd's protocol, and a tiny shell that knows the two sign-in commands. It
 * never contacts a provider: `claude auth login --claudeai` prints a synthetic link and takes a
 * pasted code; `codex login --device-auth` prints a synthetic device code. Each completed sign-in
 * calls `onSignIn`, which makes the fake supervisor's credential watcher publish a login, as the
 * real CLIs' writes do. `echo $$` prints the shell's number, so a journey can tell a reattach
 * (same shell) from a new one. Runs in workerd.
 */

const OUTPUT = 0x30; // ttyd: "0" output (server), "0" input (client)
const RESIZE = 0x31;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let shells = 0;

export interface ShellHooks {
  readonly onSignIn: (provider: "claude" | "codex") => void;
}

/** The terminal port's handler: a 101 with a new shell, as ttyd answers `/ws`. */
export function fakeTtyd(hooks: ShellHooks): (request: Request) => Response {
  return (request) => {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("ttyd's page is never served to the platform", { status: 404 });
    }
    const pair = new WebSocketPair();
    const socket = pair[1];
    socket.accept();
    socket.binaryType = "arraybuffer";
    runShell(socket, hooks);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": "tty" },
    });
  };
}

function runShell(socket: WebSocket, hooks: ShellHooks): void {
  shells += 1;
  const id = 4000 + shells;
  let started = false;
  let line = "";
  let waitingFor: "claude_code" | null = null;
  const write = (text: string) => {
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
    if (waitingFor === "claude_code") {
      waitingFor = null;
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
      waitingFor = "claude_code";
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
    if (trimmed === "echo $$") write(`${id}\r\n`);
    else if (trimmed !== "") write(`bash: ${trimmed.split(" ")[0]}: command not found\r\n`);
    prompt();
  };
  socket.addEventListener("message", (event) => {
    const data = new Uint8Array(event.data as ArrayBuffer);
    if (!started) {
      // ttyd's first message: JSON with AuthToken, columns and rows; then the shell starts.
      started = true;
      write(`Fake shell ${id} on the computer\r\n`);
      prompt();
      return;
    }
    if (data[0] === RESIZE) return;
    if (data[0] !== OUTPUT) return;
    for (const ch of decoder.decode(data.subarray(1))) {
      if (ch === "\r") {
        write("\r\n");
        const command = line;
        line = "";
        run(command);
      } else if (ch === "\u007f") {
        if (line.length > 0) {
          line = line.slice(0, -1);
          write("\b \b");
        }
      } else if (ch >= " ") {
        line += ch;
        write(waitingFor === "claude_code" ? "*" : ch);
      }
    }
  });
}
