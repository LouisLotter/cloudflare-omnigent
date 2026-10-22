// The few Workers runtime APIs the harness Worker uses, declared here so it typechecks with
// the repository's scripts configuration (Node types only, `tsc -p scripts`). Wrangler bundles
// the real `cloudflare:workers` module; these shapes follow its types at Wrangler 4.149.0.

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /** Several keys in one atomic write. */
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Several keys in one atomic delete. */
  delete(keys: string[]): Promise<number>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

interface WorkerTcpPort {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

interface WorkerContainer {
  readonly running: boolean;
  start(options: { enableInternet: boolean; env?: Record<string, string> }): void;
  monitor(): Promise<void>;
  destroy(error?: unknown): Promise<void>;
  signal(signo: number): void;
  getTcpPort(port: number): WorkerTcpPort;
}

interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  readonly container?: WorkerContainer;
  waitUntil(promise: Promise<unknown>): void;
}

interface R2Bucket {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

interface DurableObjectNamespace<T> {
  idFromName(name: string): unknown;
  get(id: unknown): T;
}
