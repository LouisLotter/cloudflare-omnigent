# Joining the team

You join through an invitation that an owner or administrator of the team makes for your email address. It takes a few minutes and three steps: a sign-in code from Cloudflare, accepting the invitation, and choosing your own username and password.

## The invitation link

The person who invites you gets a link once, on Omnigent's Members page, and gives it to you directly, for example in an email. The link works once, only for the address it was made for, and only for a few days (three, unless your installation chose otherwise). If it has run out, ask for a new one.

Open the link in a browser that is yours. If you share a computer, use your own browser profile: the installation recognises you by the sign-in in that browser, and a colleague's sign-in there would be taken for yours.

## The sign-in code

Before anything else, Cloudflare checks who you are. Its page asks for your email address and then emails you a one-time code (Cloudflare calls it a PIN):

1. Enter the address the invitation was made for, exactly.
2. Find the email from Cloudflare (it comes from `noreply@notify.cloudflare.com`) and type the code into the page.

Cloudflare sends a code only to addresses the team has invited, but its page says a code was sent whatever address you type. If nothing arrives within a few minutes, check that you typed the invited address, then look in your junk or spam folder. Your sign-in is remembered in that browser for a day; after that, Cloudflare asks for a new code.

## Accepting and choosing your password

1. Omnigent shows **Join your team**. Choose **Accept invitation**.
2. The next page, **Create your account**, says which team you are joining, as a member or an administrator, and with which address.
3. Choose a username: lowercase letters, digits, dots, hyphens or underscores (or a lowercase email address). Others in the team see it.
4. Choose a password of at least 8 characters and type it twice. Your browser's password manager can suggest one and save it.
5. Choose **Create account**. You are signed in and land in Omnigent.

Once you are in, the next step is your own computer: see [Your cloud computer](your-computer.md).

If the first page after the code stays on "Loading Omnigent…", reload the page once. This can happen on a browser's very first visit and is a known issue.

## When something is refused

The messages below are what you see when the address or the browser is not the right one. None of them means anything is broken.

| What you see | Why | What to do |
| --- | --- | --- |
| No code ever arrives | The address you typed is not the invited one, or the email is in your junk folder. | Type the invited address exactly; check junk. |
| "This invitation is for another email address; sign in with the invited address" | This browser is signed in to Cloudflare with a different address, for example a colleague's. | Use your own browser or browser profile, and sign in with the invited address. |
| "This invitation is invalid: it has expired, was already used or was withdrawn." | The link is used up or out of date. | Ask whoever invited you for a new one. |
| "You are already a member of this team. Sign in instead." | You have joined before. | Sign in with your username and password. |
| "You were signed in to Omnigent as someone other than the person signed in to this installation." | This browser holds another person's Omnigent sign-in. | Sign in with your own account. |
| "Your sign-in to this installation is not linked to a member of this team." | Your address is not a member, or your membership was removed. | Ask an owner or administrator for an invitation. |
| "Your membership of this team is suspended." | An owner or administrator suspended it. | Ask them. |
