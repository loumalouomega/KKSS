# Getting Started

KKSS (Keep Kratos Simple Stupid) is a desktop application for preparing and inspecting [Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos) simulation models. It bundles two proven viewers — the [CAD-Preview](https://github.com/loumalouomega/CAD-Preview) and [VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview) VS Code extensions — into one window with a mode toggle.

## Installation

Grab the installer for your platform and architecture from the [download page](/download) (built for every release tag by CI):

| Platform | Architectures | Artifact |
| --- | --- | --- |
| Linux | x86-64, ARM 64 | `.AppImage` (portable), `.deb` or `.rpm` |
| Windows | x86-64, ARM 64 | NSIS `.exe` installer |
| macOS | Apple Silicon (ARM 64) | `.dmg` / `.zip` |

::: tip macOS Gatekeeper
Release builds are currently unsigned. On macOS, right-click the app and choose **Open** the first time to bypass Gatekeeper. A signed/notarized macOS release will remove that first-launch step when Apple credentials are enabled in release CI.
:::

## The home screen

KKSS opens on a main menu with one button per task — **Pre-Processing**, **Post-Processing**, and **Help**. Pick a mode to enter it; the **Home** button in the toolbar (or `Ctrl+0` / **View ▸ Home**) brings the menu back at any time without losing what's loaded in either mode.

Below the buttons, **Recent files** lists what you opened last — CAD models and meshes together, newest first. Clicking one reopens it in the mode it belongs to, so a `.stp` goes to Pre-Processing and an `.mdpa` to Post-Processing without you choosing. Files that have moved or been deleted drop off the list by themselves, and **Clear** forgets all of them. The same list is in **File ▸ Open Recent** (ten entries there, five here).

![The home screen](/screenshots/home-screen.png)

## The two modes

The toolbar at the top of the window holds the mode toggle:

![The shell toolbar: mode toggle, Open button, and the current file](/screenshots/shell-toolbar.png)

- **🔷 Pre-Processing** — CAD geometry and model preparation ([details](/guide/cad-mode)). Opens STEP, IGES, BREP, STL, OBJ, PLY, glTF, and OpenSCAD `.csg`/`.scad` (a `.scad` needs a local `openscad` binary). **File ▸ New Blank Model…** starts an empty one instead.
- **🔶 Post-Processing** — mesh inspection, modification, and result visualization ([details](/guide/mesh-mode)). Opens MDPA, VTK (legacy + XML), STL, OBJ, PLY, and 39 extended mesh formats via meshio++ (Gmsh, Abaqus, Nastran, UNV, Medit, Netgen, SU2, XDMF, Exodus, CGNS, MED, EnSight Gold, Triangle, …). Result fields render as combinable contour/isosurface/quiver/deformed-shape modes, and an **Advanced** toolbar menu holds the Mesh Size panel (nodal/element size statistics), sphere glyphs for particle meshes, face normals for spotting inverted elements, and boundary-skin export.

Both mode views stay alive when you switch: the loaded file, the camera, and your undo history are all preserved. The two viewers share one layout — a document chip in the menubar, an icon-headed sidebar with a collapsed **Advanced** group, a floating toolbar and dock, and a status bar — described in [Pre-Processing](/guide/cad-mode#reading-the-window-at-a-glance) and [Post-Processing](/guide/mesh-mode#reading-the-window-at-a-glance). The app's own toolbar, home screen, chat and jobs panels use the same look, and the **Terminal**, **Chat** and **Jobs** buttons show as pressed while their panel is open.

### The project folder

**File ▸ Open Folder…** sets a project folder — the one place KKSS treats as "where you are working". It is remembered across launches, shown in the toolbar (hover for the full path, click to change) and on the home screen, and it seeds:

- the **terminal**'s working directory,
- the starting folder of **every file dialog** — Open, Save As, exports, the text editor,
- the **AI assistant**'s context, so it knows where to put files it creates,
- **project-local problemtypes**: a `.kratos/problemtypes/*.js` file inside the folder shows up in the Post-Processing Problemtype list alongside the built-ins. This only happens for a folder you chose explicitly — opening a mesh that merely sits next to one never runs it.

It is a **default, not a restriction**. Nothing is refused for living outside it: you can open, save and export anywhere as always, and the MCP tools are not sandboxed to it. Until you set one, KKSS infers the folder from the document you are working on — exactly what it did before — so everything works with no setup.

**File ▸ Clear Project Root** goes back to that inferred behavior. Note the terminal reads its directory once, when its shell starts, so changing the folder applies to the *next* shell rather than the one already running.

A folder kept in sync by a desktop client — `~/Google Drive`, `~/Dropbox`, a OneDrive folder — is a
perfectly good project folder, and always has been: to KKSS it is an ordinary directory. Every
sidecar KKSS writes beside your model now lands through a temp file that is renamed into place, so
a sync daemon can never pick up a half-written one or raise a spurious "conflicted copy". The only
visible trace is a `.tmp` file that exists for a few milliseconds during each save.

### Guided simulation work

Home's **Check environment** action probes the configured Python interpreter used for manual runs
and the assistant's uv-managed tool runtime separately. It checks the selected built-in
problemtype's Kratos application imports, available CPU and memory, and whether the current run
directory exists and is writable. The check does not install packages. Known-unavailable manual
run actions are disabled while geometry browsing stays available. If the assistant runtime is
missing, Home offers its existing retry and uv setup actions; interpreter changes remain in
Settings ▸ Kratos.

With an explicit project folder, **New study** records a geometry reference and its content revision
in `.kkss/project.json`. Project-contained paths follow the folder when it moves; external paths
remain explicit references. Home shows geometry, mesh, case, run and result readiness, can open an
available geometry, mesh/case setup, and result in their existing viewers, and can duplicate study
settings. Geometry stays external by default; **Copy geometry in project** creates a project-local
copy, while **Relink geometry** explicitly repairs a missing or changed source. After exporting a
mesh, **Attach mesh** records its revision and imports the adjacent case setup when one exists.
**Plan run** previews isolated mesh, case-generation and solve tasks under `.kkss/runs/<id>/`.
**Plan sweep** expands one case-setting path and up to 50 values into fresh variant studies and run
destinations. Plans persist paused; Resume is bound to the concrete plan revision, and the queue
reconciles recorded mesh-run request identities after restart. A terminal run can be imported as an
immutable input snapshot; large results remain revision-checked links. **Review run** and **Export
review** report inputs, MDPA counts and versioned structural solve-step outcomes in offline JSON/HTML.
**Evaluate quantity** lets you select a result field, location, component, region, time step,
reduction and unit; the result record keeps the exact source artifact revision. Units must be
declared explicitly. If that result later changes, its saved value is shown as stale and omitted.
Variant comparison pairs matching definitions only when their units agree; missing values stay
missing. Residual magnitudes, mesh-quality review and unsupported-problemtype convergence remain
explicitly unavailable. The assistant has the same environment, study, queue, review, quantity and
variant tools under the normal transcript approval policy; preview never launches work.

### Working from cloud storage

If you would rather not run a sync client at all, **Settings ▸ Cloud Accounts** connects KKSS
directly to Google Drive, Dropbox or OneDrive, and **File ▸ Open from Cloud…** browses it. You
bring your own OAuth client — see [Configuration ▸ Cloud accounts](/guide/configuration#cloud-accounts)
for the one-time setup.

Opening a cloud file **downloads it into a local staging cache**, along with any of its sidecars
that exist beside it, and everything after that behaves exactly like a local document: the same
viewers, the same tools, the same assistant. Cloud tabs are marked with a ☁ in the tab strip.

Saving pushes it back. That happens on **File ▸ Save**, and also a few seconds after any automatic
save — the CAD viewer writes your parts, edits, camera and meshing options continuously, and those
ride along too. A burst of edits is coalesced into a single upload.

What to expect in the awkward cases:

- **Someone else changed the file while you had it open.** KKSS never overwrites their version and
  never discards yours. Your copy is uploaded beside theirs as `model (conflict 2026-09-06 14-03-11).stp`
  and a warning tells you so. Nothing on your disk is touched.
- **You quit with an upload still running.** KKSS holds the quit open for up to ten seconds to
  finish. If that is not enough — or the machine loses power — the local copy is still there and
  is flagged; the next launch tells you which files have changes that never reached the provider.
- **Recent files.** A cloud document stays in **File ▸ Open Recent** even after the cache trims its
  local copy; clicking it downloads again. Restoring the previous session on launch does not
  re-download, because that would mean network access before the window appears — anything trimmed
  is reported in the usual "files could not be found" notice instead.
- **The macro library is not synced.** `cad-preview-macros.json` belongs to a whole folder while
  the cache holds one document per directory, so uploading it would let two models from the same
  remote folder overwrite each other's macros. It stays local.
- **Nested export trees stay local too.** A sibling companion file (XDMF's `.h5`) is uploaded; an
  OpenFOAM case, which writes a whole `constant/polyMesh/` subdirectory, is not.

The cache is trimmed on an LRU budget (**Settings ▸ Cloud Accounts ▸ Cache Size Limit…**, 2 GB by
default). A document that is open, or that holds an unsent change, is never trimmed.

### Picking up where you left off

KKSS reopens your last session on launch: every document you had open in each mode, which one was focused, the screen you were on, and whether the terminal or chat panel was showing — and the chat sidebar comes back on the conversation you were last in. Documents that have since been deleted or moved are quietly dropped, with a note saying how many — you never land on a tab pointing at a file that isn't there.

Turn it off with **Settings ▸ Restore Last Session** to start clean every time. (Setting `KKSS_NO_RESTORE=1` in the environment does the same for one launch, which is handy if a particular document is giving the viewer trouble.) Opening a file from the command line always wins: it takes the screen and gets its own tab, leaving the restored documents untouched.

The toolbar also has an **interface-scale** picker on the right (75 %–150 %) for adjusting how large the whole app appears — useful on high-DPI or low-resolution displays. It scales every part of the window (toolbar, viewers, terminal, chat) together, is remembered across launches, and can also be driven from the keyboard: `Ctrl +` / `Ctrl -` step through the sizes and `Ctrl+Shift+0` resets to 100 % (also under **View ▸ Zoom In / Zoom Out / Reset Zoom**).

| 🔷 Pre-Processing | 🔶 Post-Processing |
| --- | --- |
| ![CAD mode](/screenshots/cad-viewer.png) | ![Mesh mode](/screenshots/mesh-viewer.png) |

## About & updates

**Help** on the home screen (or **Help ▸ About KKSS…**) shows the app version and checks GitHub for a newer release. **Include prerelease updates** in Settings controls whether stable-only or prerelease releases are selected. When an update exists, **Update now** downloads and installs it in place on Windows and on the Linux AppImage — restart when prompted. `.deb`, `.rpm` and unsigned macOS installs instead get a button to the releases page. No network? The dialog still shows your version and offers a Retry.

Installing a supported file type (`.stp`, `.mdpa`, `.vtk`, `.post.msh` and the other formats shown in the Open dialog) opens it in KKSS when the file is double-clicked. The `kkss://open?file=…` link form accepts the same local files; links to application pages, relative paths and unsupported files are rejected.

After an update, the next launch automatically pops up a **What's New** window listing what changed since the version you last ran — no popup on a first install, and it only ever shows entries newer than what you'd already seen. Dismiss it with **Got it** (or Esc); reopen the full history any time from **Help ▸ What's New…**.

## Embedded terminal

The **Terminal** toolbar button (or ``Ctrl+` `` / **View ▸ Toggle Terminal**) opens a shell panel below the viewer — handy for launching Kratos runs (`python MainKratos.py`) while watching the model. The session starts in the current file's directory, runs PowerShell on Windows and your `$SHELL` on macOS/Linux (changeable under **Settings ▸ Terminal Shell**), keeps running while hidden (hide it with the **Hide** button in the panel's corner, the toolbar button, or ``Ctrl+` ``), and offers a restart when the shell exits. The panel is shared by both modes; its height is fixed in this version.

## AI assistant

The **Chat** toolbar button (or `Ctrl+Shift+L` / **View ▸ Toggle AI Chat**) opens a chat sidebar on the right where an LLM can drive KKSS for you: load and edit CAD models, define sub-model-parts, generate and export meshes, inspect and transform MDPA/VTK files, set up Kratos cases, and run simulations. The assistant works through the same tool servers (MCP) that power the two viewers plus the standalone [kratos-mcp-server](https://pypi.org/project/kratos-mcp-server/); the three dots in the sidebar header show each server's status (green = ready, red = unavailable — hover for details). The first two ship with KKSS; the Kratos one is fetched with [`uvx`](https://docs.astral.sh/uv/) and can install an app-local copy of uv when it is missing.

The assistant can also pack a run's per-step results into an XDMF timeline with `mesh_pack_series`, matching **File ▸ Pack Time Series Into One File…**. Keep the resulting `.xdmf` and its sibling `.h5` together when copying or sharing the results.

Each message uses the tools available when you send it. If a server becomes ready while the assistant is responding, its tools become available on your next message. You can wait for its status dot to turn green before sending a task that needs it.

If Kratos cannot start, a message below the chat header explains the failure. **Install uv for KKSS** downloads the official Astral installer and installs uv into KKSS’s data directory without administrator privileges or changes to your PATH or shell profiles. It runs only when you click the button. If uv already works, KKSS uses it instead. **Retry** reconnects after a network, package, or startup failure without restarting CAD, mesh, or the app; a first download can take up to five minutes. Normal chat remains available during setup.

![Kratos runtime setup in the chat sidebar](/screenshots/chat-kratos-setup.png)

This installs the uv launcher, not a bundled Kratos engine or Python runtime. uv keeps its usual cache and Python locations. A compatible Python MCP dependency is selected alongside the pinned Kratos tool server.

Before first use, pick a provider under **Settings ▸ LLM Assistant**. API-backed providers use a key:

- **Anthropic (Claude)** — the default; set *Anthropic API Key* (and optionally the model, default `claude-opus-4-8`).
- **OpenAI-compatible** — any `chat/completions` backend: set the *Base URL* (e.g. `https://api.openai.com/v1` or `http://localhost:11434/v1` for Ollama), the model name, and a key if the backend needs one.

You can also use a subscription account through the official local agent tools:

- **ChatGPT subscription (Codex)** — install the Codex CLI, run `codex login`, then select this provider. KKSS uses Codex App Server with only KKSS's MCP tools enabled.
- **Claude subscription (Claude Code)** — install Claude Code, run `claude auth login`, then select this provider. KKSS uses the Claude Agent SDK with a private KKSS MCP bridge.

Use each provider's **Check installation and sign-in…** action to verify the executable and account. Subscription mode uses the account managed by the official tool, removes inherited API-key and gateway variables, and never falls back to paid API requests. Provider subscription limits and model availability still apply. The *Executable path…* action is available when automatic detection cannot find the installed tool.

Subscription runtimes are restricted to KKSS tools; their shell, file, web, plugin, connector, and sub-agent tools are disabled. The same KKSS approval dialog still appears before tools that change files. Conversations retain a provider session when possible; if a provider session has expired or is missing, KKSS starts a new session from the saved transcript without replaying historical tool calls.

Keys are stored encrypted with your OS keychain when available. Edits made by the assistant land in the same sidecar files the viewers use — reload the file to see them. Send with `Enter` and stop a running response with the same button.

### Approving what the assistant does

The assistant's tools are not suggestions — they write files, overwrite meshes and start solves. `mesh_transform`, for instance, overwrites the file it is given when you don't name an output path. So **a tool that changes anything is shown to you before it runs**: the call appears in the transcript with its full arguments and three buttons.

- **Allow** — run it this once.
- **Always allow in this chat** — stop asking about *that* tool for the rest of this conversation. It is per tool and per conversation; it is never remembered after you start a new chat or restart KKSS.
- **Deny** — don't run it. Nothing on disk is touched, and the assistant is told you refused, so it explains what it wanted rather than trying again.

Read-only tools — inspect, measure, mesh info, render — run without asking, so asking questions feels exactly as it did before. A tool KKSS has no policy for always asks; that is currently every tool from the Kratos server, because that server is fetched at runtime and its tools can't be classified in advance.

**Settings ▸ LLM Assistant ▸ Tool Approval** changes this: *Ask before tools that change files* (the default), *Ask before every tool*, or *Never ask*. The last one turns the gate off entirely and asks you to confirm once before it does.

Note this covers the built-in sidebar only. If you expose the toolset to an external MCP client (below), that path is protected by its bearer token alone — there is nobody at the keyboard to ask.

For a few CAD tools — applying edit operations, and running a parametric or saved script — a fourth button appears: **Validate (dry run)**. It runs the same call in a mode that writes nothing and executes nothing, and shows you the result right there in the prompt. The prompt stays open, so you read the report and *then* choose Allow or Deny.

What it checks is narrower than a preview: it tells you which operations parse and are legal, not what the geometry would look like afterwards. The report is for you only — the assistant is not told about it, and is not told a call happened when it did not.

### Tokens, context and cost

The sidebar header shows how much of the model's context window your last message filled, and roughly what the conversation has cost so far — for example `12.4k/1M · $0.03`. Hover it for the full breakdown: the model, the split between fresh and cached input, and the output total.

It turns amber as the window fills up. That is worth acting on: when a conversation no longer fits, the provider rejects it outright, and the fix is to start a new one with the header's **+** (New conversation) button (the old conversation is saved, not lost).

Cost is an estimate from published per-token prices for the Claude models KKSS knows about. Point the OpenAI-compatible provider at your own gateway — Ollama, OpenRouter, a local model — and KKSS has no way to know what it charges, so you get token counts and nothing else rather than a made-up figure. None of this leaves your machine; it is calculated from what the provider returned with your response.

### When a conversation gets long

Every message you send includes the whole conversation so far, so a long one eventually stops fitting in the model's context window. Rather than failing, KKSS starts leaving the **oldest tool results** out of what it sends — usually the bulk of a long conversation — and a line under the header tells you how many.

Your transcript is not changed: every result is still there in full, and it is still saved. Only what the assistant is re-sent shrinks, and it can always re-run a tool if it needs an older result again.

If even that is not enough, you will get the "start a new conversation" message. The old one is saved and one click away in the header's **history** button.

### Seeing what the assistant sees

Some tools return pictures — a rendered snapshot of a model, or a side-by-side comparison of two. Those appear in the tool's entry in the transcript, so when the assistant says a part looks wrong you can look at the same image it did. A result that has just arrived opens by itself; older ones in a long conversation stay folded away until you click them.

Images live for as long as the app is running. They are not written into the saved conversation, so reopening it later shows the tool call and its text, without the pictures.

### Conversations

Conversations are saved as you go and survive quitting the app — including the tool calls that record what the assistant actually did to your files, which is often the only account of it. The header's **+** button starts a fresh one and keeps the current one; nothing is discarded, so there is nothing to confirm.

The **history** button in the sidebar header lists your saved conversations, newest first, each named after its first message and showing when you last used it:

- click a row to switch to it — the full transcript comes back;
- the **pencil** renames it (`Enter` to confirm, `Esc` to cancel);
- the **trash can** deletes it, and asks once (the button turns into *Delete?*) because that is the one thing here you cannot undo.

The 50 most recently used conversations are kept; older ones are dropped, except the one you currently have open. Switching away from a conversation while the assistant is still working stops that response first and records how far it got, so the transcript you come back to reads honestly.

### Use your own MCP client

If you'd rather drive KKSS from an **external** LLM client (Claude Code, GitHub Copilot, Claude Desktop, another agent) than the built-in sidebar, enable **Settings ▸ MCP Server**. KKSS then serves the same unified cad + mesh + Kratos toolset — plus the Kratos worked-example resources and guided prompts — over a localhost **Streamable HTTP** MCP endpoint. Use **Copy Address & Token…** to grab the `http://127.0.0.1:<port>/mcp` URL and its bearer token (default port `7391`). It is off by default and bound to localhost only; the token gates access because these tools read and write files on disk — **Regenerate Token…** rotates it (update your clients afterwards). Change the port under the same menu (toggle the server off and on to rebind). Tools arrive namespaced `cad__*` / `mesh__*` / `kratos__*`; the Kratos worked examples show up as MCP resources and prompts.

Leave KKSS running with the server enabled, then point a client at it:

**Claude Code** — register it as an HTTP server (repeat `--header` for the token):

```bash
claude mcp add --transport http kkss http://127.0.0.1:7391/mcp \
  --header "Authorization: Bearer <token>"
```

Run `/mcp` inside Claude Code to confirm `kkss` is connected and list its tools. Remove it later with `claude mcp remove kkss`.

**GitHub Copilot (VS Code)** — add an HTTP server entry to `.vscode/mcp.json` in your workspace (or run *MCP: Add Server…* from the Command Palette). Using an `input` keeps the token out of the file — VS Code prompts for it once and stores it securely:

```jsonc
{
  "inputs": [
    { "id": "kkss-token", "type": "promptString", "description": "KKSS MCP token", "password": true }
  ],
  "servers": {
    "kkss": {
      "type": "http",
      "url": "http://127.0.0.1:7391/mcp",
      "headers": { "Authorization": "Bearer ${input:kkss-token}" }
    }
  }
}
```

Click **Start** on the server in `mcp.json`, then open Copilot Chat in **Agent** mode and enable the `kkss` tools from the tools (🛠) picker.

Any MCP client that speaks Streamable HTTP with a bearer header works the same way — give it the URL and the `Authorization: Bearer <token>` header.

## Kratos background jobs

Open **Jobs** in the toolbar or **View ▸ Toggle Jobs** to follow simulations started through the Kratos MCP server, including jobs launched by an external MCP client. The toolbar shows the active count. Jobs and Chat share the right-hand panel; switching between them keeps the conversation and simulations running. The Jobs panel works without an LLM API key.

Select a job to see its case directory, state, elapsed time, current step/time when available, and the last 100 log lines. Active jobs refresh every five seconds; **Refresh** also reloads the selected log. **Cancel simulation** requests cancellation from the server. A failed cancellation is shown beside the button.

![Kratos background jobs and simulation log](/screenshots/kratos-jobs.png)

If the server disconnects, the panel keeps the last known state and offers **Retry**. Missing runtime setup offers **Install uv for KKSS**, using the same setup flow as Chat. Server-owned job records are rediscovered after reconnecting or reopening Jobs after an app restart. Closing the panel, stopping chat, and quitting KKSS do not cancel these background jobs.

This panel covers `kratos__run_simulation` jobs. Runs started from the mesh Problemtype UI or `mesh__case_run` keep their existing run controls, including **File ▸ Stop Kratos Run**. Progress and recovered completion states come from the Kratos server; a percentage is not estimated when the server supplies only step/time.

## Text editor

The **Edit** toolbar button opens the file currently loaded in the active mode (`.mdpa`, `.stp`, …) as plain text — handy for touching up an input deck without leaving the app. **Text Editor** on the home screen (or **File ▸ Open in Text Editor…**) opens any file via a dialog instead. It's a lightweight editor for input files, scripts and configuration — `.json` and `.py` get syntax highlighting; binary or very large files are refused with a notice. `Ctrl+S` saves, `Ctrl+Shift+S` saves as, and the toolbar has Open/Save/Save As buttons. Unsaved changes show a dot next to the file name; switching screens never loses the buffer, and closing the window with unsaved changes prompts to save. Pair it with the terminal panel (``Ctrl+` ``) to edit and launch a Kratos case side by side.

## Settings

**Settings ▸ Open Settings…** (`Ctrl+,`) opens the Settings page. The home screen's Settings button and the chat sidebar's gear open it too. It is KKSS's equivalent of VS Code's settings editor: everything the two embedded extensions would read from VS Code's settings, and everything KKSS adds on top, on one searchable page. Each row shows its id (for example `kratos.pythonPath`), when a change takes effect, and a reset icon once it differs from the default. A value locked by a `KKSS_*` environment variable (see [Web deployment](/guide/web-deployment)) shows as *Set by the environment* and cannot be edited.

![Settings page](/screenshots/settings.png)

| Category | What it holds |
|---|---|
| **Appearance** | **UI Theme**: Follow system / Dark / Light / High contrast (dark) / High contrast (light). It applies immediately to the whole app, both viewers' panels and both 3D scenes. The mesh scene follows it while its **3D Scene Theme** is *Auto*; Dark / Light / Scientific pin the scene instead. The same row also covers UI font family and size, and the interface scale. |
| **General** | Project folder, **Restore Last Session**, whether What's New is shown after an update, and the update channel (stable, or including prereleases). |
| **CAD Viewer** | The `cadPreview.*` defaults for newly opened models: background colour, up axis, grid and axes on open, default mesh size, B-rep tessellation quality, and the OpenSCAD binary. A per-document sidecar value or a runtime toggle wins once set. |
| **Mesh Viewer** | Large-mesh summary threshold, and where the Flowgraph editor opens (below or beside the 3D view). |
| **Kratos** | The Python interpreter, the compiled Kratos install and the extra environment variables used when a problemtype case is **Run**. A folder that does not look like a Kratos install is flagged. The same row holds the problemtype folders scanned under the project folder and whether solvers are stopped when KKSS quits. The install path and environment also reach the assistant's Kratos tools; **Restart with current environment** applies a change without restarting KKSS. |
| **Text Editor** | Font size and family, tab size, word wrap, line numbers. All apply immediately. |
| **Terminal** | Shell (applies to the next session), font size and family, scrollback, cursor style and blink. |
| **LLM Assistant** | Provider, **Tool Approval**, API keys, models, the OpenAI-compatible base URL, and the Codex / Claude Code model and executable. Keys are write-only: the page shows whether one is stored, never the key itself. |
| **MCP Server** | Enable the localhost endpoint, its port, and copying or regenerating the token (see *AI assistant ▸ Use your own MCP client* above). |
| **Cloud Accounts** | Per provider: client ID, client secret, and connect / disconnect. Also the cache size limit, and clearing the cache. |

The **Settings** menu keeps quick radios for **UI Theme**, **3D Scene Theme** and **Terminal Shell**, plus the checkboxes and actions it always had. Every menu entry and its row on the page stay in sync both ways. Three VS Code-only extension settings have no row, because KKSS never reaches the code that reads them: `kratos.showWhatsNew`, `kratos.preview.autoSave` and `kratos.run.launchMode`.

Viewer actions (mesh quality, field visualization, find entity…) are *not* in the menu bar — they live in each viewer's own toolbar.

## Opening files

- **Open… button** or `Ctrl+O` — opens a file in the current mode, replacing whatever the focused tab currently shows.
- **File ▸ Open** in the CAD viewer's own File menu — same thing. (The mesh viewer's in-view File menu is hidden; use the app's **File** menu, which covers the same actions plus Save/Load Problem.)
- Formats supported by both modes (`.stl`, `.obj`, `.ply`) open in whichever mode is currently active.
- Mesh formats Pre-Processing can also import (`.mdpa`, `.vtk`, `.vtu`, `.med`, `.cgns`, `.exo`, `.xdmf`) always open in **Post-Processing**, which reads them natively. Use Pre-Processing's own Open dialog when you want the geometry-only CAD import instead.

### Tabs — several open documents at once

Each mode (Pre-Processing and Post-Processing) shows a row of tabs below the toolbar, one per open document. Click **+** at the end of the strip, or **File ▸ New CAD Tab** / **New Mesh Tab**, to open a second document alongside the first — each tab keeps its own camera position, edit history, and (in Post-Processing) its own Flowgraph session, completely independent of the others. Click a tab to switch to it; click its **×** to close it (closing needs no confirmation — nothing about tabs is unsaved in the way a text buffer can be, since both viewers autosave their sidecars). A mesh exported from a Pre-Processing tab (**File ▸ Export…** to `.mdpa`/`.vtk`/…) opens in a *new* Post-Processing tab rather than replacing whatever you're currently viewing there.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a file into the focused tab of the active mode |
| — | **File ▸ Open Folder…** sets the project folder; **Clear Project Root** reverts to inferring it |
| — | **File ▸ Open Recent** reopens one of the last ten files, in the mode it was opened in |
| — | **File ▸ New Blank Model…** creates an empty `.brep` to build from scratch (Pre-Processing) |
| `Ctrl+W` | Close the focused tab |
| `Ctrl+S` | Save (CAD: flush sidecars · Mesh: overwrite the source file) |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+E` | Export |
| `Ctrl+Alt+S` / `Ctrl+Alt+O` | Save / Load a problem archive (Post-Processing) |
| `Ctrl+Alt+R` | Reload the focused document from disk, replaying applied edits (Post-Processing) |
| `Ctrl+Alt+Z` / `Ctrl+Alt+Shift+Z` | Undo / Redo a mesh operation (Post-Processing) — not `Ctrl+Z`, which stays the text editor's |
| `Ctrl+Alt+P` | Screenshot the current view to PNG |
| `Ctrl+0` | Back to the home screen (main menu) |
| `Ctrl+1` / `Ctrl+2` | Switch to Pre-Processing / Post-Processing |
| ``Ctrl+` `` | Toggle the embedded terminal |
| `Ctrl+Shift+L` | Toggle the AI chat sidebar |

On macOS use `Cmd` instead of `Ctrl`.

Inside the mesh view, `1`–`6` snap the camera to ±X/±Y/±Z and `i` to an isometric view.

**File ▸ Export Data Table…**, **File ▸ Stop Kratos Run**, and **File ▸ Pack Time Series Into One
File…** are also in the native menu: the mesh viewer contributes the first two to its own File
strip (which KKSS hides in favour of the native menu bar), and the third is reachable upstream only
from the Command Palette and the Kratos Runs tree — neither of which KKSS runs.

A mesh tab with unsaved operations shows a dot in the tab strip; closing it, or quitting with one
open, prompts Save / Don't Save / Cancel.
