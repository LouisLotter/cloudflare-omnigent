# What isn't there yet

The installation is deliberately simple for now. These are the things it does not do, so that nobody counts on them.

**No quotas or cost limits.** Nothing limits how much a member's agents run, or what they spend on services billed by use. The team is trusted to use the installation sensibly. Your Claude or Codex subscription has its own limits, set by the provider; for a service that bills by use, such as an API key you connect, set a spending limit on the service's own site.

**No limit on awake computers.** Any number of cloud computers can be awake at once, unless the installation's owner sets a limit. What keeps the cost down is that each one sleeps a few minutes after nothing is running on it. If the owner has set a limit and it is reached, a computer that should wake says "All computers are busy" until another one goes to sleep.

**Laptops as hosts are owner-only.** The installation's owner can connect their own machines as hosts, so that sessions run there instead of on a cloud computer. Other members cannot do this yet: use a cloud computer.

**No shared company logins for services.** Every connection in Settings → MCP belongs to one person ([Connections](connections.md)).

**Removal is basic.** Removing a member deletes their account and removes their computers, but there is no checklist across every system yet, and no handing over of their work ([For owners and administrators](for-owners-and-admins.md#removing-someone)).
