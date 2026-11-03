# Moving an installation to a team

An installation starts as a team of one: Access admits its owner only, and Omnigent's identity
binding is off. This page moves it to a team: Access admits the members Omnigent's team page
invites, and every request is tied to one member. It covers the rehearsal before the move, the
move itself, what to do if it stops in bind mode, and the two-person check to run before the first
real member is invited. Architecture and decisions: [architecture](../architecture.md) (team
members), [ADR 0004](../decisions/0004-identity-credential-authority.md).

The move needs a release whose Omnigent pin carries the team model. Until then
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

One run does all of it:

1. **The update**, with its restore point and read-only window: the member group (the owner's
   address only), the reconciler's token, the identity envelope on, Omnigent in bind mode. Inside
   the window `bootstrap.ts update --rollback` goes back, data included.
2. **The owner's sign-in.** Once the update is accepted, the run prints what to open: sign in to
   Omnigent once in your browser. That binds your Access identity to your account, once.
3. **The bind checks**, from the server's own reports: every active owner bound, Access's member
   group written, and this computer's Omnigent host connected through Access with a sign-in bound
   to you. Its host ID comes from Omnigent's configuration (`host.host_id`); give
   `--host-id <ID>` for another, or `--host-id none` when you use no personal host.
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

1. B: create B's own cloud computer, and start a thread on it. A: start a thread of A's own.
2. B: `/platform/computers` lists B's computer and none of A's. Open A's computer page (A copies its
   address): not found.
3. A: `/platform/computers` lists B's computer as a fleet card ("Belongs to …") with Stop only;
   its setup page and terminal are not found.
4. B: open `/v1/sessions` in the browser: none of A's threads is listed. Open A's thread address:
   refused. A, likewise, for B's thread.

**Suspension**

1. A: Settings, Members, B, Suspend. B's next page is refused, B's open pages close, and B's
   cloud computer can no longer be used. The group count goes back to 1.
2. A: Reinstate B. B signs in again in the browser; B's sessions from before stay ended.
3. A: remove the test member (Settings, Members, Remove), or leave B suspended.

Only then invite the first real member, the same way as step 1 of the invitation.
