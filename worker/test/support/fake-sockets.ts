/**
 * Fake WebSockets for the setup terminal's bridge (WP3.5) in plain Node: a connected pair whose
 * ends deliver to each other synchronously, record what they sent and how they closed, and a
 * fake ttyd that answers the bridge's dial. Web-standard APIs only.
 */
import type { BridgeSocket } from "../../src/computer/terminal.ts";

type Listener = (event: unknown) => void;

export class FakeSocket implements BridgeSocket {
  peer: FakeSocket | null = null;
  accepted = false;
  binaryType = "blob";
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  readonly sent: unknown[] = [];
  readonly received: unknown[] = [];
  readonly #listeners = new Map<string, Listener[]>();
  /** Every send throws (a dead connection). */
  failSends = false;

  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  accept(): void {
    this.accepted = true;
  }

  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: (event: unknown) => void): void;
  // biome-ignore lint/suspicious/noExplicitAny: the implementation of both overloads
  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.failSends) throw new Error("send failed");
    if (this.closed !== null) throw new Error("socket closed");
    this.sent.push(data);
    this.peer?.deliver(data);
  }

  deliver(data: unknown): void {
    if (this.closed !== null) return;
    this.received.push(data);
    this.emit("message", { data });
  }

  close(code?: number, reason?: string): void {
    if (this.closed !== null) return;
    this.closed = { code, reason };
    const peer = this.peer;
    if (peer !== null && peer.closed === null) {
      peer.closed = { code, reason };
      peer.emit("close", { code, reason });
    }
  }

  /** The connection drops under this end (code 1006), as a web Worker deploy drops it. */
  drop(): void {
    if (this.closed !== null) return;
    this.closed = { code: 1006, reason: "" };
    this.emit("close", { code: 1006, reason: "" });
    const peer = this.peer;
    if (peer !== null && peer.closed === null) {
      peer.closed = { code: 1006, reason: "" };
      peer.emit("close", { code: 1006, reason: "" });
    }
  }
}

/** Two connected ends: [the one handed out, the one kept]. */
export function fakePair(name: string): [FakeSocket, FakeSocket] {
  const a = new FakeSocket(`${name}:client`);
  const b = new FakeSocket(`${name}:server`);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A Response that carries a fake socket, as a dialled 101 does (Node cannot build a 101). */
export class SocketResponse extends Response {
  readonly socket: FakeSocket | null;

  constructor(socket: FakeSocket | null) {
    super(socket === null ? "busy" : null, { status: socket === null ? 503 : 200 });
    this.socket = socket;
  }
}

/**
 * ttyd on the computer's terminal port, as the bridge sees it: each dial gets a new shell end,
 * unless `busy` (one client at a time). `shells` keeps the computer-side ends.
 */
export class FakeTtyd {
  readonly shells: FakeSocket[] = [];
  /** Each dial's URL arguments (WP3.28): `new` or `attach`, and the window. */
  readonly dialled: { readonly mode: string; readonly window: number }[] = [];
  busy = 0;
  dials = 0;
  /** Throws on dial, as a dropped container connection does. */
  fail = false;

  dial = async (mode = "new", window = 0): Promise<Response> => {
    this.dials += 1;
    this.dialled.push({ mode, window });
    if (this.fail) throw new Error("Network connection lost.");
    if (this.busy > 0) {
      this.busy -= 1;
      return new SocketResponse(null);
    }
    const [bridgeEnd, shellEnd] = fakePair(`ttyd${this.shells.length}`);
    this.shells.push(shellEnd);
    return new SocketResponse(bridgeEnd);
  };

  /** The newest shell's end. */
  get shell(): FakeSocket {
    const shell = this.shells.at(-1);
    if (shell === undefined) throw new Error("no shell");
    return shell;
  }
}
