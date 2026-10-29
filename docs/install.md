# Installing Omnigent in your Cloudflare account

This guide sets up one personal installation of Omnigent in your own Cloudflare account, with one command. The installer does everything it can by itself; what is left for you is what only you can do: pay for or choose a plan, sign in, and keep your password.

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

On your computer (Linux; macOS should work but is not tested yet):

- Git, [Node.js](https://nodejs.org/) 26 and pnpm 11.15.1;
- [Docker](https://docs.docker.com/get-docker/), running: the first install builds the server's and the cloud computers' images on your computer, which takes a while and several gigabytes of disk;
- Cloudflare's `cf` command, version 1.0.0-beta.18;
- a clipboard tool, so that the installer can hand you the password without showing it: `wl-copy` (Wayland) or `xclip` or `xsel` (X11) on Linux; macOS has `pbcopy` already.

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
5. **Makes your Omnigent password** and puts it on your clipboard, without showing it. Paste it into your password manager, then press Enter. Without a clipboard tool it asks you to type a password twice instead (`--password-prompt` does that on purpose).
6. **Makes the storage key** that only the server receives, and **deploys** the two parts of the installation. The first deploy builds the images, so it is the slow part.
7. **Waits** until the server has created your account and stored it safely, then removes the password from Cloudflare and checks that the server restarted without it. This usually takes 10 to 20 minutes after the deploy.

When it ends with `bootstrap: done`, the installation is ready. If it stops early (a missing step, a slow Cloudflare, your laptop going to sleep), run the same command again: it carries on where it stopped. Exit status 2 or 3 means "not finished yet, run it again".

## Your first sign-in

1. Open `https://<your address>`. Cloudflare Access asks who you are first: with the one-time PIN method, enter your email address and then the code it emails you. With the application the installer makes, Access remembers you for 24 hours.
2. Omnigent then shows its own sign-in. Use your username and the password from your password manager. You may change the password in Omnigent; keep the new one in your password manager too.

Anyone else who opens the address stops at Access and never reaches Omnigent.

## When something needs you

The installer stops with one sentence saying what to do, and the command to run again, when:

- your account lacks the plan, R2, the domain or a Zero Trust organization (payments and plan choices);
- your `cf` sign-in may not create something (Cloudflare answers "403 Forbidden"): it gives the dashboard step instead;
- an Access application someone else made already covers the address and lets in more than you;
- Cloudflare does not let it delete something it made earlier, such as a storage key; it names it, with the one click that deletes it.

## Removing an installation

There is no single command for this yet. `node scripts/bootstrap/bootstrap.ts remove-access` deletes the Access application the installer made, and `remove-r2-token` deletes the storage key; both refuse while the installation's Workers still exist, unless you add `--yes`. The Workers and the R2 buckets (your data) are deleted in the Cloudflare dashboard. See [the Access application](operations/recovery.md#access-application) and [uploaded files](operations/recovery.md#uploaded-files) in the recovery guide for the details.
