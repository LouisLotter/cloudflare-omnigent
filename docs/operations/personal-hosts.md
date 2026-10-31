# Connect your own machine as a host

Your installation runs Omnigent on Cloudflare, with cloud computers it starts for you. You can also connect your own machines (a desktop, a laptop) as Omnigent hosts of the same installation. Then you sign in to `https://<your hostname>` and start and manage agents on any of them from one place. No Omnigent server runs on your machine, and nothing on it is reachable from the internet: each machine reaches your installation through the **Cloudflare One Client** (formerly WARP), signed in to your Zero Trust team as you, and Cloudflare Access still admits only you.

Status: built and tested in source (31 October 2026, WP3.43); not yet run on a real installation. Linux with systemd only for now; on a Mac, Omnigent's own `omnigent host enable` does the service part.

## Once, for your installation

From your checkout of this repository, on the machine where you installed:

```bash
node scripts/bootstrap/bootstrap.ts devices --owner-email <your address>
```

It changes only what it must, and says what it changed:

- **Your installation's Access application** lets a device that is signed in to the Cloudflare One Client as you in, without a browser sign-in ("Authenticate with Cloudflare One Client"). Only this application: the organization-wide default for every application stays as it is. Its owner-only rule is unchanged.
- **The client's session** lasts 30 days (`--client-session-days`, 1 to 90; an organization that already has one keeps it). When it ends, the client asks you to sign in again. A command-line tool whose session has ended gets a `401` instead of a login page, so the failure is visible.
- **Device enrollment** admits only you: only your email can connect a device to your Zero Trust team.
- **The default device profile's split tunnel** is in include mode with only your installation's hostname and your team's sign-in domain (`<team>.cloudflareaccess.com`, where the one-time PIN sign-in happens). Everything else on your machines goes to the internet as before. The earlier exclude list is kept in the installation's state file.

Cloudflare's updates of the organization and of an application replace the whole object, so the step reads each in full, changes only its own fields and writes the rest back as it was, then reads it again to check. It never changes an Access application it did not create: if your installation uses one someone else made, it names the one switch to turn on. `bootstrap.ts status` shows when the step last checked.

Two things to know about the split tunnel:

- A domain route sends the addresses the domain resolves to through the client. Your hostname resolves to Cloudflare's shared addresses, so other sites on those addresses also go through the client. That is routing, not a boundary: Access is what decides who gets in.
- If you sign in to Zero Trust with something other than the one-time PIN (Google, GitHub), its sign-in site must go through the client too. The step tells you when your account has such a login method.

## On each machine

1. Install the Cloudflare One Client. On Arch Linux: the AUR package `cloudflare-warp-bin`, which repackages Cloudflare's own `.deb` with a pinned checksum (`yay -S cloudflare-warp-bin`). Elsewhere: <https://pkg.cloudflareclient.com/>. Start its service: `sudo systemctl enable --now warp-svc`.
2. From a checkout of this repository:

   ```bash
   scripts/host/omnigent-host.sh setup --server https://<your hostname>
   ```

   It does, and checks, each part:
   - registers the client with your team (`warp-cli registration new <team>`): a browser opens, you sign in with your email, and choose **Open Link** at the end. It finds the team name itself; `--team` gives it;
   - connects the client, and checks that Access lets the machine through to Omnigent;
   - installs the Omnigent build your installation runs, as the command `omnigent-cfo`, side by side with any other Omnigent: its own Python environment, data and configuration under `~/.local/share/omnigent-cfo` and `~/.config/omnigent-cfo`. It never touches another `omnigent` command or `~/.omnigent`;
   - signs that command in to your installation: Omnigent asks for your **Omnigent** username and password (the ones for the web page). Omnigent keeps its session in its own store; the setup never sees it;
   - starts Omnigent's host as the user service `omnigent-cfo-host`, which starts with your session and is restarted whenever it stops, and waits until your installation lists the machine as an online host.

Run it again at any time: it changes only what is missing. After you update your installation to a release with a new Omnigent build, run it again on each machine: Omnigent refuses work on a host whose build is older than the server's.

`scripts/host/omnigent-host.sh status` shows each check. `scripts/host/omnigent-host.sh remove` removes the service, the command, its build and its sign-in, and leaves the client registered (`warp-cli registration delete` removes the machine from your team).

A user service runs while you are signed in to the machine. For a machine you never sign in to, `loginctl enable-linger` keeps your services running.

## Starting agents

- **From the web page:** start a session and choose the machine as its host.
- **From the machine itself:** `omnigent-cfo run --server https://<your hostname> --agent <agent> -p "<prompt>"` starts a session whose runner the server launches on this machine's host, in the current directory.
- **On another host, from a script:** Omnigent's Python client, in the `omnigent-cfo` environment, lists your online hosts and creates a session on the one you name:

  ```python
  # ~/.local/share/omnigent-cfo/venv/bin/python this.py, with OMNIGENT_DATA_DIR and
  # OMNIGENT_CONFIG_HOME as in ~/.local/bin/omnigent-cfo.
  import asyncio
  from omnigent.cli_auth import load_token
  from omnigent_client import OmnigentClient

  SERVER = "https://<your hostname>"

  async def main() -> None:
      token = load_token(SERVER, min_remaining_seconds=60)
      async with OmnigentClient(SERVER, headers={"Authorization": f"Bearer {token}"}) as client:
          agent = await client.sessions.resolve_agent("<agent name>")
          hosts = await client.sessions.list_launch_hosts(harness=agent.harness)
          host = next(h for h in hosts if h.name == "<host name>")
          session = await client.sessions.create_from_agent_id(
              agent.id, host_id=host.host_id, workspace="/home/<you>/<project>"
          )
          await client.sessions.post_event(session.id, {
              "type": "message",
              "data": {"role": "user", "content": [{"type": "input_text", "text": "<prompt>"}]},
          })

  asyncio.run(main())
  ```

**Schedules:** with more than one host online, pin each scheduled task to the host it should run on. An unpinned schedule may start on whichever host is online, your laptop included.

## When something stops

- **The client's session ended** (after 30 days, or after a revocation): the client asks you to sign in again. Until you do, Access refuses the machine with a `401`; the host keeps retrying and reconnects by itself once you are signed in. `status` shows `Access … lapsed`.
- **Omnigent's sign-in ended** (you changed your Omnigent password, which signs out every session and every machine's command line): `status` shows the sign-in as missing; run `setup` again and sign in.
- **The host does not come online:** `journalctl --user -u omnigent-cfo-host` shows Omnigent's own messages.

The setup never works around a refusal with a public route, a service token or copied Cloudflare credentials.

## A lost or stolen machine

1. Revoke the machine in Zero Trust: **Team & Resources → Devices**, the machine, **Revoke**. Its client then gets no new session, so Access refuses its new connections. A connection already open is not cut by Access.
2. Change your Omnigent password on `https://<your hostname>/platform/password`, from another device. This signs out every Omnigent session and every machine's command line, so the lost machine's stored sign-in is useless.
3. In Omnigent, remove the machine's host.

Then check from another device that the machine's host shows offline.

## What a personal host holds

A personal host is an ordinary Omnigent host: Omnigent's command line on it holds your Omnigent sign-in (a session and its refresh grant), and the host runs agents as your user on that machine, with your files. That is more than a cloud computer holds, by design: it is your machine. See [Security](security.md#personal-hosts).

The Omnigent build is the commit your installation's images pin, installed from that commit's lock file with every dependency's hash checked, plus the images' certifi pin. Each build's directory records the commit, the locked dependency list (`cfo-requirements.txt`) and what the environment holds (`cfo-freeze.txt`), and `setup` checks that the running service is that build.
