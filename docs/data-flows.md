# Where your data goes

An installation runs in your own Cloudflare account, and the services it uses work with your own accounts and logins. This page lists each place data leaves your machines or your Cloudflare account: what is sent, why, and on whose account. It covers the source at the 2 November 2026 snapshot, with Omnigent at the images' pinned fork commit `212fc5886`.

Each section says how we know:

- **Tested:** an automated test in this repository checks it.
- **In source:** we read it in the code (ours, or Omnigent's at the pinned commit), but no test checks it.
- **Documented:** the provider's documentation or our design says so. We have not checked it.

None of this has been checked by watching a running installation's network traffic.

## Summary

| Where | What goes there | On whose account | How we know |
|---|---|---|---|
| Cloudflare | Everything the installation stores: conversations, the database copy, uploaded files, cloud computers' saves (including their Claude and Codex logins), logs, your Access sign-in | Yours: the installation's Cloudflare account | In source; partly tested locally ([below](#cloudflare)) |
| Anthropic and OpenAI | What agents send to the models: your messages, and the files and command output the agents read | The person whose Claude or ChatGPT login the computer uses | Documented |
| GitHub | Code agents clone and push, pull requests; the GitHub link's sign-in | Yours: the installation's own GitHub App, and your GitHub account | In source; tested locally |
| Connected services (MCP), only those you turn on | The agents' tool calls to that service | Yours: your sign-in or key at that service | Destinations tested; the rest documented |
| Omnigent's product analytics | Nothing: off in every Omnigent process this project runs | (Omnigent's makers, if it were on) | The switch tested; that nothing else sends, in source |
| Claude Code's and Codex's own telemetry | On cloud computers: their telemetry and update checks off, and Claude Code's error reports. On your own machines: your own settings decide | The CLIs' makers | Settings tested; their effect documented |
| Package registries | Download requests while images are built, a machine is set up, or CI runs | Public registries; no account | In source |
| The daily tool version check | Nothing from any installation | This project's public repository on GitHub | In source; tested |

## Cloudflare

**What:** the whole installation. Omnigent's server runs in a container in your account, with its database on the container's disk and a continuous copy in an R2 bucket. Files people upload to Omnigent go to a second R2 bucket. Each cloud computer is a container too; its saves (its files, and its Claude and Codex logins) go to a third R2 bucket. The installation's Durable Objects keep the computers' and the server's state. The server's logs go to Workers Logs in your account; the cloud computers' logs and the per-request logs are off. Cloudflare Access checks every visit and knows who signed in: for example your email address, with the one-time PIN sign-in the installer sets up when your account has no sign-in method.

On your own machines (personal hosts), the Cloudflare One Client is registered to your installation's Zero Trust team. Only traffic to your installation's address goes through Cloudflare; the rest of the machine's traffic is untouched (an include-mode split tunnel).

**Why:** Cloudflare runs the installation.

**Whose account:** yours. Cloudflare is the operator, under your account's terms. R2 encrypts stored data, but the saves have no encryption of their own: anyone who controls your Cloudflare account can read the saved logins ([secret custody](secrets.md)). Omnigent's stored sign-ins (the GitHub link, connected services) are in the database only as ciphertext sealed by the platform Worker's key service.

**How we know:** in source ([Worker configuration](../worker/wrangler.jsonc), [server image settings](../images/server/cfo_server/config.py)), and tested locally. The cloud computers have not run on Cloudflare yet ([architecture](architecture.md)).

## The model providers: Anthropic and OpenAI

**What:** agents on a cloud computer run Claude Code or Codex, signed in with a person's own Claude or ChatGPT login, from the computer's setup page. Everything the model needs goes to Anthropic or OpenAI: your messages, the conversation so far, and the files and command output the agent reads.

**Why:** the model runs at the provider.

**Whose account:** the person whose login it is. A person's login lives only on their own computers: it is never shared with another person or handled by the platform. The provider's terms for that account apply. Whether the provider may use the conversations to train its models follows that account's privacy settings at the provider.

On your own machines, the CLIs use whatever logins and settings they already have there.

**How we know:** documented: what the CLIs send is their makers' documentation. Tested: the setup page accepts only the CLIs' own sign-in addresses. In source: the platform never reads a login file; it only saves and restores them with the computer.

## GitHub

**What:** with GitHub linking on, the installation has its own GitHub App, created in your GitHub account by `bootstrap.ts github-app` ([installing](install.md#github-for-your-cloud-computers-optional)). You link your GitHub account to Omnigent through it. Omnigent's server keeps that link's sign-in encrypted, renews it, and gives a cloud computer short-lived access tokens. Agents' git and gh on the computer then talk to GitHub directly: cloning, pushing, pull requests, on the repositories you chose for the App.

**Why:** so agents can work on your repositories.

**Whose account:** yours. The App can read and write repository contents and pull requests, and nothing else.

**How we know:** in source and tested locally; not yet run on Cloudflare.

## Connected services (MCP)

**What:** none, unless you turn a service on ([installing](install.md#connected-services-mcp-optional)). When one is on, Omnigent's server calls it for the agents, at the address the image's manifest fixes, with the tools the manifest lists. The agents' tool calls go there, with whatever the agent puts in them, which may include parts of the conversation.

| Service | Address (fixed by its manifest) | Signed in with |
|---|---|---|
| [GitHub's MCP server](../images/server/services/github.json) | `https://api.githubcopilot.com/mcp/` | Your GitHub link (above) |
| [OpenRouter's MCP server](../images/server/services/openrouter.json) | `https://mcp.openrouter.ai/mcp` | Your OpenRouter API key. Its tools include sending a message to another model, so those prompts go to OpenRouter and the model provider it routes them to, billed to your key. |
| [Demo work tracker](../images/server/services/tracker.json) (for testing) | The address you give when you turn it on | The demo service's own sign-in |

**Why:** to give agents tools from those services.

**Whose account:** yours, at each service. The sign-in stays in Omnigent's server and never reaches a computer.

**How we know:** the destinations and the server's settings are tested ([ADR 0008](decisions/0008-connected-accounts-omnigent-mcp-registry.md)). What each service does with the calls is its own documentation.

## Omnigent's product analytics: off

**What it is:** Omnigent has built-in product analytics. When they are on, Omnigent's server fetches a settings file from `config.omnigent-telemetry.io` and sends usage events to the address it names. On 2 November 2026 that file had analytics on for every installation, sending to `api.omnigent-telemetry.io`. At the pinned commit, the events record conversations being created, stopped and deleted, turns ending, usage (model, tokens, cost, latency), and rules being added or removed. They carry the conversation's ID, the agent's name and ID, the kind of agent, the kind of client (web page, command line), a random ID for the installation and for each host's machine, a hashed user ID, and the Omnigent and Python versions and the operating system. The event definitions hold no message text or file contents.

**What this project does:** every Omnigent process it runs has `OMNIGENT_ANALYTICS=0`, Omnigent's own off switch.

| Where | How | How we know |
|---|---|---|
| The server | The image sets it for Omnigent, and an installation's settings cannot turn it back on. | Tested: the settings test, and a test that runs Omnigent's own analytics start-up with the server's environment. The analytics never start, and the same test shows they would start without the switch. |
| Cloud computers | Set for everything the computer runs as the person: Omnigent's host, every runner the host starts (Omnigent drops it from runners unless the host names it in Omnigent's own pass-through list, which the computer does), the setup terminal and the sign-ins. | Tested in the image: the running host's environment, and Omnigent's own runner set-up and off-switch check. |
| Your own machines (personal hosts) | Set in the host's service and its runners (the same pass-through), and in the `omnigent-cfo` command. A machine set up before this change gets it the next time `scripts/host/omnigent-host.sh setup` runs there. | Tested: the setup's tests check the service's environment as its unit file sets it, and the command's. |

**With it off:** only Omnigent's server ever sends analytics, and with the switch it never starts them, so it contacts neither address. Hosts and runners send nothing to the analytics service themselves; they only tell the server that analytics are off. (In source.)

**How to check:** on your own machine, `systemctl --user show -p Environment omnigent-cfo-host.service` lists `OMNIGENT_ANALYTICS=0`. For the server and the cloud computers no page shows it yet; the image tests check it in every build.

**Later:** sending these events to a store in your own account instead is planned. Omnigent can already be pointed at a settings file of your own (`OMNIGENT_TELEMETRY_CONFIG_URL`).

### Other requests Omnigent makes by itself

- **Model lists.** When Omnigent lists a provider's models, it can download a public model list (`<provider>.json`) from MLflow's releases on GitHub, and caches it. Only the download request is sent. (In source; we have not checked when the installation's server does this.)
- **Update notice.** Omnigent's command line (`omnigent`, or `omnigent-cfo` on your own machine) checks PyPI for a newer Omnigent when a person runs it in a terminal. The host services never do, because they have no terminal. (In source.)

## Claude Code's and Codex's own telemetry

**On cloud computers:** the image turns off, for every CLI the computer runs (including inside agents' runners):

- Claude Code's telemetry, error reporting and self-updates (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`);
- Codex's analytics and its update check at start-up, in managed settings that a person's own Codex settings cannot override.

Not turned off: the CLIs' own feedback and bug-report commands, which send a conversation to their makers only when someone runs them.

**On your own machines:** the host setup does not change the CLIs' settings. Your own settings for Claude Code and Codex apply.

**How we know:** that the image sets these is tested ([image tests](../images/computer/tests/test_image.py)). What each setting turns off is the CLI makers' documentation; we have not captured a computer's network traffic to confirm it.

## Package registries: building, setting up and CI

**What:** download requests. They carry what any download does (the address it comes from, the tool's name and version, which package) and nothing from an installation.

- **Building the images**, on the installer's computer during an install or update: Docker Hub (the Python, Node and Cloudflare sandbox base images, by digest), Debian's package mirrors, PyPI (Python packages, checked by hash), npm (Claude Code, Codex, pnpm and the web interface's packages), and GitHub (Omnigent's source at the pinned commit; the gh, ttyd and Litestream releases). The built images then go to your Cloudflare account's container registry.
- **Setting up your own machine as a host:** GitHub (Omnigent's source at the pinned commit) and PyPI (built packages, checked by hash).
- **CI**, in GitHub Actions on this project's public repository: the same registries, and GitHub's actions. CI never has an installation's data or secrets.

**Whose account:** none; these are public registries.

**How we know:** in source ([server Dockerfile](../images/server/Dockerfile), [computer Dockerfile](../images/computer/Dockerfile), [host setup](../scripts/host/omnigent-host.sh), [CI](../.github/workflows/ci.yml)).

## The daily tool version check

**What:** a [workflow](../.github/workflows/tool-versions.yml) that runs every day in GitHub Actions on this project's public repository, not in any installation. It asks npm, GitHub, PyPI and Docker Hub for newer versions of the tools the images pin, and opens a pull request to bump them ([keeping the pinned tools current](compatibility.md#keeping-the-pinned-tools-current)). It reads public data only and uses no secret: only GitHub's own token for the run, read-only while it checks, and allowed to open the pull request when it proposes.

**Why:** to keep the pinned tools current.

**Whose account:** this project's repository on GitHub. Nothing from any installation is involved; an installation gets a new version only when its owner runs `bootstrap.ts update`.

**How we know:** in source and tested ([scripts/tool-versions](../scripts/tool-versions/)).
