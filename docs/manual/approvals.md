# Approvals

## What an approval is

Some actions an agent wants to take need a person's yes first: running a command the session's rules hold back, sending something through a connected service, or anything a rule on the installation marks as "ask". The agent then stops and waits, and a card appears in the session saying what it wants to do. Nothing happens until someone answers. Agents themselves can never answer an approval, only a person signed in through a browser.

You find waiting approvals in two places: as a card in the session itself, and in your **Inbox**, which lists every approval waiting for you across your sessions. Read what the card says the agent will do, then approve or reject it.

## Who can answer

Two kinds of question reach you, and they are answered differently:

- **Questions from the agent** (a choice between options, a plan to review, Claude's or Codex's own "may I run this?" prompts) can be answered by anyone who may take part in the session: you, and anyone you shared it with as **Edit**.
- **Approvals the installation's rules ask for** go to the session's owner, unless the rule names other approvers. An administrator is not an approver just by being one; a rule has to name them.

## You may approve your own actions

If you started the action, you may approve it yourself. An approval in Omnigent records that a person agreed; it is not a check that a second person looked.

Where an action needs several people's agreement, the system the agent acts on enforces it. A repository on GitHub, for example, can require a reviewer's approval before a pull request is merged, whatever any agent or approval in Omnigent says. Set those rules up in that system, where they hold for everyone.

## When an approval has changed or expired

An approval is tied to exactly the action it describes. If the action changes before it runs (different arguments, a different recipient, a changed rule), the old answer no longer counts and the agent asks again. A card that says it expired or was answered elsewhere needs nothing more from you.
