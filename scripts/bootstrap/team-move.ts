// Moving a finished installation's team of one behind Access (WP8.11, owner decisions D50, D60):
// what `bootstrap.ts update --team-admission members` does besides an ordinary update. Pure apart
// from the ports it is given (the update's context): tests drive it with the fake Cloudflare.
//
// One run, journaled step by step (`journal.team`), each step repeated by a later run only if its
// confirmation was never recorded:
//   1. before the update's deploy: the member group (team-admission.ts, the owner's address only)
//      and the reconciler's token; the deploy then carries the team's settings (the identity
//      envelope on, the admission reconciler on, the recorded group) and three secrets: the
//      token, the server's identity mode `bind`, and the move's ID (`CFO_TEAM_MOVE`), which keeps
//      the watchdog reporting the team's binding state on every check. The web Worker keeps owner
//      admission, so the owner's pages (their password among them) stay theirs meanwhile;
//   2. the update's own check and acceptance, with its restore point and read-only window: the
//      fork's migrations run there, and `update --rollback` goes back inside the window;
//   3. after the acceptance, the owner signs in to Omnigent once in a browser: the founding
//      binding. The move waits for the status line to show every active owner bound, the
//      member group reconciled to the server's admission revision, and this computer's host
//      connected through Access with a sign-in bound to the owner. A host whose sign-in no member
//      is bound to (the One Client's identity differs from the browser's) stops the move here,
//      at `bind`, which keeps it working, and the run says so;
//   4. `required`, one secrets change (the server restarts on it): the same checks again, from a
//      server started with it, this computer's host reconnected;
//   5. the web Worker in members admission, then the hostname's Access application allowing the
//      member group instead of the owner's address (the group holds the owner alone until
//      someone is invited), read back and checked; then the move's secret is deleted.
// Never: an address, an Access subject or a secret value in the journal or the log.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TeamStatusReport } from "../../contracts/src/team.ts";
import { IDENTITY_MODE_VAR, TEAM_MOVE_SECRET } from "../../worker/src/server/team-move.ts";
import { ownerOnlyProblems, pinCheck } from "./access.ts";
import { type AccessApi, AccessRefusal, AccessUnavailable } from "./access-app.ts";
import { writableApp } from "./devices.ts";
import type { RecordedToken } from "./r2-token.ts";
import type { Installation } from "./settings.ts";
import { memberPolicy, type RecordedMemberGroup, teamAdmissionVars } from "./team-admission.ts";

/** The secret the reconciler's token lives in, in the platform Worker only. */
export const ACCESS_GROUP_TOKEN_SECRET = "CFO_ACCESS_GROUP_TOKEN";
export { IDENTITY_MODE_VAR, TEAM_MOVE_SECRET };

/** The journal's record of the team's move behind Access. IDs and times; never an address. */
export interface TeamRecord {
  /** The move's ID, `CFO_TEAM_MOVE`'s value while it is under way. */
  readonly id: string;
  readonly startedAt: string;
  /** The member group (team-admission.ts). */
  readonly memberGroup?: RecordedMemberGroup;
  /** The reconciler's token: its ID, never its value. */
  readonly token?: RecordedToken;
  /** Tokens made for the move whose value never reached the Worker: delete them. */
  readonly tokensToDelete?: readonly RecordedToken[];
  /** The host checked before `required`, by ID; `none` when the owner said there is none. */
  readonly hostId?: string;
  /** The move stopped at `bind`: why, for the next run to say. */
  readonly stoppedAt?: string;
  readonly stopped?: string;
  readonly boundAt?: string;
  readonly requiredStartedAt?: string;
  /** The platform version the `required` change made. */
  readonly requiredVersionId?: string;
  readonly requiredAt?: string;
  readonly webStartedAt?: string;
  readonly webAt?: string;
  readonly policyStartedAt?: string;
  readonly policyAt?: string;
  readonly finishedAt?: string;
}

/** The recorded member group's ID, once the move has one: the Access checks accept its rule. */
export function memberGroupIdOf(team: TeamRecord | undefined): string | undefined {
  return team?.memberGroup?.id;
}

/** Whether the web Worker is rendered with members admission: from the move's web step on. */
export function webAdmitsMembers(team: TeamRecord | undefined): boolean {
  return team?.webStartedAt !== undefined;
}

/**
 * The platform Worker's team variables once the member group is recorded (team-admission.ts's
 * `teamAdmissionVars`), and the web Worker's from the move's web step. The identity mode is a
 * secret, changed on its own (`bind`, then `required`).
 */
export function teamVars(
  team: TeamRecord | undefined,
  accountId: string,
): { readonly platform: Record<string, string>; readonly web: Record<string, string> } {
  const groupId = memberGroupIdOf(team);
  if (groupId === undefined) return { platform: {}, web: {} };
  const vars = teamAdmissionVars({ accountId }, groupId);
  return { platform: { ...vars.platform }, web: webAdmitsMembers(team) ? { ...vars.web } : {} };
}

// ---------------------------------------------------------------------------------------------
// This computer's host

const HOST_ID = /^[0-9a-f]{32}$/;

/** A host ID in the form Omnigent stores it: 32 lowercase hex digits (dashes dropped). */
export function normalHostId(value: string): string | undefined {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/^host_/, "")
    .replaceAll("-", "");
  return HOST_ID.test(id) ? id : undefined;
}

/**
 * Where this computer's platform-managed Omnigent host keeps its configuration, as
 * `scripts/host/omnigent-host.sh` sets it up: `$OMNIGENT_CONFIG_HOME/config.yaml` when that is
 * set explicitly, else `${XDG_CONFIG_HOME:-$HOME/.config}/omnigent-cfo/config.yaml`.
 */
export function hostConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env.OMNIGENT_CONFIG_HOME?.trim();
  if (explicit) return join(explicit, "config.yaml");
  const config = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(config, "omnigent-cfo", "config.yaml");
}

/**
 * This computer's Omnigent host ID, read from the platform-managed host's configuration
 * (`host.host_id` at `hostConfigPath`), or undefined when there is none. Reads that one value;
 * nothing else of the file is kept or shown.
 */
export function localHostId(
  env: Readonly<Record<string, string | undefined>> = process.env,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string | undefined {
  let text: string;
  try {
    text = read(hostConfigPath(env));
  } catch {
    return undefined;
  }
  let inHost = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inHost = /^host:\s*$/.test(line);
    const match = inHost ? /^\s+host_id:\s*["']?([^"'\s#]+)["']?\s*(#.*)?$/.exec(line) : null;
    if (match?.[1] !== undefined) return normalHostId(match[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// What the status line says, and what the move decides from it

/** The team fields of one status line (worker/src/server/team-move.ts, OmnigentServer). */
export interface TeamMoveLine {
  readonly id: string;
  readonly identityMode: "off" | "bind" | "required";
  readonly team: TeamStatusReport | null;
  readonly admissionApplied: number | null;
}

/** The decision on one step: wait (and why), stop at `bind` (and why), or go on. */
export type MoveCheck =
  | { readonly kind: "waiting"; readonly why: string }
  | { readonly kind: "stopped"; readonly why: string }
  | { readonly kind: "ready"; readonly computers: number };

export interface MoveRules {
  readonly moveId: string;
  /** The identity mode the step needs the server started with. */
  readonly mode: "bind" | "required";
  /** This computer's host; `none` when there is no personal host to check. */
  readonly hostId: string | "none" | undefined;
  readonly hostname: string;
}

const short = (id: string) => id.slice(0, 8);

/** Whether the step's checks pass on the newest line of a server started with its settings. */
export function checkMove(line: TeamMoveLine | undefined, rules: MoveRules): MoveCheck {
  if (line === undefined || line.id !== rules.moveId || line.identityMode !== rules.mode) {
    return {
      kind: "waiting",
      why: `no server started in ${rules.mode} mode has reported the team yet`,
    };
  }
  const team = line.team;
  if (team === null) {
    return { kind: "waiting", why: "the server does not say yet who is bound" };
  }
  if (team.owners === 0) {
    return {
      kind: "stopped",
      why: "Omnigent's team has no active owner, so nobody could be bound: check the team on Settings, Members",
    };
  }
  if (team.ownersBound < team.owners) {
    return {
      kind: "waiting",
      why: `the owner's Access sign-in is not bound to Omnigent yet: open https://${rules.hostname} in your browser and sign in to Omnigent once with your password (if Omnigent opens without asking you to, sign out from your account menu and sign in again; if the site asks you to choose your Omnigent password first, do that, then sign in)`,
    };
  }
  // Nothing applied yet is revision 0: a team that never changed its list.
  if ((line.admissionApplied ?? 0) !== team.revision) {
    return {
      kind: "waiting",
      why: `Access's member group is not written yet (revision ${line.admissionApplied ?? "none"} of ${team.revision})`,
    };
  }
  const personal = team.hosts.filter((h) => h.installationOwner && !h.launchToken);
  const computers = team.hosts.filter((h) => h.launchToken).length;
  if (rules.hostId === undefined) {
    return {
      kind: "stopped",
      why: "this computer has no Omnigent host ID (none in its Omnigent configuration), so its host cannot be checked: run update again with --host-id <the host's ID>, or --host-id none if the owner uses no personal host",
    };
  }
  if (rules.hostId !== "none") {
    const mine = team.hosts.find((h) => h.hostId === rules.hostId);
    if (mine === undefined) {
      return {
        kind: "waiting",
        why: `this computer's host (${short(rules.hostId)}…) is not connected to Omnigent: make sure it runs (omnigent host status), or start it`,
      };
    }
    if (mine.identity === "unbound") {
      return {
        kind: "stopped",
        why: `this computer's host (${short(rules.hostId)}…) connects through the Cloudflare One Client with an Access identity Omnigent has not bound: the device's sign-in is not the same Access identity as your browser's. The installation stays in bind mode, where it keeps working; it would be refused in required mode. Nothing else was changed`,
      };
    }
    if (mine.identity === "other") {
      return {
        kind: "stopped",
        why: `this computer's host (${short(rules.hostId)}…) connects with an Access identity bound to someone other than its owner, or to an inactive membership. The installation stays in bind mode; nothing else was changed`,
      };
    }
    if (mine.identity === "none") {
      return {
        kind: "stopped",
        why: `this computer's host (${short(rules.hostId)}…) reaches Omnigent without Access's sign-in, which required mode would refuse: connect it through https://${rules.hostname} with the Cloudflare One Client. The installation stays in bind mode`,
      };
    }
  }
  const others = personal.filter((h) => h.identity !== "owner" && h.hostId !== rules.hostId);
  if (others.length > 0) {
    return {
      kind: "stopped",
      why: `the owner's other host${others.length === 1 ? "" : "s"} ${others.map((h) => `${short(h.hostId)}…`).join(", ")} connect${others.length === 1 ? "s" : ""} with a sign-in Omnigent has not bound to the owner, and would be refused in required mode. The installation stays in bind mode`,
    };
  }
  return { kind: "ready", computers };
}

/**
 * The move's record after its update was rolled back inside the window. `previous` is the stage
 * the restored release carries (`PreviousRelease.team`): restored as it was, with any token made
 * since (its value went with the rolled-back versions) listed for deletion. Without one, the
 * move began in the rolled-back window: the version from before holds none of its settings or
 * secrets, so it starts again from its member group (which stays), its token listed for deletion.
 *
 * `latestKept`: Cloudflare kept the rolled-back versions, so the Worker's latest upload, whose
 * secrets the next deploy takes, still holds the token that window deployed. That token stays the
 * move's own, never listed; only the ones that window's run had already given up stay listed.
 */
export function teamAfterRollback(
  team: TeamRecord | undefined,
  previous?: TeamRecord | undefined,
  latestKept = false,
): TeamRecord | undefined {
  const restored = restoredStage(team, previous);
  if (!latestKept || team === undefined || restored === undefined) return restored;
  const { token: _t, tokensToDelete: _d, ...stage } = restored;
  return {
    ...stage,
    ...(team.token === undefined ? {} : { token: team.token }),
    ...(team.tokensToDelete === undefined || team.tokensToDelete.length === 0
      ? {}
      : { tokensToDelete: team.tokensToDelete }),
  };
}

function restoredStage(
  team: TeamRecord | undefined,
  previous: TeamRecord | undefined,
): TeamRecord | undefined {
  if (previous !== undefined) {
    const key = (t: RecordedToken) => t.id ?? t.name;
    const kept = new Set(
      [
        ...(previous.token === undefined ? [] : [previous.token]),
        ...(previous.tokensToDelete ?? []),
      ].map(key),
    );
    const made = [
      ...(team?.tokensToDelete ?? []),
      ...(team?.token === undefined ? [] : [team.token]),
    ];
    const left = [...(previous.tokensToDelete ?? []), ...made.filter((t) => !kept.has(key(t)))];
    const { tokensToDelete: _left, ...stage } = previous;
    return left.length === 0 ? stage : { ...stage, tokensToDelete: left };
  }
  if (team === undefined || team.finishedAt !== undefined) return team;
  return {
    id: team.id,
    startedAt: team.startedAt,
    ...(team.memberGroup === undefined ? {} : { memberGroup: team.memberGroup }),
    ...(team.token === undefined && team.tokensToDelete === undefined
      ? {}
      : {
          tokensToDelete: [
            ...(team.tokensToDelete ?? []),
            ...(team.token === undefined ? [] : [team.token]),
          ],
        }),
  };
}

/** The secrets the update's deploy carries for the move: the token, `bind` and the move's ID. */
export function moveSecrets(
  held: ReadonlySet<string>,
  team: TeamRecord,
  tokenValue: string | undefined,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  // Lost since (deleted by hand): back as the move left it, never weaker.
  if (!held.has(IDENTITY_MODE_VAR)) {
    secrets[IDENTITY_MODE_VAR] = team.requiredAt === undefined ? "bind" : "required";
  }
  if (team.finishedAt === undefined && !held.has(TEAM_MOVE_SECRET)) {
    secrets[TEAM_MOVE_SECRET] = team.id;
  }
  if (tokenValue !== undefined) secrets[ACCESS_GROUP_TOKEN_SECRET] = tokenValue;
  return secrets;
}

// ---------------------------------------------------------------------------------------------
// The application's policy

/**
 * The installation's own Access application allows its member group instead of the owner's
 * address (step 5): one replacement of the application, every other setting written back as
 * read, then read back and checked: exactly one allow policy, its only rule the recorded group,
 * and the application otherwise as owner-only as before. Never another application.
 */
export async function switchToMemberPolicy(
  api: AccessApi,
  plan: Pick<Installation, "hostname" | "ownerPin">,
  appId: string,
  groupId: string,
): Promise<void> {
  const app = api.app(appId);
  if (app === undefined || app === null || typeof app !== "object") {
    throw new AccessRefusal(
      `the Access application this installation created for ${plan.hostname} is gone: run bootstrap.ts update again, and it creates it, owner-only`,
    );
  }
  const body = {
    ...writableApp(app as Record<string, unknown>),
    policies: [memberPolicy(groupId)],
  };
  try {
    api.update(appId, body);
  } catch (error) {
    if (!(error instanceof AccessUnavailable)) throw error;
    throw new AccessRefusal(
      `your cf login may not change Access applications (Cloudflare answered 403 Forbidden): sign in again with a login that may, then run again. Nothing else changes meanwhile: the team works, and only the application still names the owner's address instead of the member group`,
    );
  }
  const after = api.app(appId);
  const policies = (after as { policies?: unknown } | undefined)?.policies;
  const kept =
    Array.isArray(policies) &&
    policies.length === 1 &&
    JSON.stringify((policies[0] as { include?: unknown }).include) ===
      JSON.stringify([{ group: { id: groupId } }]);
  const problems = ownerOnlyProblems(
    after,
    await pinCheck(after, plan.hostname, plan.ownerPin, groupId),
  );
  if (!kept || problems.length > 0) {
    throw new Error(
      `Cloudflare did not keep the member group as the only rule of the Access application on ${plan.hostname}; run update again`,
    );
  }
}
