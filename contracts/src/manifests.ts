import { z } from "zod";
import {
  AbsolutePath,
  CheckpointId,
  ComputerId,
  Generation,
  LayerId,
  RelativePath,
  Sha256Hex,
  Timestamp,
} from "./ids.ts";

// Version 1 of the two checkpoint formats (design, "Checkpoints"; AR-25; R-19).
//
// Why this shape (S3's staging probe, 22 Oct, `spike-s3-staging.md`):
// - A layer costs about 1 s to upload and 0.5 s to restore on Cloudflare whatever its size: the
//   Sandbox SDK's `DirectoryBackup` has a fixed cost per operation. So everything one save needs
//   travels in ONE object: a layer carries its own index inside it, and no separate index object
//   is uploaded or restored.
// - The whole-tree index (0.57 MB compressed for 13,000 entries) outweighs a typical delta
//   (120-162 KB stored). So it is never re-sent with every save: a base carries the full index,
//   a delta only the entries it adds or changes and the paths it deletes. The manifest, kept in
//   WorkspaceDO's storage, stays small: per layer, the SDK's record, the SHA-256 of the layer's
//   index and the digest of the whole tree after the layer. A restore rebuilds the full index
//   from the layers and checks it against the manifest's tree digest, then checks the merged tree
//   against the index.
// - Claude's transcript and Codex's SQLite WAL files are re-sent whole each turn (0.58 and 7 MB
//   changed, 120 and 162 KB stored). Deltas are file-level, which is fine for version 1: the
//   new-base rule's size test bounds the growth, and a chunked format (restic, AR-25's fallback)
//   would be a new format version.
// - Base plus 20 deltas restored in 17.3 s against 6.3 s for one layer: 20 deltas add about 10 s
//   to a wake, inside the 240 s online wait with the start-after-stop retries (about 60 s). So
//   version 1 keeps AR-25's cap of 20 deltas per base. A lower cap is the lever if wakes must be
//   shorter; it needs no format change.
// - D25: a large workspace's pause may reach the 40 s hard limit; nothing here depends on it.

export const WORKSPACE_FORMAT_VERSION = 1;
export const SUPPORTED_WORKSPACE_FORMAT_VERSIONS = [1] as const;
export const CREDENTIAL_FORMAT_VERSION = 1;
export const SUPPORTED_CREDENTIAL_FORMAT_VERSIONS = [1] as const;

/** A new base after this many deltas (AR-25): a manifest holds at most 1 + 20 layers. */
export const MAX_DELTAS_PER_BASE = 20;
/** A new base when the deltas since the base add up to more than this share of its size. */
export const NEW_BASE_DELTA_BYTES_RATIO = 0.5;

/** Inside every staged layer: the layer's index, at `<layer root>/.cfo-layer/index.json`. */
export const LAYER_METADATA_DIR = ".cfo-layer";
export const LAYER_INDEX_PATH = `${LAYER_METADATA_DIR}/index.json`;

/** Where a computer's workspace layers live in the checkpoint bucket (RC-25: per computer). */
export function workspaceBackupPrefix(computerId: ComputerId): string {
  return `workspace/${ComputerId.parse(computerId)}/`;
}

/** Where a credential checkpoint's bundle lives in the checkpoint bucket. */
export function credentialObjectKey(computerId: ComputerId, checkpointId: CheckpointId): string {
  return `credentials/${ComputerId.parse(computerId)}/${CheckpointId.parse(checkpointId)}.json`;
}

/**
 * The Sandbox SDK's `DirectoryBackupRecord` (`@cloudflare/sandbox` 1.0.0), stored as the SDK
 * returns it. Another SDK archive format is a new workspace format version.
 */
export const DirectoryBackupRecord = z.strictObject({
  id: z.uuid(),
  dir: AbsolutePath,
  size: z.number().int().min(0),
  name: z.string().min(1).max(256).optional(),
  sha256: Sha256Hex,
  format: z.literal("tar+zstd/1"),
});
export type DirectoryBackupRecord = z.infer<typeof DirectoryBackupRecord>;

// ---------------------------------------------------------------------------------------------
// The tree index.

const Mode = z.number().int().min(0).max(0o7777);
const Id = z.number().int().min(0).max(0xffffffff);

/** A regular file: its permission bits, owner (S3: owners are restored too), size and hash. */
export const IndexFile = z.strictObject({
  path: RelativePath,
  type: z.literal("file"),
  mode: Mode,
  uid: Id,
  gid: Id,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: Sha256Hex,
});
export const IndexDirectory = z.strictObject({
  path: RelativePath,
  type: z.literal("dir"),
  mode: Mode,
  uid: Id,
  gid: Id,
});
/** A symbolic link, kept as a link and never followed. */
export const IndexSymlink = z.strictObject({
  path: RelativePath,
  type: z.literal("symlink"),
  uid: Id,
  gid: Id,
  target: z
    .string()
    .min(1)
    .max(4096)
    .refine((t) => !t.includes("\0"), { message: "no NUL in a link target" }),
});
export const IndexEntry = z.discriminatedUnion("type", [IndexFile, IndexDirectory, IndexSymlink]);
export type IndexEntry = z.infer<typeof IndexEntry>;

function uniquePaths(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length;
}

const layerIndex = {
  formatVersion: z.number().int().min(1),
  layerId: LayerId,
  computerId: ComputerId,
  generation: Generation,
  entries: z.array(IndexEntry).max(1_000_000),
  treeDigest: Sha256Hex,
};

const uniqueEntryPaths = (i: { entries: readonly IndexEntry[]; deleted: readonly string[] }) =>
  uniquePaths(i.entries.map((e) => e.path)) && uniquePaths(i.deleted);

/**
 * A layer's index, at `LAYER_INDEX_PATH` inside the layer. A base lists every entry of the tree;
 * a delta lists the entries it adds or changes and the paths it deletes, against its parent tree.
 * Applying a delta: first each deleted path is removed with everything below it, then each entry
 * is written. Every path must lie under one of the manifest's roots, so no deletion reaches
 * outside them (RC-37). `treeDigest` is the whole tree's digest after the layer.
 *
 * Checked in TypeScript, not in the exported JSON Schema (a Python reader checks it too): each
 * path at most once among the entries and once among the deletions.
 */
export const LayerIndex = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("base"),
      ...layerIndex,
      parentTreeDigest: z.null(),
      deleted: z.array(RelativePath).max(0),
    }),
    z.strictObject({
      kind: z.literal("delta"),
      ...layerIndex,
      parentTreeDigest: Sha256Hex,
      deleted: z.array(RelativePath).max(1_000_000),
    }),
  ])
  .refine(uniqueEntryPaths, {
    message: "each path at most once among the entries, and once among the deletions",
  });
export type LayerIndex = z.infer<typeof LayerIndex>;

const encoder = new TextEncoder();

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * The canonical bytes of a whole tree's index: entries sorted by path as UTF-8 bytes, each
 * written as NUL-terminated fields with a fixed count per type, so no path or link target can
 * make two trees encode alike (neither can hold a NUL):
 *   file     F, path, mode, uid, gid, size, sha256
 *   dir      D, path, mode, uid, gid
 *   symlink  L, path, uid, gid, target
 * Mode is four octal digits; other numbers are decimal.
 */
export function canonicalTreeBytes(entries: readonly IndexEntry[]): Uint8Array {
  const sorted = entries
    .map((entry) => ({ entry, key: encoder.encode(entry.path) }))
    .sort((a, b) => compareBytes(a.key, b.key));
  const octal = (mode: number) => mode.toString(8).padStart(4, "0");
  const fields = sorted.flatMap(({ entry: e }) =>
    e.type === "file"
      ? ["F", e.path, octal(e.mode), e.uid, e.gid, e.size, e.sha256]
      : e.type === "dir"
        ? ["D", e.path, octal(e.mode), e.uid, e.gid]
        : ["L", e.path, e.uid, e.gid, e.target],
  );
  return encoder.encode(fields.map((f) => `${f}\0`).join(""));
}

/** The whole tree's digest: lowercase hex SHA-256 of `canonicalTreeBytes`. */
export async function treeDigest(entries: readonly IndexEntry[]): Promise<string> {
  const bytes = canonicalTreeBytes(entries) as Uint8Array<ArrayBuffer>;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------
// The workspace manifest.

const workspaceLayer = {
  layerId: LayerId,
  /** The SDK's record of the uploaded layer, under `workspaceBackupPrefix(computerId)`. */
  backup: DirectoryBackupRecord,
  /** SHA-256 of the layer's index file, checked when the layer is restored. */
  indexSha256: Sha256Hex,
  /** The whole tree's digest after this layer. */
  treeDigest: Sha256Hex,
  /** Entries in the layer's index, deletions, and the uncompressed bytes of its files. */
  entries: z.number().int().min(0),
  deleted: z.number().int().min(0),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};
export const BaseLayer = z.strictObject({ kind: z.literal("base"), ...workspaceLayer });
export const DeltaLayer = z.strictObject({ kind: z.literal("delta"), ...workspaceLayer });
export const WorkspaceLayer = z.discriminatedUnion("kind", [BaseLayer, DeltaLayer]);
export type WorkspaceLayer = z.infer<typeof WorkspaceLayer>;

/**
 * One published workspace checkpoint: a base and the deltas since it, in order. WorkspaceDO keeps
 * it in its storage and switches its pointer atomically; a failed or interrupted capture never
 * changes the pointer, so a restore always uses one complete checkpoint.
 *
 * - `generation` is the generation that captured the last layer; its restore was confirmed first
 *   (R-19).
 * - `parentCheckpointId` is the checkpoint the last layer was computed against. A delta is
 *   published only while that is still the current pointer; otherwise it is discarded.
 * - `cutAt` is when the capture's cut was taken: a turn counts as saved only once a checkpoint
 *   whose cut follows the turn's end is published.
 * - `policyVersion` is the checkpoint policy version that filtered every layer.
 * - A reader refuses an unsupported `formatVersion` before using anything else.
 *
 * Checked in TypeScript, not in the exported JSON Schema: unique layer IDs and roots; the
 * manifest's tree digest is its last layer's; the cut precedes publication.
 */
export const WorkspaceManifest = z
  .strictObject({
    formatVersion: z.number().int().min(1),
    checkpointId: CheckpointId,
    computerId: ComputerId,
    generation: Generation,
    policyVersion: z.number().int().min(1),
    parentCheckpointId: CheckpointId.nullable(),
    cutAt: Timestamp,
    createdAt: Timestamp,
    roots: z.array(RelativePath).min(1).max(64),
    /** The base first, then at most MAX_DELTAS_PER_BASE deltas, in order. */
    layers: z.tuple([BaseLayer], DeltaLayer).check(z.maxLength(1 + MAX_DELTAS_PER_BASE)),
    treeDigest: Sha256Hex,
  })
  .refine((m) => uniquePaths(m.layers.map((l) => l.layerId)) && uniquePaths(m.roots), {
    message: "layer IDs and roots unique",
  })
  .refine((m) => m.treeDigest === m.layers[m.layers.length - 1]?.treeDigest, {
    message: "the manifest's tree digest is its last layer's",
  })
  .refine((m) => Date.parse(m.cutAt) <= Date.parse(m.createdAt), {
    message: "the cut precedes publication",
  });
export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>;

// ---------------------------------------------------------------------------------------------
// The credential checkpoint.

/**
 * The declared credential files, relative to the home directory (spike S6 for Claude Code
 * 2.1.296 and Codex 0.162.1; `~/.codex/.credentials.json` added for Codex's MCP sign-ins,
 * SEC-07; Omnigent's own login file dropped, D14). Their families are in `checkpoint-policy.ts`.
 */
export const DeclaredCredentialPath = z.enum([
  ".claude/.credentials.json",
  ".claude/.device-keys.json",
  ".codex/auth.json",
  ".codex/.credentials.json",
]);
export type DeclaredCredentialPath = z.infer<typeof DeclaredCredentialPath>;

/** Which sign-in each declared file belongs to: the setup page's two cards. */
export const CREDENTIAL_PROVIDER: Readonly<Record<DeclaredCredentialPath, "claude" | "codex">> = {
  ".claude/.credentials.json": "claude",
  ".claude/.device-keys.json": "claude",
  ".codex/auth.json": "codex",
  ".codex/.credentials.json": "codex",
};

/** The file that holds each provider's login, whose presence the setup cards report. */
export const LOGIN_FILE: Readonly<Record<"claude" | "codex", DeclaredCredentialPath>> = {
  claude: ".claude/.credentials.json",
  codex: ".codex/auth.json",
};

/** The largest declared file copied; a bigger one is refused, not truncated. */
export const MAX_CREDENTIAL_FILE_BYTES = 64 * 1024;

/**
 * Each copy's order number, taken under the same lock as the read; numbers restart at 1 in each
 * generation and increase across all declared files.
 */
const CopyOrder = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const Base64 = z
  .string()
  .max(Math.ceil(MAX_CREDENTIAL_FILE_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

/** A declared file as copied, opaque bytes in base64. Login material: never logged. */
export const CredentialFilePresent = z.strictObject({
  state: z.literal("present"),
  mode: z.number().int().min(0).max(0o777),
  copyOrder: CopyOrder,
  contentBase64: Base64,
});
/** A declared file found absent: a tombstone, so a logout is never undone by an older copy. */
export const CredentialTombstone = z.strictObject({
  state: z.literal("tombstone"),
  copyOrder: CopyOrder,
});

const CredentialFileState = z.discriminatedUnion("state", [
  CredentialFilePresent,
  CredentialTombstone,
]);

/** One entry per declared file, keyed by its path: present or tombstoned, never missing. */
const declaredFiles = <T extends z.ZodType>(entry: T) =>
  z.strictObject({
    ".claude/.credentials.json": entry,
    ".claude/.device-keys.json": entry,
    ".codex/auth.json": entry,
    ".codex/.credentials.json": entry,
  } satisfies Record<DeclaredCredentialPath, T>);

function highestCopyOrder(files: Readonly<Record<string, { readonly copyOrder: number }>>): number {
  return Math.max(...Object.values(files).map((f) => f.copyOrder));
}

/**
 * A credential checkpoint's content: every declared file, present or tombstoned, keyed by path.
 * The supervisor sends it in a `credential_checkpoint` message; WorkspaceDO stores it unchanged
 * at `credentialObjectKey` and sends it back in `install_credentials`. `order` is the highest copy
 * order in it. WorkspaceDO publishes it only if (`generation`, `order`) is newer than the
 * pointer's: the same generation with a higher order, or a newer generation.
 *
 * Checked in TypeScript, not in the exported JSON Schema: `order` is the highest copy order.
 */
export const CredentialBundle = z
  .strictObject({
    formatVersion: z.number().int().min(1),
    computerId: ComputerId,
    generation: Generation,
    order: CopyOrder,
    files: declaredFiles(CredentialFileState),
  })
  .refine((b) => b.order === highestCopyOrder(b.files), {
    message: "order is the highest copy order",
  });
export type CredentialBundle = z.infer<typeof CredentialBundle>;

/**
 * The published credential checkpoint, as WorkspaceDO's pointer records it: the bundle's object
 * and, per declared file, its state without its content. The setup cards and the sign-out rules
 * read it; nothing parses the files themselves.
 *
 * Checked in TypeScript, not in the exported JSON Schema: the object key names this computer and
 * checkpoint; `order` is the highest copy order.
 */
export const CredentialManifest = z
  .strictObject({
    formatVersion: z.number().int().min(1),
    checkpointId: CheckpointId,
    computerId: ComputerId,
    generation: Generation,
    order: CopyOrder,
    createdAt: Timestamp,
    object: z.strictObject({
      key: z
        .string()
        .regex(/^credentials\/cmp_[0-9a-hjkmnp-tv-z]{26}\/ckp_[0-9a-hjkmnp-tv-z]{26}\.json$/),
      size: z.number().int().min(1),
      sha256: Sha256Hex,
    }),
    files: declaredFiles(
      z.discriminatedUnion("state", [
        z.strictObject({
          state: z.literal("present"),
          size: z.number().int().min(0).max(MAX_CREDENTIAL_FILE_BYTES),
          sha256: Sha256Hex,
          copyOrder: CopyOrder,
        }),
        CredentialTombstone,
      ]),
    ),
  })
  .refine((m) => m.object.key === `credentials/${m.computerId}/${m.checkpointId}.json`, {
    message: "the object key names this computer and checkpoint",
  })
  .refine((m) => m.order === highestCopyOrder(m.files), {
    message: "order is the highest copy order",
  });
export type CredentialManifest = z.infer<typeof CredentialManifest>;

/** Whether a credential bundle may replace the published pointer (same rule as the design). */
export function credentialIsNewer(
  candidate: { readonly generation: number; readonly order: number },
  current: { readonly generation: number; readonly order: number } | null,
): boolean {
  if (current === null) return true;
  return (
    candidate.generation > current.generation ||
    (candidate.generation === current.generation && candidate.order > current.order)
  );
}
