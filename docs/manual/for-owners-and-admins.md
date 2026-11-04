# For owners and administrators

A team has three roles. **Members** use the installation. **Administrators** also invite members, suspend and reinstate them, reset their passwords, and see the team's computers. **Owners** can do all of that for administrators and other owners too, and are the only ones who change roles. The team always keeps at least one active owner.

You manage the team on Omnigent's **Settings → Members** page.

## Inviting someone

1. On Settings → Members, choose **Invite someone to the team**.
2. Enter the email address they will sign in with, and choose their role. Administrators can invite members; only owners can invite administrators.
3. Omnigent shows the invitation link once. Give it to them directly, for example in a message from your own email.

The link works once, only for that address, for a few days (three by default). Inviting the address is also what lets Cloudflare's sign-in admit it, so the person can get their one-time code. Pending invitations are listed below the members, with when each expires, and can be withdrawn there. What the person then does is in [Joining the team](joining.md).

## Roles

An owner changes a role with the role menu next to the person. Making someone an administrator gives them the powers above; making them an owner gives them everything, including changing roles. Remember that owners and administrators can open every member's sessions ([Sessions and sharing](threads-and-sharing.md)): give those roles to people the team trusts with that.

## Suspending and reinstating

**Suspend** signs the person out everywhere at once: their browser sessions, their laptops and their running work lose access, open pages close, and their scheduled tasks pause. Their sessions, computers and files are kept. Use it when someone is away for a while, or when an account may be misused.

**Reinstate** lets them back in. Everything from before the suspension stays signed out, so they sign in again in their browser, and each of their cloud computers starts again the next time it is used. Administrators can suspend and reinstate members; only owners can do it for administrators and owners. Nobody can suspend themselves.

## Resetting a password

**Reset** next to a person gives them a new password, which Omnigent shows you once. Give it to them yourself, for example in a message from your own email. The reset signs them out everywhere; they then sign in with it and change it under Settings → Account. You never see their current password.

## The team's computers

As an owner or administrator, you see the other members' cloud computers on the computers page, `/platform/computers`, under **The team's other computers**. To get there, use **Computers page** in Omnigent's sidebar, the link on **Settings → Computers** ("Other people's computers are on the computers page"), or **All computers** at the top of any of your own computers' pages.

Each card says whose computer it is and how it is doing. You can **Stop** it, which ends its work in progress; it starts again when its owner next uses it. When a computer is being removed, you can also finish its removal there. You cannot open another person's computer page, sign in on it or open its terminal: its setup and its logins stay its owner's alone.

## Removing someone

**Remove** on Settings → Members deletes the person's account. This is today's removal, and it cannot be undone:

- In the same step, their membership ends, every session share they had is taken away, their scheduled tasks stop and their Omnigent sign-ins on other devices end.
- Their cloud computers are then removed. Each one's saved files and logins are kept until its removal is finished: on the computers page, its card offers **Sign out of Claude and Codex** and then **Finish the removal**, which deletes them.
- Omnigent's confirmation warns that sessions they owned become inaccessible, unless someone else can manage them. If their work matters, ask them to share it or hand it over before you remove them.
- Omnigent and the computers pages refuse them at once. Cloudflare's sign-in can still let their address through for up to an hour, until the installation next sends it the team's list; they can get a code in that time, but nothing past it lets them in.
- The sign-out on their computers runs Claude's and Codex's own sign-out, which does not prove the providers ended those sessions. Ask the person to end their sessions in their Claude and ChatGPT accounts.

If they join again later, it is with a new invitation, as a new member.

Fuller removal (a checklist across every system, and handing work over) is being built; this section changes when it arrives.
