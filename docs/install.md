# Installing Omnigent in your Cloudflare account

This guide sets up one personal installation of Omnigent in your own Cloudflare account, with one command. The installer does everything it can by itself; what is left for you is what only you can do: pay for or choose a plan, sign in, and choose your password.

The project is not production-qualified yet (see the [README](../README.md)). Expect rough edges, and keep anything important elsewhere too.

## What you need first

In your Cloudflare account:

| What | Why | Where |
|---|---|---|
| The **Workers Paid** plan | The Omnigent server runs in a container, which needs it. It is a monthly subscription. | <https://dash.cloudflare.com/?to=/:account/workers/plans> |
| **R2** enabled | R2 keeps the server's database copy and your uploaded files. Cloudflare asks for a payment method. | <https://dash.cloudflare.com/?to=/:account/r2/overview> |
| A **domain** on Cloudflare | Omnigent gets an address on it, such as `omnigent.example.com`. The domain must be active in the same account. | <https://dash.cloudflare.com/?to=/:account/add-site> |
| A **Zero Trust organization** | Cloudflare Access, part of Zero Trust, makes sure only you can reach the address. Choose a team name and the Free plan; Cloudflare asks for a payment method even for the Free plan. | <https://one.dash.cloudflare.com/> |

You do not have to check these yourself: the installer reads your account before it writes anything, and tells you what is missing, each with its link. If it cannot read something, it says "could not check" and carries on.

On your computer (Linux; macOS is not supported yet: the installer's locks need `flock` from util-linux, and macOS has no memory-backed directory for the moment a secret is handed to Wrangler):

- Git, [Node.js](https://nodejs.org/) 26 and pnpm 11.15.1;
- [Docker](https://docs.docker.com/get-docker/), running: the first install builds the server's and the cloud computers' images on your computer, which takes a while and several gigabytes of disk;
- Cloudflare's `cf` command, version 1.0.0-beta.18.

```bash
git clone https://github.com/LouisLotter/cloudflare-omnigent.git
cd cloudflare-omnigent
pnpm install --frozen-lockfile
npm install --global --allow-scripts=workerd cf@1.0.0-beta.18
```

## The two sign-ins

The installer acts in your account with your own Cloudflare sign-in, given to two tools. Each opens your browser; sign in as yourself, the owner, not as a helper: the storage key the installer makes belongs to whoever signed in.

```bash
cf auth login
pnpm --dir worker exec wrangler login
```

## The one command

Choose the address, your email address (the only one Access will let in) and your Omnigent username, then run:

```bash
node scripts/bootstrap/bootstrap.ts install \
  --hostname omnigent.example.com \
  --owner-email you@example.com \
  --owner-username you
```

If your sign-in reaches more than one Cloudflare account, the installer says so: add `--account <account ID>` (`cf accounts list` shows them).

What it does, in order:

1. **Checks your account** for the four things above, and stops, with the links, if one is missing. Nothing has been created yet.
2. **Plans the installation** and keeps the plan on your computer (in `~/.config/cloudflare-omnigent/installations/`). It holds no password or key.
3. **Creates the storage buckets** in R2, empty.
4. **Puts Cloudflare Access in front of the address**, before anything can be reached there: an application that lets in your email address only. If your account has no login method for Access, it adds the one-time PIN method, which emails you a code. If an Access application already covers the address, the installer uses it only if it lets in you alone, and otherwise stops and says what to change; it never changes or widens an application it did not make.
5. **Creates your Omnigent account without a usable password.** It gives the server a random starting password that nobody ever sees, not even the installer, so the account exists from the start but nobody can sign in as you until you choose your password on the site (below). If you would rather type a password here, add `--password-prompt`: it asks twice, without showing it.
6. **Makes the storage key** and the **cloud computers' signing key**, which only the server and the installation receive, and **deploys** the two parts of the installation. The first deploy builds the images, so it is the slow part.
7. **Waits** until the server has created your account and stored it safely, then removes the starting password from Cloudflare and checks that the server restarted without it. This usually takes 10 to 20 minutes after the deploy.

When it ends with `bootstrap: done`, the installation is ready, and it prints the one link to open. If it stops early (a missing step, a slow Cloudflare, your laptop going to sleep), run the same command again: it carries on where it stopped. Exit status 2 or 3 means "not finished yet, run it again".

## Your first visit: choose your password

1. Open `https://<your address>`. Cloudflare Access asks who you are first: with the one-time PIN method, enter your email address and then the code it emails you. With the application the installer makes, Access remembers you for 24 hours.
2. The page **Choose your Omnigent password** opens by itself. Your username is shown; type a password twice (at least 8 characters) and choose **Set my password**. Your browser's password manager can suggest one and save it.
3. Choose **Sign in to Omnigent**, and sign in with your username and the new password.

If you typed a password at install (`--password-prompt`), step 2 is skipped: Omnigent's own sign-in comes straight after Access.

Anyone else who opens the address stops at Access and never reaches Omnigent or this page.

## Forgot your password?

Open `https://<your address>/platform/password` (also linked as "Omnigent password" at the top of the cloud-computers pages). After Access, it offers **Reset your Omnigent password**: choose a new one the same way. A reset signs you out of Omnigent everywhere, in every browser and on every device, so that anyone who might have had the old password is out too; your cloud computers keep running. Only you can reach this page: Access lets in your address alone, and the installation checks it again.

## GitHub, for your cloud computers (optional)

So that agents on your cloud computers can clone and push your repositories, give the installation its own GitHub App. Once the installation is ready, run:

```bash
node scripts/bootstrap/bootstrap.ts github-app
```

1. Your browser opens on GitHub with the App already filled in. Click **Create GitHub App**. (`--github-org <name>` creates it under an organization instead of your own account.) The installer waits an hour for this click; if you come back later, the page says the link expired and what to do.
2. Your browser shows "Setting up GitHub" while the installer stores the App in Cloudflare, without showing any of its secrets, and Omnigent's server restarts once to turn GitHub linking on. This takes a few minutes; the page moves on by itself.
3. Once the server reports GitHub linking on, your browser moves on to GitHub's page that installs the App. Choose the repositories it may reach, and click **Install**.
4. GitHub brings you back to your installation, which opens Omnigent's Integrations settings. Click **Connect GitHub** there and approve on GitHub.

The installer ends by saying that GitHub linking is on, with the same two links. If GitHub linking does not come on, both the browser and the installer say so plainly instead: the server restarted with the App but GitHub linking stayed off, the server did not start with the App's settings, or it was not on within 20 minutes. In the last case you can still install the App: GitHub brings you to a page of your installation (`https://<your address>/platform/github`) that waits until GitHub linking is on and then opens Connect GitHub, or says what is wrong. GitHub also brings you there after you change which repositories the App may reach.

From then on, git and gh on your cloud computers act as you on those repositories. The App can read and write repository contents and pull requests, and nothing else. To stop it, use **Disconnect** in Omnigent's settings; a token a computer already received stays valid at GitHub for up to 8 hours. You can also uninstall or delete the App on GitHub at any time.

An installation made before GitHub linking, or before its setup page, needs updating first (below); the command says so, and changes nothing until then.

## Connected services (MCP), optional

Omnigent can give your agents tools from other services, such as GitHub's, through its own MCP registry: Omnigent's server holds your sign-in to each service and calls the service for your agents, so the sign-in never reaches a cloud computer. This release ships two services: a demo service for testing, and GitHub's MCP server, which uses the GitHub link above. To see them, run:

```bash
node scripts/bootstrap/bootstrap.ts services
```

To turn one on (here GitHub's; set up GitHub linking first):

```bash
node scripts/bootstrap/bootstrap.ts services add github
```

1. If the service needs something from you, the command asks for it in the terminal: the service's address (or give it with `--origin https://…`), or an OAuth client's ID and secret, which are never shown as you type. It checks them before changing anything.
2. It stores your choice in Cloudflare and waits while Omnigent's server restarts once to take it up (a few minutes).
3. It ends with "Ready" and the link to Omnigent's **Settings → MCP**. There, click **Connect** next to the service and sign in at the service. **Test connection** lists the tools it offers.
4. In a new conversation, turn the service on in the **MCPs** picker above the message box. Your choice is remembered for the next conversation.

If the service stops accepting your sign-in (you removed Omnigent's access on its site, or it expired), Settings → MCP and the picker say **Reconnect needed**: click **Reconnect** and sign in again. To stop using a service, click **Disconnect** in Settings → MCP; to remove it from the installation, run `services remove <name>`. Disconnecting deletes your sign-in from Omnigent at once, but the service still lists Omnigent as allowed until you remove it on the service's own site. If the command ends with "held" (exit status 1), the server did not start with the change: run the `services remove` command it names to undo it. An installation made before this feature needs updating first (below); the command says so.

## Updating your installation

When a new release comes out, get it, with the tools it pins, and run the update, in the folder you installed from:

```bash
git pull
pnpm install --frozen-lockfile
node scripts/bootstrap/bootstrap.ts update
```

It deploys the new release to both parts of your installation, with the same names, storage and settings, and adds anything the release needs that your installation lacks, such as the cloud computers' signing key or the keys Omnigent stores your service sign-ins with. Your data, your password, your sign-ins and your GitHub App stay. The server restarts once on the new release, and the command waits for that (usually 10 to 15 minutes, as the images are built again), checks that the server answers and that your account is still there and stored safely, and ends with the link to open.

- With changes of your own in the folder (anything `git status` shows), it stops and says so: it only deploys a release exactly as published.
- If it stops early, run it again: it carries on where it stopped. Exit status 3 means "deployed, not checked yet, run it again"; that run only checks.
- Run it when nothing is new, and it says the installation is up to date.
- Running the `install` command again does the same on a finished installation.
- The release that brings Omnigent 0.20 also changes Omnigent's database, so after it you cannot go back by deploying the earlier release, and `update` does not yet keep a copy of your data to go back to (that is being added). An update interrupted while it changes the database is simply finished at the next start. Updating an existing installation to it has not been tried on Cloudflare yet. A cloud computer that is awake during the update keeps the earlier Omnigent until it next sleeps, about a quarter of an hour after its last chat goes quiet; until then a new chat on it is refused ("This computer cannot safely select which session runner to replace…"). Try again a little later. Details: [the 0.20.0 upgrade](compatibility.md#the-omnigent-0200-upgrade-30-october-2026).
- New versions of the tools on your cloud computers (Claude Code, Codex, gh and others) come the same way: a daily check proposes them to the project as one pull request, and once it is merged, `update` brings them to your installation. Each computer picks up the new image the next time it starts or wakes. The tools never update themselves on a computer. See [keeping the pinned tools current](compatibility.md#keeping-the-pinned-tools-current).

## When something needs you

The installer stops with one sentence saying what to do, and the command to run again, when:

- your account lacks the plan, R2, the domain or a Zero Trust organization (payments and plan choices);
- your `cf` sign-in may not create something (Cloudflare answers "403 Forbidden"): it gives the dashboard step instead;
- an Access application someone else made already covers the address and lets in more than you;
- Cloudflare does not let it delete something it made earlier, such as a storage key; it names it, with the one click that deletes it.

## Removing an installation

There is no single command for this yet. `node scripts/bootstrap/bootstrap.ts remove-access` deletes the Access application the installer made, and `remove-r2-token` deletes the storage key; both refuse while the installation's Workers still exist, unless you add `--yes`. The Workers and the R2 buckets (your data) are deleted in the Cloudflare dashboard. See [the Access application](operations/recovery.md#access-application) and [uploaded files](operations/recovery.md#uploaded-files) in the recovery guide for the details.
