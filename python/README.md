# python

The Omnigent plugin, published as the `cloudflare-omnigent` distribution. It is installed into the Omnigent server image.

Planned contents:

- **Sandbox provider** under `omnigent.community.sandbox.cloudflare`. Omnigent requires community providers to live in that namespace. It starts, resumes and stops cloud workspaces through the control plane.
- **`cloudflare_omnigent`**: the control-plane client, the MCP gateway backend and the schedule trigger, plus models generated from `contracts`.

The plugin depends on a pinned Omnigent release, or on a branch of the fork while it needs core changes that are not yet released.
