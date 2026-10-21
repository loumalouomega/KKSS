# Assistant extensions

The AI assistant ([Getting Started ▸ AI assistant](/guide/getting-started#ai-assistant)) works through four built-in tool servers. The **MCP manager** lets you add your own, and lets a project folder carry its own, without widening what the assistant may do on its own: every tool of a server you add **asks for approval** until you decide otherwise.

![The MCP manager: a server of your own, a project server waiting for trust, and the project folder's trust prompt](/screenshots/chat-mcp-manager.png)

Open it with the server button in the chat header (next to the history button), or **Settings ▸ LLM Assistant ▸ MCP Servers ▸ Open manager…**. The coloured dots in the header are the same servers: green = ready, red = unavailable, yellow = a project server waiting for your trust, grey = starting or disabled.

## What the manager shows

Every server is a row: its status, tool count, the last error, and what it runs. **Built-in** servers (CAD, mesh, Kratos, PDF) are managed by KKSS: you can restart them and look at their tools, nothing else. Servers you add are marked **yours**; servers from a project folder are marked **project**.

| Control | What it does |
| --- | --- |
| **Restart** | Reconnects the server now. A server that is disabled or waiting for trust stays that way. |
| **Disable / Enable** | Stops or starts one of *your* servers without forgetting it. |
| **Edit / Remove** | Changes or forgets one of your servers (removing asks for a second click, and deletes its stored secrets). |
| **Tools** | Lists the server's tools and lets you mark each one (below). |

## Adding a server

**Add server** opens a form with two kinds of server:

- **Local command** — a program KKSS starts and talks to over its standard input and output. Give the command and its arguments (spaces separate them, quotes group). The command is run directly, **not through a shell**, so there is no expansion or redirection. It receives only the basic environment (`PATH`, `HOME` and the like) plus the variables you list.
- **HTTP URL** — a server that is already running, reached over MCP's streamable HTTP transport. A **bearer token** is optional and is only ever sent over `https`, or to this computer (`localhost`, `127.0.0.1`, `::1`); KKSS refuses to send one over plain `http` to anyone else, and never follows a redirect with it.

The **Id** is lowercase letters, digits and hyphens (up to 32, starting with a letter). It becomes the prefix of every tool the server offers — a server `acme` offering `lookup` is `acme__lookup` — which is also why `cad`, `mesh`, `kratos`, `pdf`, `app` and `mcp` are reserved: they name the built-in tool families, and a look-alike must never inherit their approval rules.

Environment variable values and bearer tokens are stored encrypted with the OS keychain, like the LLM API key, and are **never shown again** — the form only shows which names are stored. Leave a value blank when editing to keep it.

## Telling KKSS which tools are safe

A tool you have not marked **asks every time**, exactly like a tool KKSS has no rule for. Open **Tools** and choose, per tool:

- **Ask each time** (the default),
- **Read-only — runs without asking**, or
- **Changes things — asks**.

The mark is *your* decision. KKSS never infers it from a tool's name or from what the server says about itself (a server can claim anything). A mark applies to the **exact command or URL** it was made for: if you edit what the server launches, its marks are cleared, so a swapped program does not inherit "read-only". Only tools marked read-only run unprompted; the **Always allow in this conversation** button on a prompt still works as it does for any tool.

Tools of servers you add are never reachable through the [external MCP endpoint](/guide/getting-started#use-your-own-mcp-client) unless **Settings ▸ MCP Server ▸ Allowed Tools** allows them — a client on the other end has nobody to ask, so your marks do not widen it. Their **resources and prompts** are not offered to the assistant at all in this version.

## Project folders

If you have set a project folder (**File ▸ Open Folder…**), KKSS looks for `.kkss/assistant/mcp.json` inside it:

```json
{
  "servers": [
    { "id": "lab", "command": "node", "args": ["tools/lab-server.js"], "env": ["LAB_API_URL"] },
    { "id": "lab-web", "url": "https://lab.example/mcp", "tokenEnv": "LAB_TOKEN" }
  ]
}
```

The same fields as the form apply. A project file cannot hold a secret or a tool mark: `env` and `tokenEnv` only **name** variables KKSS passes through from its own environment, and marks are yours alone.

Because such a file makes KKSS run a command on your computer, it is **not loaded until you trust the folder**. The manager's *Project folder* section shows the state and the exact definitions hash:

- **Not trusted yet** — read the file, then **Trust this folder**. Nothing has been started.
- **Trusted** — the servers run. **Revoke trust** stops them.
- **Changed** — the file differs from what you trusted (a `git pull`, an edit). The servers stop and wait until you read it and trust it again.

Trust is tied to the folder you chose explicitly and to a hash of the file, and it is checked again every time a server is started or restarted — not only when the folder is opened. A folder that merely happens to contain the file (an inferred location, a document you opened) is never trusted. Only you can grant trust; the assistant has no tool for it.

If a project server and one of yours share an id, yours wins.

## What stays the same

Every tool call — from the sidebar, the Codex and Claude Code runtimes, or anywhere else — passes the same approval gate. User servers are never handed to the subscription runtimes' own tool systems, which stay switched off.
