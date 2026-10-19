// Minimal Chrome DevTools protocol client over Node's built-in WebSocket; no dependencies.

import { type ChildProcess, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { sleep } from "./lib.ts";

const CHROME = process.env.S7_CHROME ?? "/usr/bin/chromium";
const DEBUG_PORT = 9333;

export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  private readonly socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: unknown;
      };
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message.result ?? { error: message.error });
        this.pending.delete(message.id);
      }
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return (result.result as { value?: unknown } | undefined)?.value;
  }
  close(): void {
    this.socket.close();
  }
}

export interface Browser {
  readonly cdp: Cdp;
  readonly close: () => Promise<void>;
}

/** Starts headless Chromium with a throwaway profile and attaches to its first page. */
export async function openBrowser(profile: string): Promise<Browser> {
  rmSync(profile, { recursive: true, force: true });
  const chrome: ChildProcess = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,1300",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const close = async () => {
    chrome.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  };
  let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
  for (let i = 0; i < 50 && targets.length === 0; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      if (res.ok) targets = (await res.json()) as typeof targets;
    } catch {
      // not up yet
    }
    if (targets.length === 0) await sleep(200);
  }
  const page = targets.find((t) => t.type === "page");
  if (!page) {
    await close();
    throw new Error("Chromium did not start");
  }
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  const cdp = new Cdp(socket);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 1300,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return {
    cdp,
    close: async () => {
      cdp.close();
      await close();
    },
  };
}
