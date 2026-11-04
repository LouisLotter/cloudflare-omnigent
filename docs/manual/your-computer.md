# Your cloud computer

Your agents work on a cloud computer that belongs to you. It keeps its files between sessions, holds your Claude or Codex login, and sleeps when nothing is running on it. Nobody else can open its setup page or its terminal, and nobody else's work runs on it unless you share a session with editing rights ([Sessions and sharing](threads-and-sharing.md)).

## Adding one

1. In Omnigent, open **Settings → Computers** and choose **Add computer**.
2. Give it a name you will recognise, for example "Work", and add it.

The computer starts at once; this takes a minute or two. It is listed as needing setup until you have signed in to Claude or Codex on it. Choose **Set up / manage** next to it to open its page, which opens in a new tab. Settings → Computers also links the **computers page**, which lists all your computers with their setup, sign-ins and terminals.

## Signing in to Claude or Codex

Agents on your computer use your own subscription, so you sign in once, on the computer's page, with your own account. The login stays on that computer and is saved with it, so it survives sleep. Omnigent's server never receives it; like everything the computer saves, the saved copy is kept in the installation owner's Cloudflare account.

The page has a card for each service. Sign in to the one you use, or both.

**Claude:**

1. Choose **Sign in to Claude**.
2. Choose **Open Anthropic's sign-in page**, and sign in there with your Claude account. Anthropic then shows you a code.
3. Paste that code into the box on the card and choose **Continue**.

**Codex** (with a ChatGPT subscription):

1. Codex signs in with a device code, which your ChatGPT account must allow first. The card links to ChatGPT's security settings: open them and turn device-code sign-in on.
2. Choose **Sign in to Codex**.
3. Choose **Open OpenAI's page**, sign in there with your ChatGPT account, and enter the code the card shows. The card waits until you have finished.

Each card then says "Signed in" once the login is saved. A sign-in that is not finished within 10 minutes ends by itself; start it again. If a card later says **Sign in again**, the login expired or the service refused it: sign in again on that card only.

## Asleep and awake

A computer sleeps a few minutes after nothing is running on it, and wakes when there is work for it. It sleeps because a running computer costs money for every minute it is up, whether it does anything or not, and most of a day it has nothing to do. Asleep, it keeps everything it saved.

You never have to wake it yourself for normal work: starting a session on it wakes it, which takes about a minute. On its page, the sign-in buttons and **Open the terminal** also wake it first when it is asleep. The page tells you what it is doing meanwhile:

- **Starting**: Omnigent is starting it, for example just after you added it. The page updates when it is ready.
- **Not started yet**: no start is under way, for example because its first start was refused. In Omnigent's **Settings → Computers**, choose **Start again** if it says it failed to start.
- **Failed to start**: its last start failed. Start it again in Omnigent, under **Settings → Computers**, with **Start again**.
- **Not connected to Omnigent**: the page offers a restart, which ends work in progress.

There is no limit on how many computers can be awake at once, unless the installation's owner sets one. If they have, and a page says "All computers are busy", the limit is reached: try again in a few minutes, once another computer has gone to sleep. If Cloudflare itself cannot start a computer, Omnigent shows that its start failed; start it again later with **Start again** under Settings → Computers.

## Saving, and "Not saved yet"

The computer saves its files and its logins with the installation: while it works, and every time before it sleeps. That is how your work survives sleep, a restart, or the computer being replaced. The page shows when it last saved ("Last saved 14:05 UTC"). A computer you have just added shows **Not saved yet** until its first save; that is expected.

If saving keeps failing, the page says "Not saved for N minutes: new work is refused until a save succeeds". Work already running carries on, but no new work starts, so that nothing piles up that could be lost. It usually clears by itself once a save gets through; if it doesn't, ask the installation's owner.

The page also warns when the saved folders grow above 1.5 GB, because saving and waking then get slower. Delete what you no longer need.

## The terminal

The computer's page has a terminal: a command line on the computer, in the page. You don't need it for normal work. It is there for troubleshooting, and for signing in by hand if the buttons ever don't work. While the terminal is open, the computer stays awake; it closes after 30 minutes.

## Removing a computer

Open the computer's page and follow its **Remove this computer** steps. They sign it out of Claude and Codex first, then send you to Omnigent's **Settings → Computers** to delete it. Signing out runs each service's own sign-out on the computer, which does not prove the service ended the session: check your sessions in your Claude account and in ChatGPT's security settings, and end any you don't recognise.
