# Secret checklist

Every secret the project uses or will use: what it is for, where it lives, who can read it, and how it is removed. A new secret gets a row here before code uses it. Values never appear in this repository, in logs, fixtures, snapshots or images; the canary scan in CI checks for planted ones.

## Rules

- [ ] No secret, login file, account ID or personal email address is committed. Local state that identifies the owner lives outside the repository (the staging directory below) or in gitignored files (`.env*`, `.dev.vars*`).
- [ ] Worker secrets are set from the owner's laptop, with `wrangler secret put` or by the staging tool, which uploads them with the Worker version (`wrangler deploy --secrets-file`), never written into `wrangler.jsonc` `vars`. Deployments run from that laptop only.
- [ ] CI holds no secrets. It runs on `pull_request` with a read-only token and no persisted checkout credentials, so code from a fork gets nothing.
- [ ] Staging uses staging-only values. Deleting a staging Worker deletes its secrets with it.
- [ ] A cloud computer never holds platform secrets, connected-account credentials or storage keys. It holds only the person's own Omnigent, Claude and Codex logins.
- [ ] Platform code copies the computer's login files as opaque bytes. It never parses or logs them.
- [ ] Real-account test runs use reviewed revisions only, are recorded in the work package's evidence, and end with a sign-out that is checked.
- [ ] Tests use synthetic values and runtime-generated canaries, never real credentials.

## On the owner's laptop (now)

| Secret | Purpose | Where | Removed by |
|---|---|---|---|
| Wrangler login | Deploy staging Workers | `~/.config/.wrangler/config/`, mode 600 | `wrangler logout` |
| `cf` CLI login | Access applications, account checks, Worker lookups | `~/.config/cloudflare/config/`, mode 600 | `cf auth logout` |
| GitHub CLI login | Pushes and pull requests | `~/.config/gh/`, mode 600 | `gh auth logout` |
| Staging configuration | Account ID, zone, owner email, identity provider ID. Identifying rather than secret | `~/.config/cloudflare-omnigent/staging/config.json` (or `$CFO_STAGING_DIR`), mode 600, outside the repository and shared by every worktree | Delete the file |
| Staging registry and locks | Which `cfo-stg-` deployments exist, with owners and expiries; the locks that keep staging commands from overlapping | `resources.json` and `locks/` in the same directory, mode 600 | `stg.ts teardown` or `sweep` |
| Staging Tunnel token | Lets a staging deployment's server container run the Tunnel that its `staging.jsonc` asks for | Read from Cloudflare by the staging tool at each deploy and uploaded as the Worker secret the manifest names, through a mode 600 file in a private temporary directory that is removed straight after. Never in argv, logs, the registry or the rendered configuration | Deleted with the Worker; the Tunnel is deleted at teardown |
| Real Claude and ChatGPT logins | Recorded real-account runs in spikes S6 and later | Only inside the staging computer under test | Sign out after each run, and check |

## In an installation (from M2 on)

Each installation runs in the person's own Cloudflare account. Rows marked "to confirm" are settled by the named spike or work package.

| Secret | Purpose | Where | Removed or rotated | Package |
|---|---|---|---|---|
| `OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME`, `OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD` | Pre-provision the owner's Omnigent account | Worker secrets, forwarded to the server container at start | The password secret is deleted only after the platform's refresh grant is durably stored (RC-02) | 2.4, S5 |
| Platform's Omnigent login | The platform reads schedules and repairs logins with its own grant | Platform Durable Object storage | Revoked by the owner, or replaced at repair | 2.4, S5 |
| Omnigent cookie secret | Omnigent's session cookies | Worker secret, written into the server's settings at start | Rotate by setting a new secret; existing sessions end | 2.2 |
| Litestream replica credentials | Replicate the server database to R2 | Worker secret passed to the server container (to confirm) | Rotate the R2 token | 2.3, S4 |
| Access team domain and audience tag | Validate Access tokens in the Worker | Worker variables. Configuration, not secret | Change with the Access application | 2.1, S5 |
| Computer login files: `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.omnigent/auth_tokens.json` (list to confirm) | The person's own CLI logins on their computer | On that computer, and in its credential checkpoint in R2. Restored only into the same computer | Sign-out writes a tombstone, so an older copy never brings it back | 3.4, S6 |
| Connection wrapping keys | Wrap each connected account's data key | Worker secrets, versioned | Rotation rewraps; revocation bumps the connection's generation | 5.3 |
| Connected-account tokens | GitHub, LinkedIn and later providers | Encrypted in each connection's Durable Object; used only by trusted components | Revoked on the Connected accounts page | 5.3–5.8 |
| Provider app credentials (to confirm per provider) | OAuth clients for the provider registry | Worker secrets | Rotate at the provider | 5.5–5.8 |
| Gateway authentication | Lets the server call the gateway for an approved operation | Issued by the server, short-lived | Expires; revoked with the connection | 5.4 |

## Test canaries

Tests generate canary values at run time. Committed text contains no canary. The scanner (`scripts/canary-scan.ts`) runs on the sources, the built Worker bundle and, from M2, the images. It must find a planted canary in its self-test before a clean result counts.
