# images

Container images, all `linux/amd64` and pinned by digest.

| Image | Based on | Adds |
|---|---|---|
| `server` | Omnigent server image | The `cloudflare-omnigent` plugin |
| `workspace` | Omnigent host image | Trust for the Cloudflare container CA, the Sandbox SDK helper, and an entrypoint that starts the Omnigent host |
| `linkedin` | LinkedIn MCP server image | Trust for the Cloudflare container CA and profile backups |

No image contains provider credentials. Containers reach model APIs, git and storage through intercepted hostnames that Worker code handles.
