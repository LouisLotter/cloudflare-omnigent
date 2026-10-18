# images

Container images. None exists yet; each arrives with its milestone. All are `linux/amd64`, with every base image pinned by digest.

| Image | Arrives | Based on | Adds |
|---|---|---|---|
| `server` | M2, WP2.3 | Omnigent's server image | Litestream at an exact tested release. An entrypoint that restores the database, enters recovery mode instead of public setup when an initialized installation's database is missing or corrupt, and writes the deployment-managed settings from the environment. A commit hook that holds security-relevant writes until they are replicated, or fails them with "applied, durability not yet confirmed". |
| `computer` | M3, WP3.4 | Omnigent's host image | Claude Code and Codex exactly as published, with telemetry, updates and plugins switched off. The Sandbox SDK's backup shim. The supervisor: starts the host only after both restores, with the fixed host identity from the environment; pauses processes under a time-limited lease for each capture; saves credential files with tombstones; checkpoints on SIGTERM. A test variant adds the fake CLIs. |
| `linkedin` | M5, WP5.6 | The LinkedIn MCP server image | Trust for the Cloudflare container CA, the backup shim for browser profiles, browser-cookie import switched off |

Rules:

- No image contains platform secrets or connected-account credentials. A cloud computer holds only the person's own Omnigent, Claude and Codex logins, created by signing in on it.
- Containers reach platform services only through intercepted virtual hosts, such as `omnigent.internal`, handled by Worker code. Cloud computers otherwise have ordinary internet access, so the CLIs talk to their providers unmodified.
- CI builds every image on each push. Deployment pushes them through Wrangler.
