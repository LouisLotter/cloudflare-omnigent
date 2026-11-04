# Connections

Agents can use tools from other services (a search engine, a code host, a model provider) through what Omnigent calls MCP services. The installation's administrators choose which services are offered. Each person then connects their own login to each service they want to use. Omnigent's server keeps that login and calls the service for your agents, so the login never reaches a computer and no agent ever sees it.

## What you see in Settings → MCP

Open **Settings → MCP**. Under **Managed MCP services** you see every service the installation offers, the same list for every member. Each one says whether it is connected for you:

- **Not connected**: offered, but you haven't connected your login yet. Until you do, agents in your sessions cannot use it.
- **Connected**: your login is saved.
- **Reconnect needed**: the service stopped accepting your login (it expired, or you removed Omnigent's access on its site).

Connecting is yours alone: a colleague who connected the same service did so with their own login, which is never used for your sessions. Likewise, the installation's owner connecting a service does not connect it for anyone else.

If the list says "No managed services are available for your account", no service is offered yet. A service an administrator has only just added appears for everyone once they have finished setting it up (chosen which of its tools agents may use); until then only they see it.

## Connecting a service

How you connect depends on the service. The card tells you which:

- **Connect, then sign in at the service** (a sign-in page): choose **Connect**, sign in on the service's own page and allow access. You come back to Settings → MCP, connected.
- **Connect, then paste a token** (an API key): create a key on the service's own site, choose **Connect**, paste it and choose **Save token**. For a service that bills by use, such as OpenRouter, every call your agents make is billed to that key: give it a spending limit on the service's site.
- **GitHub** says it uses your GitHub connection. Choose **Manage account in Sandbox Integrations**, then **Connect GitHub**, and approve with your own GitHub account. Agents then act as you on the repositories the installation's GitHub App can reach and that you can reach yourself. The same link lets git and the GitHub command line on your cloud computers act as you.

**Test connection** checks that your login works and lists the tools you get.

## Using a service in a session

In a new session, turn the service on in the **MCPs** picker above the message box. Omnigent remembers your choice for the next session. In a session someone shared with you, the agent runs as the session's owner and uses their connections, not yours ([Sessions and sharing](threads-and-sharing.md)).

## Disconnecting

**Disconnect** in Settings → MCP deletes your login from Omnigent at once, so no agent can use it any more. It does not tell the service: the service still lists Omnigent as allowed until you remove that on the service's own site, and a token you pasted keeps working anywhere else until you delete it there. To be sure, do both. For GitHub, disconnect under **Sandbox Integrations**, and remove the app's access in your GitHub settings; a token a computer already received stays valid at GitHub for up to 8 hours.

## Adding a service (administrators)

Administrators add a service on the same page, with **Add MCP server**. The [install guide](../install.md#add-an-mcp-server) describes the form. Adding a service makes it available; each member still connects their own login. Services connected with one shared company login, which everyone would use, are not available yet: every connection belongs to one person.
