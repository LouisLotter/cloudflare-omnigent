import { z } from "zod";
import { RelativePath } from "./ids.ts";

// Version 1 of the credential families and the checkpoint policy: one classification of every
// path under a computer's checkpointed roots, from which capture, prune and restore are all
// generated (R-08, G1BR-001 and its residual). Its content is S6's follow-up classification
// (`spikes/s6/followup/bridge-classification.json`, fork `af3e49de2`), with:
// - the declared credential files and their families first (spike S6; SEC-07);
// - the two "decide" cases settled: `codex-home/config.toml` saved, because core change 20 keeps
//   the provider key out of it (`provider_key`, a secret family, below); `~/.claude.json` saved,
//   because S6's sitting found no token in it (H22b);
// - `~/.claude/backups/` excluded (H22a);
// - core change 21's `*.jsonl.unreconciled-*` transcripts saved with the transcripts;
// - the design's cache and log exclusions (DC-12), which the spike applied after its rules.
//
// Matching (unchanged from S6): patterns are relative to the home directory, or to $TMPDIR for
// `root: "tmp"` rules, which apply only if $TMPDIR lies inside a checkpointed root (version 1
// keeps it outside every root, so they never apply). `**` matches any characters, slashes
// included; `*` any characters within one segment; `?` one character within a segment. The
// first matching rule wins. A directory a rule saves is traversed and each member decided on its
// own; a directory a rule excludes is skipped whole.
//
// Actions:
// - `credential`: a declared credential file's family (the file, its temporary siblings and its
//   locks). Never in a workspace layer. Only the declared file itself travels, in the credential
//   checkpoint.
// - `exclude`: never in a workspace layer.
// - `save`: continuation state, in the workspace checkpoint.
// - `save-link`: a symbolic link kept as a link, never followed; a copy that is not a link is
//   saved as a file.
// - `unclassified`: a file this classification does not know, inside a directory it fully
//   classifies. Never saved; the capture reports it, so the classification is extended.
// Every restore strips a member whose action is not `save` or `save-link`, with an alert. A
// capture also refuses to save a file that shares an inode with an excluded one (a hard link to
// a login, as Codex's private home makes).

export const CHECKPOINT_POLICY_FORMAT = "cfo.checkpoint-policy";
export const CHECKPOINT_POLICY_VERSION = 1;

export const PolicyAction = z.enum(["credential", "exclude", "save", "save-link", "unclassified"]);
export type PolicyAction = z.infer<typeof PolicyAction>;

/** A glob relative to its root: no leading slash, no NUL. */
const Pattern = z
  .string()
  .max(512)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is refused on purpose
  .regex(/^(?!\/)[^\u0000]+$/);

export const PolicyRule = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  harness: z.enum([
    "claude-code",
    "codex",
    "claude-native",
    "codex-native",
    "both",
    "omnigent",
    "platform",
  ]),
  class: z.enum([
    "credential",
    "credential-link",
    "secret",
    "runtime",
    "cache",
    "continuation",
    "workspace",
    "unclassified",
  ]),
  action: PolicyAction,
  root: z.enum(["home", "tmp"]),
  patterns: z.array(Pattern).min(1).max(64),
  why: z.string().min(1).max(500),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

/**
 * The checkpoint policy: the roots a workspace checkpoint covers, and the ordered rules.
 *
 * Checked in TypeScript, not in the exported JSON Schema: rule IDs are unique; the credential
 * families come first, and none follows another kind of rule.
 */
export const CheckpointPolicy = z
  .strictObject({
    format: z.literal(CHECKPOINT_POLICY_FORMAT),
    version: z.number().int().min(1),
    roots: z.array(RelativePath).min(1).max(64),
    rules: z.array(PolicyRule).min(1).max(256),
  })
  .refine((p) => new Set(p.rules.map((r) => r.id)).size === p.rules.length, {
    message: "rule IDs unique",
  })
  .refine((p) => p.rules.findIndex((r) => r.action !== "credential") > 0, {
    message: "the credential families come first",
  })
  .refine(
    (p) =>
      p.rules
        .slice(p.rules.findIndex((r) => r.action !== "credential"))
        .every((r) => r.action !== "credential"),
    { message: "no credential family after the first other rule" },
  );
export type CheckpointPolicy = z.infer<typeof CheckpointPolicy>;

const rule = (r: PolicyRule): PolicyRule => r;

/** Version 1. Ordered: the first matching rule decides. */
export const CHECKPOINT_POLICY_V1: CheckpointPolicy = {
  format: CHECKPOINT_POLICY_FORMAT,
  version: 1,
  roots: ["work", ".claude", ".claude.json", ".codex", ".omnigent"],
  rules: [
    // The declared credential families (spike S6). First, so no later rule can save one.
    rule({
      id: "claude-credentials",
      harness: "claude-code",
      class: "credential",
      action: "credential",
      root: "home",
      patterns: [".claude/.credentials.json", ".claude/.credentials.json.*"],
      why: "Claude Code's login. Its atomic writer stages <target>.tmp.<8 hex> or .tmp.<pid>.<12 hex> beside it.",
    }),
    rule({
      id: "claude-device-keys",
      harness: "claude-code",
      class: "credential",
      action: "credential",
      root: "home",
      patterns: [
        ".claude/.device-keys.json",
        ".claude/.device-keys.json.*",
        ".claude/.device-keys.lock",
      ],
      why: "Claude Code's device-key store, which the binary can write; login material.",
    }),
    rule({
      id: "codex-auth",
      harness: "codex",
      class: "credential",
      action: "credential",
      root: "home",
      patterns: [".codex/auth.json", ".codex/auth.json.*"],
      why: "Codex's login. Codex rewrites it in place; any sibling named after it is treated as a copy.",
    }),
    rule({
      id: "codex-mcp-credentials",
      harness: "codex",
      class: "credential",
      action: "credential",
      root: "home",
      patterns: [".codex/.credentials.json", ".codex/.credentials.json.*"],
      why: "Codex's store for MCP sign-ins (SEC-07).",
    }),
    // Omnigent's own login never exists on a computer (D14). Excluded in case anything writes it.
    rule({
      id: "omnigent-login",
      harness: "omnigent",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/auth_tokens.json",
        ".omnigent/.auth_tokens.json.*.tmp",
        ".omnigent/auth_tokens.lock",
      ],
      why: "An Omnigent login file; computers authenticate with launch tokens, never on disk.",
    }),
    // S6's classification of the native harnesses' files, in its order.
    rule({
      id: "codex-home-auth",
      harness: "codex-native",
      class: "credential-link",
      action: "exclude",
      root: "home",
      patterns: [".omnigent/codex-native/*/codex-home/auth.json"],
      why: "A symbolic link (or a copied fallback) to ~/.codex/auth.json; the start relinks it.",
    }),
    rule({
      id: "codex-home-mcp-credentials",
      harness: "codex-native",
      class: "credential-link",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/codex-home/.credentials.json",
        ".omnigent/codex-native/*/codex-home/.credentials.json.*",
      ],
      why: "A hard link to ~/.codex/.credentials.json (or a copy); excluded by path whatever its type.",
    }),
    rule({
      id: "codex-model-probe-cache",
      harness: "codex-native",
      class: "credential-link",
      action: "exclude",
      root: "home",
      patterns: [".omnigent/cache/codex-model-probe/**"],
      why: "A second set of the credential links; a regenerated cache.",
    }),
    rule({
      id: "codex-policy-hook",
      harness: "codex-native",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/policy_hook.json",
        ".omnigent/codex-native/*/policy_hook.json.*",
      ],
      why: "Bearer headers for the policy hook (mkstemp 'policy_hook.json.' then os.replace).",
    }),
    rule({
      id: "codex-bridge-json",
      harness: "codex-native",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [".omnigent/codex-native/*/bridge.json", ".omnigent/codex-native/*/bridge.json.*"],
      why: "The serve-mcp bearer; recreated when missing.",
    }),
    rule({
      id: "codex-provider-key",
      harness: "codex-native",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/provider_key",
        ".omnigent/codex-native/*/provider_key.*",
      ],
      why: "Core change 20: an Omnigent key provider's API key, 0600, for the app-server's life (mkstemp 'provider_key.').",
    }),
    rule({
      id: "bridge-server-json",
      harness: "both",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/server.json",
        ".omnigent/codex-native/*/.server.json.*.tmp",
      ],
      why: "Bearer, and a socket path that is dead after a restore.",
    }),
    rule({
      id: "bridge-tool-relay",
      harness: "both",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/tool_relay.json",
        ".omnigent/codex-native/*/.tool_relay.json.*.tmp",
      ],
      why: "Relay bearer; a stale copy advertises tools at a dead port.",
    }),
    rule({
      id: "bridge-tool-relay-env",
      harness: "both",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [".omnigent/codex-native/*/tool_relay.env"],
      why: "Written in place with OMNIGENT_RELAY_TOKEN: no temporary sibling.",
    }),
    rule({
      id: "bridge-routers",
      harness: "both",
      class: "secret",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/turn_router.json",
        ".omnigent/codex-native/*/turn_router.json.*.tmp",
        ".omnigent/codex-native/*/subagent_router.json",
        ".omnigent/codex-native/*/subagent_router.json.*.tmp",
      ],
      why: "Loopback route-turn bearers (Smart Routing sessions).",
    }),
    rule({
      id: "codex-bridge-locks",
      harness: "codex-native",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/.locks",
        ".omnigent/codex-native/.locks/**",
        ".omnigent/codex-native/*/state.lock",
        ".omnigent/codex-native/*/unmirrored_settings.lock",
      ],
      why: "Lock files; no value after a restore.",
    }),
    rule({
      id: "codex-bridge-runtime",
      harness: "codex-native",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/owner.pid",
        ".omnigent/codex-native/*/state.json",
        ".omnigent/codex-native/*/state.json.*",
        ".omnigent/codex-native/*/startup_error.json",
        ".omnigent/codex-native/*/startup_error.json.*",
        ".omnigent/codex-native/*/startup_timeout.json",
        ".omnigent/codex-native/*/startup_timeout.json.*",
        ".omnigent/codex-native/*/egress_certificate_failure.json",
        ".omnigent/codex-native/*/egress_certificate_failure.json.*",
        ".omnigent/codex-native/*/mcp_startup.json",
        ".omnigent/codex-native/*/mcp_startup.json.*",
        ".omnigent/codex-native/*/unmirrored_settings.json",
        ".omnigent/codex-native/*/unmirrored_settings.json.*",
        ".omnigent/codex-native/*/app-server.sock",
        ".omnigent/codex-native/*/turn_routing.log",
        ".omnigent/codex-native/*/dead_letter.jsonl.tmp",
        ".omnigent/codex-native/*/dead_letter.jsonl.1.tmp",
        ".omnigent/codex-native/*/side_chat_requests/*.tmp",
      ],
      why: "Per-process state; a restored copy points turns at a dead app-server.",
    }),
    rule({
      id: "codex-process-registry",
      harness: "codex-native",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/process-registry.json",
        ".omnigent/codex-native/process-registry.json.tmp",
        ".omnigent/codex-native/process-registry.json.lock",
        ".omnigent/codex-native/process-owners/**",
      ],
      why: "PIDs and boot IDs; dropped on reconcile after a restore.",
    }),
    rule({
      id: "codex-home-skills",
      harness: "codex-native",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [".omnigent/codex-native/*/codex-home/skills/**"],
      why: "Links into a temporary bundle directory; re-linked at launch.",
    }),
    rule({
      id: "codex-home-temporaries",
      harness: "codex-native",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/codex-home/config.toml.*",
        ".omnigent/codex-native/*/codex-home/.config.toml.*",
        ".omnigent/codex-native/*/codex-home/..omnigent-config-profile.toml.*",
        ".omnigent/codex-native/*/codex-home/..omnigent-developer-instructions-state.toml.*",
        ".omnigent/codex-native/*/codex-home/hooks.json.*",
        ".omnigent/codex-native/*/codex-home/sessions/**/.rollout-*.jsonl.*.tmp",
        ".omnigent/codex-native/*/codex-home/sessions/**/rollout-*.jsonl.tmp",
        ".omnigent/codex-native/*/codex-home/log/**",
        ".omnigent/codex-native/*/codex-home/.tmp/**",
        ".omnigent/codex-native/*/codex-home/tmp/**",
        ".omnigent/codex-native/*/codex-home/cache/**",
        ".omnigent/codex-native/*/codex-home/logs_*.sqlite",
        ".omnigent/codex-native/*/codex-home/logs_*.sqlite-wal",
        ".omnigent/codex-native/*/codex-home/logs_*.sqlite-shm",
        ".omnigent/codex-native/*/codex-home/logs_*.sqlite-journal",
      ],
      why: "Temporary siblings of saved files, and the same log, .tmp, cache and log-database exclusions as ~/.codex.",
    }),
    rule({
      id: "omnigent-cache",
      harness: "omnigent",
      class: "cache",
      action: "exclude",
      root: "home",
      patterns: [".omnigent/cache/**"],
      why: "Model catalogue and other caches; regenerated.",
    }),
    rule({
      id: "codex-home-config",
      harness: "codex-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/codex-home/config.toml",
        ".omnigent/codex-native/*/codex-home/.omnigent-config-profile.toml",
      ],
      why: "The session's private settings. Core change 20 keeps any provider key out of them (S6's 'decide', settled).",
    }),
    rule({
      id: "codex-home-continuation",
      harness: "codex-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/codex-home/.omnigent-developer-instructions-state.toml",
        ".omnigent/codex-native/*/codex-home/.omnigent-developer-instructions-base",
        ".omnigent/codex-native/*/codex-home/model_catalog.json",
        ".omnigent/codex-native/*/codex-home/hooks.json",
        ".omnigent/codex-native/*/codex-home/.omnigent-codex-source",
        ".omnigent/codex-native/*/codex-home/sessions/**",
        ".omnigent/codex-native/*/codex-home/plugins",
      ],
      why: "Private session state; rollouts are the local fallback when server history is unavailable.",
    }),
    rule({
      id: "codex-home-links",
      harness: "codex-native",
      class: "continuation",
      action: "save-link",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/codex-home/memories_1.sqlite",
        ".omnigent/codex-native/*/codex-home/AGENTS.md",
        ".omnigent/codex-native/*/codex-home/AGENTS.override.md",
        ".omnigent/codex-native/*/codex-home/plugins/cache",
        ".omnigent/codex-native/*/codex-home/mcp-oauth-locks",
        ".omnigent/codex-native/*/codex-home/memories",
        ".omnigent/codex-native/*/codex-home/rules",
      ],
      why: "Links into ~/.codex; kept as links, never followed.",
    }),
    rule({
      id: "codex-home-other",
      harness: "codex-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [".omnigent/codex-native/*/codex-home/**"],
      why: "Codex's own files in its private CODEX_HOME (history, state databases).",
    }),
    rule({
      id: "codex-bridge-queue",
      harness: "codex-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/dead_letter.jsonl",
        ".omnigent/codex-native/*/dead_letter.jsonl.1",
      ],
      why: "The undelivered-event queue, replayed before a cold resume (idempotent by source_id).",
    }),
    rule({
      id: "codex-bridge-continuation",
      harness: "codex-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/turn_routing_done",
        ".omnigent/codex-native/*/turn_replay_pending.json",
        ".omnigent/codex-native/*/side_chat_requests",
        ".omnigent/codex-native/*/side_chat_requests/*.json",
        ".omnigent/codex-native/*/codex-home",
        ".omnigent/codex-native/*/launch.json",
      ],
      why: "Routing and replay markers, and the CLI's launch record.",
    }),
    rule({
      id: "codex-bridge-launch-tmp",
      harness: "both",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [
        ".omnigent/codex-native/*/launch.json.tmp",
        ".omnigent/claude-native/*/launch.json.tmp",
      ],
      why: "Fixed temporary of launch.json.",
    }),
    rule({
      id: "codex-bridge-dir",
      harness: "codex-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [".omnigent/codex-native", ".omnigent/codex-native/*"],
      why: "The bridge directories themselves (mode 0700).",
    }),
    rule({
      id: "codex-bridge-unclassified",
      harness: "codex-native",
      class: "unclassified",
      action: "unclassified",
      root: "home",
      patterns: [".omnigent/codex-native/**"],
      why: "Anything else in a Codex bridge is unknown to this classification: never saved, reported.",
    }),
    rule({
      id: "claude-launch-state",
      harness: "claude-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [
        ".omnigent/claude-native",
        ".omnigent/claude-native/*",
        ".omnigent/claude-native/*/launch.json",
      ],
      why: "Launch record.",
    }),
    rule({
      id: "native-attachments",
      harness: "both",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [".omnigent/attachments/**", ".omnigent/attachments"],
      why: "Cached uploads; rebuilt on resume.",
    }),
    rule({
      id: "claude-transcript-temporaries",
      harness: "claude-native",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [".claude/projects/*/*.jsonl.tmp"],
      why: "Temporary of a rewritten transcript.",
    }),
    rule({
      id: "claude-unreconciled-transcripts",
      harness: "claude-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [".claude/projects/**/*.jsonl.unreconciled-*"],
      why: "Core change 21: a transcript that could not be placed, renamed aside; recovery material.",
    }),
    rule({
      id: "claude-transcripts",
      harness: "claude-native",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [".claude/projects/**"],
      why: "Conversation transcripts; the server's history is authoritative on a cold resume.",
    }),
    rule({
      id: "claude-global-config-temporaries",
      harness: "claude-native",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: ["..claude.json.*.tmp"],
      why: "Temporary of ~/.claude.json.",
    }),
    rule({
      id: "claude-global-config",
      harness: "claude-code",
      class: "continuation",
      action: "save",
      root: "home",
      patterns: [".claude.json"],
      why: "Holds no token (S6's sitting, H22b): plan tier and identity, the person's own data. S6's 'decide', settled.",
    }),
    // The design's cache and log exclusions (DC-12, H22a).
    rule({
      id: "claude-backups",
      harness: "claude-code",
      class: "cache",
      action: "exclude",
      root: "home",
      patterns: [".claude/backups", ".claude/backups/**"],
      why: "Copies of ~/.claude.json with no continuation value (H22a).",
    }),
    rule({
      id: "claude-runtime",
      harness: "claude-code",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [
        ".claude/shell-snapshots",
        ".claude/shell-snapshots/**",
        ".claude/statsig",
        ".claude/statsig/**",
      ],
      why: "Claude Code's per-process snapshots and feature-flag cache.",
    }),
    rule({
      id: "codex-runtime",
      harness: "codex",
      class: "cache",
      action: "exclude",
      root: "home",
      patterns: [
        ".codex/log",
        ".codex/log/**",
        ".codex/.tmp",
        ".codex/.tmp/**",
        ".codex/tmp",
        ".codex/tmp/**",
        ".codex/cache",
        ".codex/cache/**",
        ".codex/skills/.system",
        ".codex/skills/.system/**",
        ".codex/logs_*.sqlite",
        ".codex/logs_*.sqlite-wal",
        ".codex/logs_*.sqlite-shm",
        ".codex/logs_*.sqlite-journal",
      ],
      why: "Codex's logs, temporaries, regenerable caches and bundled skills. tmp/arg0-linux holds per-process helper links that every Codex run replaces (WP3.4). logs_N.sqlite is Codex's own trace log (a `logs` table it prunes by age), not continuation state, and it held a ChatGPT edge token Codex logged (WP3.27).",
    }),
    rule({
      id: "omnigent-logs",
      harness: "omnigent",
      class: "runtime",
      action: "exclude",
      root: "home",
      patterns: [".omnigent/logs", ".omnigent/logs/**"],
      why: "Logs.",
    }),
    rule({
      id: "general-caches",
      harness: "platform",
      class: "cache",
      action: "exclude",
      root: "home",
      patterns: [
        "**/node_modules",
        "**/node_modules/**",
        "**/.venv",
        "**/.venv/**",
        "**/.cache",
        "**/.cache/**",
      ],
      why: "Caches and virtual environments, rebuilt on demand (design, checkpoint contents).",
    }),
    // Claude-native's bridge lives under $TMPDIR (S6), outside every root in version 1, so these
    // never apply; they are the policy if $TMPDIR is ever inside a root.
    rule({
      id: "tmp-claude-bridge-secrets",
      harness: "claude-native",
      class: "secret",
      action: "exclude",
      root: "tmp",
      patterns: [
        "omnigent-*/claude-native/*/permission_hook.json",
        "omnigent-*/claude-native/*/.permission_hook.json.*.tmp",
        "omnigent-*/claude-native/*/claude-settings.json",
        "omnigent-*/claude-native/*/.claude-settings.json.*.tmp",
        "omnigent-*/claude-native/*/bridge.json",
        "omnigent-*/claude-native/*/.bridge.json.*.tmp",
        "omnigent-*/claude-native/*/tool_relay.json",
        "omnigent-*/claude-native/*/.tool_relay.json.*.tmp",
        "omnigent-*/claude-native/*/tool_relay.env",
        "omnigent-*/claude-native/*/server.json",
        "omnigent-*/claude-native/*/.server.json.*.tmp",
        "omnigent-*/claude-native/*/turn_router.json",
        "omnigent-*/claude-native/*/turn_router.json.*.tmp",
        "omnigent-*/claude-native/*/subagent_router.json",
        "omnigent-*/claude-native/*/subagent_router.json.*.tmp",
      ],
      why: "Bearers, hooks and apiKeyHelper of Claude-native's bridge.",
    }),
    rule({
      id: "tmp-claude-bridge-continuation",
      harness: "claude-native",
      class: "continuation",
      action: "save",
      root: "tmp",
      patterns: [
        "omnigent-*/claude-native/*/transcript_forwarder.json",
        "omnigent-*/claude-native/*/hook_forwarder.json",
        "omnigent-*/claude-native/*/subagent_forwarder.json",
        "omnigent-*/claude-native/*/message_deltas_forwarder.json",
        "omnigent-*/claude-native/*/compaction_forwarder.json",
      ],
      why: "Forwarder cursors: useful, not required.",
    }),
    rule({
      id: "tmp-claude-bridge-dirs",
      harness: "claude-native",
      class: "continuation",
      action: "save",
      root: "tmp",
      patterns: [
        "omnigent-*",
        "omnigent-*/claude-native",
        "omnigent-*/claude-native/????????????????????????????????",
      ],
      why: "The directories that lead to the forwarder cursors.",
    }),
    rule({
      id: "tmp-claude-bridge-runtime",
      harness: "claude-native",
      class: "runtime",
      action: "exclude",
      root: "tmp",
      patterns: ["omnigent-*/**"],
      why: "Locks, sockets, logs and other per-process state.",
    }),
    // Everything else under the roots is the person's workspace and the CLIs' state.
    rule({
      id: "workspace",
      harness: "platform",
      class: "workspace",
      action: "save",
      root: "home",
      patterns: ["**"],
      why: "The workspace and continuation state.",
    }),
  ],
};

const patternCache = new Map<string, RegExp>();

/** S6's glob semantics, as a regular expression for one whole path. */
export function globToRegExp(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
  }
  const regex = new RegExp(`^${out}$`, "s");
  patternCache.set(pattern, regex);
  return regex;
}

export interface PolicyDecision {
  readonly action: PolicyAction;
  readonly rule: string;
}

/**
 * The one decision for a path relative to the home directory. `tmpRel` is $TMPDIR relative to
 * the home directory, when it lies inside a root (never in version 1). A path that no rule
 * matches is `unclassified`; version 1's last rule matches every path.
 */
export function classifyPath(
  policy: CheckpointPolicy,
  path: string,
  options: { readonly tmpRel?: string } = {},
): PolicyDecision {
  const { tmpRel } = options;
  for (const r of policy.rules) {
    let target = path;
    if (r.root === "tmp") {
      if (tmpRel === undefined || !(path === tmpRel || path.startsWith(`${tmpRel}/`))) continue;
      target = path.slice(tmpRel.length + 1);
    }
    if (r.patterns.some((p) => globToRegExp(p).test(target))) {
      return { action: r.action, rule: r.id };
    }
  }
  return { action: "unclassified", rule: "none" };
}

/** Whether a path may be written into a workspace layer, or installed from one on restore. */
export function isSaved(decision: PolicyDecision): boolean {
  return decision.action === "save" || decision.action === "save-link";
}
