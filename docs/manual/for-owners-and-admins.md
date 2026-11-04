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

**Remove** on Settings → Members takes a person off the team for good. It cannot be undone. Administrators can remove members; owners can also remove administrators and other owners. Nobody can remove themselves, and the team's last owner and the installation's own owner are always kept.

- **At once:** their account is deleted. Every sign-in, CLI login, laptop and runner of theirs stops working, their open pages close, their scheduled tasks stop, the shares they were given are taken away, and invitations to their address are revoked. Omnigent and the computers pages refuse them, and so does a Cloudflare sign-in they already had.
- **Straight after:** the installation tells Cloudflare's sign-in to stop letting their address through, and checks that it did. Their cloud computers stop and are handed over to be deleted.
- **Their work stays where it was.** Their threads are kept, and owners and administrators can still open them; nothing is moved to anyone else. If someone else should carry on with their work, ask them to share it before you remove them.
- **Invitations they sent** to other people stay pending. Revoke them if they should not be used.

Afterwards Settings → Members lists them under **Removed**, with each step: access blocked, the installation's sign-in no longer letting them in, their cloud computers handed over, and their threads. A step that has not finished yet says so and offers **Retry now**; removing them again is always safe.

To finish their computers, open the computers page. Each of their cards offers **Sign out of Claude and Codex**, then **Finish the removal**, which deletes the computer's saved files and logins. Two cases have their own button:

- **Delete without signing out** appears if the sign-out was tried and did not finish, or if a login may have changed after the computer's last save. The computer's saved files and logins are deleted, but the person's Claude and ChatGPT sessions are not ended: ask them, or the administrator of their Claude or ChatGPT account, to end those sessions in their Claude account and in ChatGPT's security settings.
- **Stop without saving** appears if the computer could not save before stopping three times. Work changed after its last save is lost. Once it has stopped, finish it as above.

After **Finish the removal** or **Delete without signing out**, the card says **Deleting…** until the saved files and logins are gone. Even after a normal sign-out, ask the person to check their Claude and ChatGPT sessions and end any that remain.

If a computer they deleted themselves is still being removed because it cannot save, wait for that to finish before you remove them: once they are removed, its card offers neither button.

If they join again later, it is with a new invitation, as a new member.
