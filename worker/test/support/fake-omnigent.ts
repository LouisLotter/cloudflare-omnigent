/**
 * In-memory fake of the Omnigent HTTP API routes the platform calls, for Worker tests. It uses only
 * web-standard APIs, so it runs in Node and in workerd: `fake.fetch` is a
 * `(request: Request) => Promise<Response>` handler to hand to the code under test in place of its
 * Omnigent fetcher.
 *
 * Response bodies use Omnigent's own field names, taken from omnigent commit 90a9bed9a; each shape
 * cites its source, relative to the omnigent repository. Timestamps are Unix epoch seconds, except
 * `next_run_at`, which is an ISO 8601 string from the live scheduler.
 *
 * Modelled: a caller identity per request (none: 401, as `require_user` does), owner scoping
 * (another user's task is a 404), run ordering and cursor pagination, query and body validation
 * (FastAPI's 422), and the sharing route's admin check, validation and editability rules.
 *
 * Not modelled: RRULE evaluation (`next_run_at` is whatever the test sets) and the scheduler. "Run
 * now" records a `running` run at once, where Omnigent records it from a background task; inject a
 * 409 or 503 fault for "already in flight" or "scheduler not running". Routes that create, edit or
 * delete tasks are absent: tests change state through the fake's methods.
 *
 * Faults are injected per route, or for every request with "*": a delay, an error status, or a
 * dropped request or response. Every request is logged, including those to unknown routes.
 */

export const FAKE_OMNIGENT_ROUTES = [
  "GET /v1/me",
  "GET /v1/scheduled-tasks",
  "GET /v1/scheduled-tasks/{id}",
  "GET /v1/scheduled-tasks/{id}/runs",
  "POST /v1/scheduled-tasks/{id}/run",
  "GET /v1/sharing",
  "PUT /v1/sharing",
] as const;

export type FakeOmnigentRoute = (typeof FAKE_OMNIGENT_ROUTES)[number];

// ---------------------------------------------------------------------------------------------
// Wire shapes

/** `GET /v1/me`: omnigent/server/app.py:3197-3247. */
export interface MeJson {
  user_id: string | null;
  is_admin: boolean;
}

/** Run status values: omnigent/entities/scheduled_task.py:109-110. */
export type ScheduledRunStatus = "scheduled" | "running" | "succeeded" | "failed" | "skipped";

/** `_to_response`: omnigent/server/routes/scheduled_tasks.py:140-182. */
export interface ScheduledTaskJson {
  id: string;
  name: string;
  prompt: string;
  rrule: string;
  owner_user_id: string | null;
  agent_id: string;
  timezone: string;
  created_at: number;
  model_override: string | null;
  reasoning_effort: string | null;
  permission_mode: string | null;
  max_cost_usd: number | null;
  workspace: string | null;
  host_id: string | null;
  execution_target: string;
  /** "active" or "paused" through the API: omnigent/entities/scheduled_task.py:66-67. */
  state: string;
  last_run_at: number | null;
  /** The newest run's status: sqlalchemy_store.py:554-575 orders by scheduled_at, id DESC. */
  last_run_status: ScheduledRunStatus | null;
  last_run_conversation_id: string | null;
  /** ISO 8601 or null: omnigent/server/scheduled/scheduler.py:210-215. */
  next_run_at: string | null;
  updated_at: number | null;
}

/** `_run_to_response`: omnigent/server/routes/scheduled_tasks.py:185-200. */
export interface ScheduledTaskRunJson {
  id: string;
  scheduled_task_id: string;
  status: ScheduledRunStatus;
  scheduled_at: number;
  conversation_id: string | null;
  fired_at: number | null;
  finished_at: number | null;
  error_code: string | null;
}

/** `GET /v1/scheduled-tasks`: omnigent/server/routes/scheduled_tasks.py:443-452. */
export interface ScheduledTaskListJson {
  scheduled_tasks: ScheduledTaskJson[];
}

/** `GET /v1/scheduled-tasks/{id}/runs`: omnigent/server/routes/scheduled_tasks.py:506-509. */
export interface ScheduledTaskRunsJson {
  runs: ScheduledTaskRunJson[];
  next_cursor: string | null;
}

/** `POST /v1/scheduled-tasks/{id}/run`, status 202: scheduled_tasks.py:511, 552. */
export interface RunNowJson {
  triggered: true;
  id: string;
}

/** omnigent/server/auth.py:145-148; offered most permissive first (sharing.py:37-42). */
export type SharingMode = "on" | "read_only" | "restricted_read_only" | "off";
/** omnigent/server/sharing_settings.py:68-72. */
export type PublicSharingMaxLevel = "read" | "edit";
/** omnigent/server/sharing_settings.py:128-141. */
export type DefaultPublicSessions = "off" | "sandbox" | "all";

/** `_state_response`, for both GET and PUT: omnigent/server/routes/sharing.py:60-88. */
export interface SharingJson {
  object: "sharing";
  sharing_mode: SharingMode;
  editable: boolean;
  options: SharingMode[];
  public_sharing_enabled: boolean;
  public_sharing_editable: boolean;
  public_sharing_max_level: PublicSharingMaxLevel;
  public_sharing_max_level_editable: boolean;
  public_sharing_max_level_options: PublicSharingMaxLevel[];
  default_public_sessions: DefaultPublicSessions;
  default_public_sessions_editable: boolean;
  default_public_sessions_options: DefaultPublicSessions[];
}

/** `PUT /v1/sharing` body: omnigent/server/routes/sharing.py:45-56. */
export interface SetSharingJson {
  sharing_mode?: string | null;
  public_sharing?: boolean | null;
  public_sharing_max_level?: string | null;
  default_public_sessions?: string | null;
}

/** Application errors: omnigent/server/app.py:2381-2384; codes at omnigent/errors.py:238-246. */
export interface OmnigentErrorJson {
  error: { code: string; message: string };
}

/** FastAPI's stock 422 body (omnigent/server/app.py:2386-2409 delegates to it). */
export interface ValidationErrorJson {
  detail: { type: string; loc: (string | number)[]; msg: string; input: unknown }[];
}

// ---------------------------------------------------------------------------------------------
// Fake state, faults and log

/** A stored task: the response without `last_run_status`, which is derived from the runs. */
export type FakeScheduledTask = Omit<ScheduledTaskJson, "last_run_status">;

export interface FakeIdentity {
  readonly userId: string;
  readonly isAdmin: boolean;
}

/** The default caller, and the default owner of seeded tasks. */
export const FAKE_OWNER: FakeIdentity = { userId: "owner@example.test", isAdmin: true };

const SHARING_MODES: readonly SharingMode[] = ["on", "read_only", "restricted_read_only", "off"];
const PUBLIC_LEVELS: readonly PublicSharingMaxLevel[] = ["read", "edit"];
const DEFAULT_PUBLIC: readonly DefaultPublicSessions[] = ["off", "sandbox", "all"];

/** A standard OSS start: every setting file-backed and editable, defaults as documented. */
export const DEFAULT_SHARING: Readonly<SharingJson> = {
  object: "sharing",
  sharing_mode: "on",
  editable: true,
  options: [...SHARING_MODES],
  public_sharing_enabled: false,
  public_sharing_editable: true,
  public_sharing_max_level: "read",
  public_sharing_max_level_editable: true,
  public_sharing_max_level_options: [...PUBLIC_LEVELS],
  default_public_sessions: "off",
  default_public_sessions_editable: true,
  default_public_sessions_options: [...DEFAULT_PUBLIC],
};

export interface FakeOmnigentFault {
  /** Wait this long, through the `sleep` option, before anything else happens. */
  readonly delayMs?: number;
  /** Answer with this status (400-599) instead of handling the request: nothing changes. */
  readonly status?: number;
  /** Body for `status`: a string is sent as text. Default: Omnigent's error body for the status. */
  readonly body?: unknown;
  /**
   * Lose the request before it is handled (nothing changes), or the response after it was handled
   * (the change is applied). Either way the fetch rejects with `FakeOmnigentDroppedError`.
   */
  readonly drop?: "request" | "response";
  /** Affect this many matching requests, then clear. Default: until `clearFaults`. */
  readonly times?: number;
}

export interface FakeOmnigentRequest {
  /** 1-based arrival order. */
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  /** The query string, including "?", or "". */
  readonly search: string;
  /** null for a path or method the fake does not serve. */
  readonly route: FakeOmnigentRoute | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON, or the raw text if it is not JSON; null without a body. */
  readonly body: unknown;
  readonly fault: FakeOmnigentFault | null;
  /** "pending" while a delayed request waits. */
  readonly outcome: "pending" | "responded" | "dropped";
  /** The status sent, or that would have been sent for a dropped response; else null. */
  readonly status: number | null;
}

export class FakeOmnigentDroppedError extends Error {
  override readonly name = "FakeOmnigentDroppedError";
  readonly phase: "request" | "response";

  constructor(phase: "request" | "response", method: string, path: string) {
    super(`fake Omnigent dropped the ${phase} for ${method} ${path}`);
    this.phase = phase;
  }
}

export interface FakeOmnigentOptions {
  /** Who is calling. Default: every request is FAKE_OWNER. Return null for no valid login. */
  readonly identify?: (request: Request) => FakeIdentity | null;
  /** Clock in Unix epoch seconds. Default: the system clock. */
  readonly now?: () => number;
  /** How a delay fault waits. Default: setTimeout. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Initial sharing settings, over DEFAULT_SHARING. */
  readonly sharing?: Partial<Omit<SharingJson, "object">>;
}

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

interface RouteMatch {
  readonly route: FakeOmnigentRoute;
  readonly taskId: string | null;
}

const ROUTE_TABLE: readonly { method: string; pattern: RegExp; route: FakeOmnigentRoute }[] = [
  { method: "GET", pattern: /^\/v1\/me$/, route: "GET /v1/me" },
  { method: "GET", pattern: /^\/v1\/scheduled-tasks$/, route: "GET /v1/scheduled-tasks" },
  {
    method: "GET",
    pattern: /^\/v1\/scheduled-tasks\/([^/]+)$/,
    route: "GET /v1/scheduled-tasks/{id}",
  },
  {
    method: "GET",
    pattern: /^\/v1\/scheduled-tasks\/([^/]+)\/runs$/,
    route: "GET /v1/scheduled-tasks/{id}/runs",
  },
  {
    method: "POST",
    pattern: /^\/v1\/scheduled-tasks\/([^/]+)\/run$/,
    route: "POST /v1/scheduled-tasks/{id}/run",
  },
  { method: "GET", pattern: /^\/v1\/sharing$/, route: "GET /v1/sharing" },
  { method: "PUT", pattern: /^\/v1\/sharing$/, route: "PUT /v1/sharing" },
];

/** Default error codes for injected statuses: omnigent/errors.py:272-298. */
const ERROR_CODE_FOR_STATUS: Readonly<Record<number, string>> = {
  400: "invalid_input",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  500: "internal_error",
  503: "runner_unavailable",
};

export class FakeOmnigent {
  /** The fetch handler. Bound, so it can be passed around on its own. */
  readonly fetch = (request: Request): Promise<Response> => this.#handle(request);

  readonly #identify: (request: Request) => FakeIdentity | null;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #tasks = new Map<string, FakeScheduledTask>();
  readonly #runs = new Map<string, ScheduledTaskRunJson>();
  readonly #faults = new Map<FakeOmnigentRoute | "*", { fault: FakeOmnigentFault; left: number }>();
  #sharing: SharingJson;
  #requests: Mutable<FakeOmnigentRequest>[] = [];
  #lastId = 0;

  constructor(options: FakeOmnigentOptions = {}) {
    this.#identify = options.identify ?? (() => FAKE_OWNER);
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#sharing = structuredClone({ ...DEFAULT_SHARING, ...options.sharing, object: "sharing" });
  }

  // ----- Request log

  /** Every request so far, in arrival order. Entries update as delayed requests complete. */
  get requests(): readonly FakeOmnigentRequest[] {
    return [...this.#requests];
  }

  requestsTo(route: FakeOmnigentRoute): FakeOmnigentRequest[] {
    return this.#requests.filter((entry) => entry.route === route);
  }

  clearRequests(): void {
    this.#requests = [];
  }

  // ----- Faults

  /** Sets the fault for a route, or for every request with "*"; a route's own fault wins. */
  inject(route: FakeOmnigentRoute | "*", fault: FakeOmnigentFault): void {
    const { delayMs, status, drop, times } = fault;
    if (delayMs !== undefined && !(Number.isFinite(delayMs) && delayMs >= 0)) {
      throw new TypeError("delayMs must be a non-negative number");
    }
    if (status !== undefined && !(Number.isInteger(status) && status >= 400 && status <= 599)) {
      throw new TypeError("status must be an integer from 400 to 599");
    }
    if (status !== undefined && drop !== undefined) {
      throw new TypeError("a fault cannot both answer with a status and drop");
    }
    if (times !== undefined && !(Number.isInteger(times) && times > 0)) {
      throw new TypeError("times must be a positive integer");
    }
    this.#faults.set(route, { fault: { ...fault }, left: times ?? Number.POSITIVE_INFINITY });
  }

  /** Clears one route's fault, or every fault. */
  clearFaults(route?: FakeOmnigentRoute | "*"): void {
    if (route === undefined) this.#faults.clear();
    else this.#faults.delete(route);
  }

  // ----- Scheduled tasks and runs

  /** Adds a task. Unset fields get defaults; the owner defaults to FAKE_OWNER. */
  addTask(seed: Partial<FakeScheduledTask> = {}): FakeScheduledTask {
    const task: FakeScheduledTask = {
      id: this.#newId(),
      name: "Scheduled task",
      prompt: "Summarise the day.",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      owner_user_id: FAKE_OWNER.userId,
      agent_id: "ag_fake",
      timezone: "UTC",
      created_at: this.#now(),
      model_override: null,
      reasoning_effort: null,
      permission_mode: null,
      max_cost_usd: null,
      workspace: null,
      host_id: null,
      execution_target: "connected_host",
      state: "active",
      last_run_at: null,
      last_run_conversation_id: null,
      next_run_at: null,
      updated_at: null,
      ...seed,
    };
    if (this.#tasks.has(task.id)) throw new Error(`task ${task.id} already exists`);
    this.#tasks.set(task.id, task);
    return { ...task };
  }

  /**
   * Changes a task as an edit through Omnigent would. `updated_at` becomes the current time when
   * anything changed, unless the patch sets it.
   */
  updateTask(id: string, patch: Partial<Omit<FakeScheduledTask, "id">>): FakeScheduledTask {
    const task = this.#requireTask(id);
    const changed = (Object.keys(patch) as (keyof typeof patch)[]).some(
      (key) => task[key] !== patch[key],
    );
    Object.assign(task, changed ? { updated_at: this.#now() } : {}, patch);
    return { ...task };
  }

  /** Deletes a task and its runs. */
  deleteTask(id: string): void {
    this.#requireTask(id);
    this.#tasks.delete(id);
    for (const run of this.#runs.values()) {
      if (run.scheduled_task_id === id) this.#runs.delete(run.id);
    }
  }

  task(id: string): FakeScheduledTask | undefined {
    const task = this.#tasks.get(id);
    return task === undefined ? undefined : { ...task };
  }

  /** All tasks, in Omnigent's list order: created_at, then id (sqlalchemy_store.py:199). */
  tasks(): FakeScheduledTask[] {
    return [...this.#tasks.values()]
      .sort((left, right) => left.created_at - right.created_at || compare(left.id, right.id))
      .map((task) => ({ ...task }));
  }

  /** Adds a run record. It does not change the task: set `last_run_at` with `updateTask`. */
  addRun(
    taskId: string,
    seed: Partial<Omit<ScheduledTaskRunJson, "scheduled_task_id">> = {},
  ): ScheduledTaskRunJson {
    this.#requireTask(taskId);
    const now = this.#now();
    const run: ScheduledTaskRunJson = {
      id: this.#newId(),
      scheduled_task_id: taskId,
      status: "succeeded",
      scheduled_at: now,
      conversation_id: null,
      fired_at: now,
      finished_at: null,
      error_code: null,
      ...seed,
    };
    if (this.#runs.has(run.id)) throw new Error(`run ${run.id} already exists`);
    this.#runs.set(run.id, run);
    return { ...run };
  }

  updateRun(id: string, patch: Partial<Omit<ScheduledTaskRunJson, "id">>): ScheduledTaskRunJson {
    const run = this.#runs.get(id);
    if (run === undefined) throw new Error(`no run ${id}`);
    Object.assign(run, patch);
    return { ...run };
  }

  /** A task's runs, newest first: scheduled_at, then id, descending (sqlalchemy_store.py:424). */
  runs(taskId: string): ScheduledTaskRunJson[] {
    return [...this.#runs.values()]
      .filter((run) => run.scheduled_task_id === taskId)
      .sort((left, right) => right.scheduled_at - left.scheduled_at || compare(right.id, left.id))
      .map((run) => ({ ...run }));
  }

  // ----- Sharing

  get sharing(): SharingJson {
    return structuredClone(this.#sharing);
  }

  /** Changes the server's sharing state directly, for example to make settings non-editable. */
  setSharing(patch: Partial<Omit<SharingJson, "object">>): SharingJson {
    this.#sharing = structuredClone({ ...this.#sharing, ...patch, object: "sharing" });
    return this.sharing;
  }

  // ----- Handling

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const match = matchRoute(request.method, url.pathname);
    const entry: Mutable<FakeOmnigentRequest> = {
      seq: this.#requests.length + 1,
      method: request.method,
      path: url.pathname,
      search: url.search,
      route: match instanceof Response ? null : match.route,
      headers: Object.fromEntries(request.headers),
      body: parseLoggedBody(text),
      fault: null,
      outcome: "pending",
      status: null,
    };
    this.#requests.push(entry);

    const fault = this.#takeFault(entry.route);
    entry.fault = fault;
    if (fault?.delayMs !== undefined) await this.#sleep(fault.delayMs);
    if (fault?.drop === "request") {
      entry.outcome = "dropped";
      throw new FakeOmnigentDroppedError("request", request.method, url.pathname);
    }

    let response: Response;
    if (fault?.status !== undefined) response = faultResponse(fault.status, fault.body);
    else if (match instanceof Response) response = match;
    else response = this.#route(match, request, url, text);

    entry.status = response.status;
    if (fault?.drop === "response") {
      entry.outcome = "dropped";
      throw new FakeOmnigentDroppedError("response", request.method, url.pathname);
    }
    entry.outcome = "responded";
    return response;
  }

  #takeFault(route: FakeOmnigentRoute | null): FakeOmnigentFault | null {
    const key = route !== null && this.#faults.has(route) ? route : "*";
    const slot = this.#faults.get(key);
    if (slot === undefined) return null;
    slot.left -= 1;
    if (slot.left <= 0) this.#faults.delete(key);
    return slot.fault;
  }

  #route(match: RouteMatch, request: Request, url: URL, text: string): Response {
    const identity = this.#identify(request);
    switch (match.route) {
      case "GET /v1/me":
        return json(
          identity === null
            ? { user_id: null, is_admin: false }
            : { user_id: identity.userId, is_admin: identity.isAdmin },
        );
      case "GET /v1/scheduled-tasks": {
        if (identity === null) return unauthorized();
        const tasks = this.tasks().filter((task) => task.owner_user_id === identity.userId);
        const body: ScheduledTaskListJson = {
          scheduled_tasks: tasks.map((task) => this.#taskJson(task)),
        };
        return json(body);
      }
      case "GET /v1/scheduled-tasks/{id}": {
        if (identity === null) return unauthorized();
        const task = this.#ownedTask(match.taskId, identity);
        return task === undefined ? taskNotFound() : json(this.#taskJson(task));
      }
      case "GET /v1/scheduled-tasks/{id}/runs":
        return this.#listRuns(match.taskId, identity, url.searchParams);
      case "POST /v1/scheduled-tasks/{id}/run":
        return this.#runNow(match.taskId, identity);
      case "GET /v1/sharing":
        return this.#adminCheck(identity) ?? json(this.sharing);
      case "PUT /v1/sharing":
        return this.#putSharing(identity, text);
    }
  }

  /** omnigent/server/routes/scheduled_tasks.py:473-509; ordering and cursor at
   * omnigent/stores/scheduled_task_store/sqlalchemy_store.py:417-465. */
  #listRuns(
    taskId: string | null,
    identity: FakeIdentity | null,
    query: URLSearchParams,
  ): Response {
    // FastAPI validates query parameters before the handler runs.
    const rawLimit = query.get("limit");
    let limit = 100;
    if (rawLimit !== null) {
      if (!/^[+-]?\d+$/.test(rawLimit.trim())) {
        return validationError("int_parsing", ["query", "limit"], rawLimit, INT_PARSING);
      }
      limit = Number(rawLimit);
      if (limit < 1) {
        return validationError("greater_than_equal", ["query", "limit"], rawLimit, GE_1);
      }
      if (limit > 1000) {
        return validationError("less_than_equal", ["query", "limit"], rawLimit, LE_1000);
      }
    }
    if (identity === null) return unauthorized();
    const task = this.#ownedTask(taskId, identity);
    if (task === undefined) return taskNotFound();
    let runs = this.runs(task.id);
    const after = query.get("after");
    if (after !== null) {
      // An unknown cursor matches nothing in Omnigent's keyset query, so the page is empty.
      const index = runs.findIndex((run) => run.id === after);
      runs = index === -1 ? [] : runs.slice(index + 1);
    }
    const page = runs.slice(0, limit);
    const body: ScheduledTaskRunsJson = {
      runs: page,
      next_cursor: runs.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
    return json(body);
  }

  /** omnigent/server/routes/scheduled_tasks.py:511-552; the record mirrors
   * omnigent/server/scheduled/fire.py:982-1007, which also bumps `updated_at`. */
  #runNow(taskId: string | null, identity: FakeIdentity | null): Response {
    if (identity === null) return unauthorized();
    const task = this.#ownedTask(taskId, identity);
    if (task === undefined) return taskNotFound();
    const now = this.#now();
    const conversationId = `conv_${this.#newId()}`;
    this.updateTask(task.id, { last_run_at: now, last_run_conversation_id: conversationId });
    this.addRun(task.id, {
      status: "running",
      scheduled_at: now,
      fired_at: now,
      conversation_id: conversationId,
    });
    const body: RunNowJson = { triggered: true, id: task.id };
    return json(body, 202);
  }

  /** `_require_admin`: omnigent/server/routes/sharing.py:91-111. */
  #adminCheck(identity: FakeIdentity | null): Response | null {
    if (identity === null) return unauthorized();
    if (!identity.isAdmin) {
      return omnigentError(
        403,
        "forbidden",
        "Admin privileges required to manage sharing settings",
      );
    }
    return null;
  }

  /** omnigent/server/routes/sharing.py:127-222: validate and authorize every field, then write. */
  #putSharing(identity: FakeIdentity | null, text: string): Response {
    const parsed = parseSetSharing(text);
    if (parsed instanceof Response) return parsed;
    const denied = this.#adminCheck(identity);
    if (denied !== null) return denied;
    const state = this.#sharing;
    const { sharing_mode, public_sharing, public_sharing_max_level, default_public_sessions } =
      parsed;
    if (
      sharing_mode == null &&
      public_sharing == null &&
      public_sharing_max_level == null &&
      default_public_sessions == null
    ) {
      return invalidInput("No sharing settings to update.");
    }
    const next: Partial<SharingJson> = {};
    if (sharing_mode != null) {
      if (!state.editable) {
        return forbidden("Sharing mode is managed by this deployment and cannot be changed here.");
      }
      const mode = SHARING_MODES.find((value) => value === sharing_mode.trim().toLowerCase());
      if (mode === undefined) {
        return invalidInput(
          `Unknown sharing mode '${sharing_mode}'. Expected one of: ${SHARING_MODES.join(", ")}.`,
        );
      }
      next.sharing_mode = mode;
    }
    if (public_sharing != null) {
      if (!state.public_sharing_editable) {
        return forbidden("Public access is managed by this deployment and cannot be changed here.");
      }
      next.public_sharing_enabled = public_sharing;
    }
    if (public_sharing_max_level != null) {
      if (!state.public_sharing_max_level_editable) {
        return forbidden("Public permission ceiling is managed by this deployment.");
      }
      const level = PUBLIC_LEVELS.find(
        (value) => value === public_sharing_max_level.trim().toLowerCase(),
      );
      if (level === undefined)
        return invalidInput("Public permission ceiling must be read or edit.");
      // Omnigent offers "edit" exactly when public edit is available (sharing.py:74-78, 182-187).
      if (!state.public_sharing_max_level_options.includes(level)) {
        return forbidden("Public edit access requires authenticated multi-user access.");
      }
      next.public_sharing_max_level = level;
    }
    if (default_public_sessions != null) {
      if (!state.default_public_sessions_editable) {
        return forbidden(
          "Default public sessions is managed by this deployment and cannot be changed here.",
        );
      }
      const value = DEFAULT_PUBLIC.find(
        (option) => option === default_public_sessions.trim().toLowerCase(),
      );
      if (value === undefined) {
        return invalidInput(
          `Unknown default_public_sessions '${default_public_sessions}'. ` +
            `Expected one of: ${DEFAULT_PUBLIC.join(", ")}.`,
        );
      }
      next.default_public_sessions = value;
    }
    return json(this.setSharing(next));
  }

  #taskJson(task: FakeScheduledTask): ScheduledTaskJson {
    const { last_run_at, last_run_conversation_id, next_run_at, updated_at, ...head } = task;
    return {
      ...head,
      last_run_at,
      last_run_status: this.runs(task.id)[0]?.status ?? null,
      last_run_conversation_id,
      next_run_at,
      updated_at,
    };
  }

  /** `_require_owned`: another user's task is a 404, not a 403 (scheduled_tasks.py:355-364). */
  #ownedTask(taskId: string | null, identity: FakeIdentity): FakeScheduledTask | undefined {
    const task = taskId === null ? undefined : this.#tasks.get(taskId);
    return task?.owner_user_id === identity.userId ? task : undefined;
  }

  #requireTask(id: string): FakeScheduledTask {
    const task = this.#tasks.get(id);
    if (task === undefined) throw new Error(`no task ${id}`);
    return task;
  }

  /** Omnigent ids are bare 32-character hex strings; these count up, for stable tests. */
  #newId(): string {
    this.#lastId += 1;
    return this.#lastId.toString(16).padStart(32, "0");
  }
}

function matchRoute(method: string, path: string): RouteMatch | Response {
  let pathMatched = false;
  const allowed: string[] = [];
  for (const entry of ROUTE_TABLE) {
    const found = entry.pattern.exec(path);
    if (found === null) continue;
    pathMatched = true;
    allowed.push(entry.method);
    if (entry.method === method) {
      const id = found[1];
      return { route: entry.route, taskId: id === undefined ? null : decodeURIComponent(id) };
    }
  }
  // Starlette's defaults for an unknown path or method.
  if (!pathMatched) return json({ detail: "Not Found" }, 404);
  return Response.json(
    { detail: "Method Not Allowed" },
    { status: 405, headers: { allow: allowed.join(", ") } },
  );
}

function parseSetSharing(text: string): SetSharingJson | Response {
  if (text.trim() === "") return validationError("missing", ["body"], null, "Field required");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return validationError("json_invalid", ["body"], text, "JSON decode error");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validationError("model_attributes_type", ["body"], body, NOT_AN_OBJECT);
  }
  const record = body as Record<string, unknown>;
  for (const key of ["sharing_mode", "public_sharing_max_level", "default_public_sessions"]) {
    const value = record[key];
    if (value != null && typeof value !== "string") {
      return validationError("string_type", ["body", key], value, "Input should be a valid string");
    }
  }
  const publicSharing = record.public_sharing;
  if (publicSharing != null && typeof publicSharing !== "boolean") {
    return validationError("bool_type", ["body", "public_sharing"], publicSharing, NOT_A_BOOLEAN);
  }
  // Unknown fields are ignored: the request model does not forbid extras.
  return record as SetSharingJson;
}

function parseLoggedBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function omnigentError(status: number, code: string, message: string): Response {
  const body: OmnigentErrorJson = { error: { code, message } };
  return json(body, status);
}

const unauthorized = (): Response => omnigentError(401, "unauthorized", "Authentication required");
const taskNotFound = (): Response => omnigentError(404, "not_found", "Scheduled task not found");
const invalidInput = (message: string): Response => omnigentError(400, "invalid_input", message);
const forbidden = (message: string): Response => omnigentError(403, "forbidden", message);

// Pydantic's messages for the validation errors the fake reproduces.
const INT_PARSING = "Input should be a valid integer, unable to parse string as an integer";
const GE_1 = "Input should be greater than or equal to 1";
const LE_1000 = "Input should be less than or equal to 1000";
const NOT_AN_OBJECT = "Input should be a valid dictionary or object to extract fields from";
const NOT_A_BOOLEAN = "Input should be a valid boolean";

function validationError(
  type: string,
  loc: (string | number)[],
  input: unknown,
  msg: string,
): Response {
  const body: ValidationErrorJson = { detail: [{ type, loc, msg, input }] };
  return json(body, 422);
}

function faultResponse(status: number, body: unknown): Response {
  if (typeof body === "string") return new Response(body, { status });
  if (body !== undefined) return json(body, status);
  const code =
    ERROR_CODE_FOR_STATUS[status] ?? (status >= 500 ? "internal_error" : "invalid_input");
  return omnigentError(status, code, `Injected fault: ${status}`);
}
