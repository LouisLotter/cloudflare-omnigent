# Moving an installation to a team

An installation starts as a team of one: Access admits its owner only, and Omnigent's identity
binding is off. This page moves it to a team: Access admits the members Omnigent's team page
invites, and every request is tied to one member. It covers the rehearsal before the move, the
move itself, what to do if it stops in bind mode, and the two-person check to run before the first
real member is invited. Architecture and decisions: [architecture](../architecture.md) (team
members), [ADR 0004](../decisions/0004-identity-credential-authority.md).

The move needs a release whose Omnigent pin carries the team model and what the move checks with
(WP8.11's fork part, from `cfo/teams` `922b69c62`). With an earlier pin,
`bootstrap.ts update --team-admission members` refuses and changes nothing.

## 1. Rehearse on a copy of the database

The fork's migrations run when the new server starts. The rehearsal runs them first, with the
new server image and no network, on a throwaway copy of the database, and checks:

- every table keeps its rows;
- the team exists, with exactly one active owner: the installation's named owner, designated the
  founding member;
- runner bindings on cloud computers are retired (each thread binds again at its next launch),
  and those on personal hosts are kept;
- a synthetic Access identity binds as the founding owner once, and a second one cannot.

1. Restore the replica to a local SQLite file, as the restore drill does. This step reads R2 with
   the installation's own credentials; do it on a machine you trust, and delete the file after.
2. Build the new server image from the release's checkout:

   ```bash
   docker build --platform linux/amd64 -f images/server/Dockerfile --target server -t cfo-server:rehearsal .
   ```

3. Run the rehearsal on the file, with the owner's Omnigent username:

   ```bash
   scripts/restore-drill/team-rehearsal.sh /path/to/omnigent.db <owner username>
   ```

   It copies the file into a private temporary directory, runs the image with `--network none`
   against the copy, prints a JSON report (counts and checks, no names), and deletes the copy.
   Exit 0: every check passed.
4. Delete the restored file.

## 2. Move

From a clean checkout of the release, on the computer whose Omnigent host should be checked:

```bash
node scripts/bootstrap/bootstrap.ts update --team-admission members --owner-email <owner address>
```

Before it changes anything, it checks two things and stops if either fails:

- **This computer's host ID** is found where `scripts/host/omnigent-host.sh` keeps the host's
  configuration: `host.host_id` in `${XDG_CONFIG_HOME:-~/.config}/omnigent-cfo/config.yaml`, or
  in `$OMNIGENT_CONFIG_HOME/config.yaml` when that is set. Give `--host-id <ID>` for another host
  (`omnigent-cfo host status` shows the ID), or `--host-id none` when you use no personal host.
- **The hostname's Access application is the installation's own**: the one the installer created
  and the state file records. The move switches that application's policy to the member group and
  never changes one the installer did not create. If yours is not its own, delete it (Zero Trust
  dashboard, Access, Applications) and run the same command: the update creates the
  installation's own owner-only application first (Omnigent is unreachable for the minute
  between), then the move goes on.

One run does all of it:

1. **The update**, with its restore point and read-only window: the member group (the owner's
   address only), the reconciler's token, the identity envelope on, Omnigent in bind mode. Inside
   the window `bootstrap.ts update --rollback` goes back, data included.
2. **The owner's sign-in.** Once the update is accepted, the run prints what to open: sign in to
   Omnigent once in your browser, with your password. That binds your Access identity to your
   account, once. If Omnigent opens without asking you to sign in, sign out from your account
   menu and sign in again: only a browser sign-in made since binds.
3. **The bind checks**, from the server's own reports: every active owner bound, Access's member
   group written, and this computer's Omnigent host connected through Access with a sign-in bound
   to you (the host ID found above).
4. **Required mode**: Omnigent honours a person's sign-in only through Access from then on. The
   server restarts once, and the same checks run again. If they do not pass within the wait, the
   run puts Omnigent back in bind mode and says why.
5. **Members admission and the member group's policy**: the team page decides who Access admits.
   The group holds the owner alone until someone is invited.

A run that has to wait (the sign-in, a server restart) says what it waits for and exits 3; run the
same command again, and it goes on without repeating what is done. When it finishes, it lists what
is left for you:

- restart each cloud computer from its page (`/platform/computers`, the computer, Restart), so it
  runs the release's computer image;
- set up this computer's Omnigent host again for the release, then check it reconnects:
  `omnigent host status`.

## 3. If the move stops in bind mode

Bind mode keeps everything working: a sign-in nobody is bound to proceeds as before. The run stops
there when something would be refused in required mode, and says which:

- **This computer's host connects with another Access identity** ("the device's sign-in is not the
  same Access identity as your browser's"). The Cloudflare One Client signed in through a different
  identity than your browser. Check that the One Client uses the same login method and address as
  your browser (`bootstrap.ts devices` set it up), sign it in again if not, and run the move again.
  If the identity is still different, the host needs its own binding, which Omnigent does not offer
  yet: leave the installation in bind mode and see below.
- **Another of your hosts** is named by its ID's first eight digits: sign it in the same way, or stop
  it, then run again.
- **A host reaches Omnigent without Access** (no sign-in at all): connect it through the
  installation's hostname with the One Client.

The device-identity case is not built yet. It would let you link the device's identity yourself, with
proof from both sides:

1. The host, signed in with your own credential under its own (unbound) Access identity, asks
   Omnigent for a short link code.
2. You confirm the code on a page in your browser, under your bound identity.
3. Omnigent then binds the device's identity to your membership, once, with provenance
   `device_link`.

It never uses the founding owner's one-time binding.

## 4. The two-person check

Before the first real member is invited, check isolation, the invitation and suspension with a
second address of your own as the test member: **A** is you, **B** the test member. Use two browser
profiles (or two browsers), one per person, so their sign-ins never mix. Everything below goes
through each person's own pages and API in their own browser.

The member group's ID is in the state file (`journal.team.memberGroup.id`). This read-only command
prints how many addresses Access admits, never the addresses:

```bash
cf zero-trust access rule-groups get <group ID> | jq '.include | length'
```

**Invitation**

1. A: Settings, Members, Invite someone: B's address, role Member. Copy the link it shows once.
   The group count goes from 1 to 2.
2. B: open the link. Access asks for a one-time PIN sent to B's address; then choose a username and
   password. B lands in Omnigent.
3. A: Settings, Members shows B as an active member.

**Isolation** (each person's own browser)

The checks below need the installation's sharing settings as the platform sets them: sharing
between members on (`OMNIGENT_SHARING_MODE` unset, or `on`), public sharing off and new threads
never public (the image pins both). Share none of the threads used here, except in the sharing
step below.

1. B: create B's own cloud computer, and start a thread on it. A: start a thread of A's own.
2. B: `/platform/computers` lists B's computer and none of A's. Open A's computer page (A copies its
   address): not found.
3. A: `/platform/computers` (linked from Settings → Computers, "Other people's computers are on the
   computers page") lists B's computer as a fleet card ("Belongs to …") with Stop only;
   its setup page and terminal are not found. Another person's computer setup and terminal stay
   that person's alone, for owners and administrators too.
4. B: open `/v1/sessions` in the browser: none of A's threads is listed. Open A's thread address:
   refused.
5. A: B's thread **is** listed and opens. That is expected: owners and administrators keep access
   to members' threads (owner decision D52). It is not a failed check; what B can see of A's threads is.
6. **Sharing:** A opens A's thread, Share, adds B as **Read**. B: the thread is now listed and
   opens, and B cannot send it a message. A: take B's access away again (the bin icon in the
   same dialog). B: the thread is refused again.

**Suspension**

1. A: Settings, Members, B, Suspend. B's next page is refused, B's open pages close, and B's
   cloud computer can no longer be used. The group count goes back to 1.
2. A: Reinstate B. B signs in again in the browser; B's sessions from before stay ended.

**Removal** (remove the test member)

1. B: start a thread on B's cloud computer, and keep it open.
2. A: Settings, Members, B, Remove, then confirm. B's open page closes, B's next page is refused,
   and signing in again says the sign-in is not linked to a member of this team. The group count
   goes back to 1. Invitations B sent to other people stay pending; revoke them if they should not.
3. A: the Members page lists B under Removed: access blocked, the installation's sign-in no
   longer lets them in, cloud computers handed over 1 of 1, no laptop registrations to revoke,
   and B's threads, which open for A. A step that is not done yet says so and offers Retry now.
4. A: `/platform/computers` shows B's computer as a fleet card that stops, then offers Sign out of
   Claude and Codex. Sign it out, then Finish the removal: its saved files and logins are deleted
   and the card goes. If the sign-out does not finish, the card offers Delete without signing out
   instead; it says that B's provider sessions are not revoked, so B (or the provider account's
   administrator) revokes them at claude.ai and in ChatGPT's settings. If the computer cannot
   save before it stops, the card offers Stop without saving after three tries. After either
   deletion the card shows Deleting… until the saved files and logins are gone.
5. B: `/platform/computers` is refused.

Only then invite the first real member, the same way as step 1 of the invitation. Give them the
[user manual](../manual/README.md): [joining](../manual/joining.md) walks them through the link,
the code and their password, and [your cloud computer](../manual/your-computer.md) through
their first computer and sign-in. Owners and administrators find the team's computers on
`/platform/computers`, linked from Settings → Computers ([for owners and
administrators](../manual/for-owners-and-admins.md#the-teams-computers)).

Whenever you remove someone, first look on `/platform/computers` for a computer of theirs that
they deleted themselves and whose removal is still waiting. It finishes once it saves. If its
saves keep failing, it does not finish, and removing the person does not change that: Omnigent
handed that computer to the platform when they deleted it, so the removal does not name it
again, and its card offers an administrator neither Stop without saving nor Delete without
signing out. Until that is built, keep them a member while such a computer is waiting, and
report it.
