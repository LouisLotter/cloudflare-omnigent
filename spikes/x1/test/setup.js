// Node has neither WebSocketPair nor 101 responses. These fakes record what the Worker does with
// each socket (accept, send, close), so a test can tell a bridged socket from one handed on
// without being accepted.

export class FakeSocket {
  constructor(name = "socket") {
    this.name = name;
    this.accepted = false;
    this.sent = [];
    this.listeners = {};
    this.peer = null;
    this.closed = null;
  }

  accept() {
    this.accepted = true;
  }

  addEventListener(type, fn) {
    this.listeners[type] ??= [];
    this.listeners[type].push(fn);
  }

  dispatch(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }

  send(data) {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(data);
    this.peer?.dispatch("message", { data });
  }

  close(code, reason) {
    if (this.closed) throw new Error("already closed");
    this.closed = { code, reason };
  }
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const client = new FakeSocket("client");
    const server = new FakeSocket("server");
    client.peer = server;
    server.peer = client;
    this[0] = client;
    this[1] = server;
  }
};

const RealResponse = globalThis.Response;

/** A Response that, like the Workers runtime's, allows status 101 with a webSocket. */
class WorkersResponse extends RealResponse {
  constructor(body, init = {}) {
    if (init?.status === 101) {
      super(body, { ...init, status: 200 });
      Object.defineProperty(this, "status", { value: 101 });
    } else {
      super(body, init);
    }
    this.webSocket = init?.webSocket ?? null;
  }

  static json(data, init) {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    return new WorkersResponse(JSON.stringify(data), { ...init, headers });
  }
}

globalThis.Response = WorkersResponse;
