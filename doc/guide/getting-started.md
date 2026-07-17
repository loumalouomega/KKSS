# Getting Started

KKSS (Keep Kratos Simple Stupid) is a desktop application for preparing and inspecting [Kratos Multiphysics](https://github.com/KratosMultiphysics/Kratos) simulation models. It bundles two proven viewers — the [CAD-Preview](https://github.com/loumalouomega/CAD-Preview) and [VSCode-MDPA-Preview](https://github.com/loumalouomega/VSCode-MDPA-Preview) VS Code extensions — into one window with a mode toggle.

## Installation

Grab the installer for your platform and architecture from the [download page](/download) (built for every release tag by CI):

| Platform | Architectures | Artifact |
| --- | --- | --- |
| Linux | x86-64, ARM 64 | `.AppImage` (portable) or `.deb` |
| Windows | x86-64, ARM 64 | NSIS `.exe` installer |
| macOS | Apple Silicon (ARM 64) | `.dmg` / `.zip` |

::: tip macOS Gatekeeper
Release builds are currently unsigned. On macOS, right-click the app and choose **Open** the first time to bypass Gatekeeper.
:::

## The home screen

KKSS opens on a main menu with one button per task — **Pre-Processing**, **Post-Processing**, and **Help**. Pick a mode to enter it; the **Home** button in the toolbar (or `Ctrl+0` / **View ▸ Home**) brings the menu back at any time without losing what's loaded in either mode.

![The home screen](/screenshots/home-screen.png)

## The two modes

The toolbar at the top of the window holds the mode toggle:

![The shell toolbar: mode toggle, Open button, and the current file](/screenshots/shell-toolbar.png)

- **🔷 Pre-Processing** — CAD geometry and model preparation ([details](/guide/cad-mode)). Opens STEP, IGES, BREP, STL, OBJ, PLY, and glTF.
- **🔶 Post-Processing** — mesh inspection, modification, and result visualization ([details](/guide/mesh-mode)). Opens MDPA, VTK (legacy + XML), STL, OBJ, PLY, and 29 extended mesh formats via meshio++ (Gmsh, Abaqus, Nastran, UNV, Medit, Netgen, SU2, XDMF, …). Result fields render as combinable contour/isosurface/quiver/deformed-shape modes, and a Mesh Size panel reports nodal/element size statistics.

Both mode views stay alive when you switch: the loaded file, the camera, and your undo history are all preserved.

The toolbar also has an **interface-scale** picker on the right (75 %–150 %) for adjusting how large the whole app appears — useful on high-DPI or low-resolution displays. It scales every part of the window (toolbar, viewers, terminal, chat) together, is remembered across launches, and can also be driven from the keyboard: `Ctrl +` / `Ctrl -` step through the sizes and `Ctrl+Shift+0` resets to 100 % (also under **View ▸ Zoom In / Zoom Out / Reset Zoom**).

| 🔷 Pre-Processing | 🔶 Post-Processing |
| --- | --- |
| ![CAD mode](/screenshots/cad-viewer.png) | ![Mesh mode](/screenshots/mesh-viewer.png) |

## About & updates

**Help** on the home screen (or **Help ▸ About KKSS…**) shows the app version and checks GitHub for a newer release. When an update exists, **Update now** downloads and installs it in place on Windows and on the Linux AppImage — restart when prompted. `.deb` and macOS installs instead get a button to the releases page (those package types can't self-update; macOS builds are unsigned). No network? The dialog still shows your version and offers a Retry.

## Embedded terminal

The **Terminal** toolbar button (or ``Ctrl+` `` / **View ▸ Toggle Terminal**) opens a shell panel below the viewer — handy for launching Kratos runs (`python MainKratos.py`) while watching the model. The session starts in the current file's directory, runs PowerShell on Windows and your `$SHELL` on macOS/Linux (changeable under **Settings ▸ Terminal Shell**), keeps running while hidden (hide it with the **✕ Hide** button in the panel's corner, the toolbar button, or ``Ctrl+` ``), and offers a restart when the shell exits. The panel is shared by both modes; its height is fixed in this version.

## AI assistant

The **Chat** toolbar button (or `Ctrl+Shift+L` / **View ▸ Toggle AI Chat**) opens a chat sidebar on the right where an LLM can drive KKSS for you: load and edit CAD models, define sub-model-parts, generate and export meshes, inspect and transform MDPA/VTK files, set up Kratos cases, and run simulations. The assistant works through the same tool servers (MCP) that power the two viewers plus the standalone [kratos-mcp-server](https://pypi.org/project/kratos-mcp-server/); the three dots in the sidebar header show each server's status (green = ready, red = unavailable — hover for details). The first two ship with KKSS; the Kratos one is fetched with [`uvx`](https://docs.astral.sh/uv/) and is simply marked unavailable if `uv` isn't installed.

Before first use, pick a provider and set an API key under **Settings ▸ LLM Assistant**:

- **Anthropic (Claude)** — the default; set *Anthropic API Key* (and optionally the model, default `claude-opus-4-8`).
- **OpenAI-compatible** — any `chat/completions` backend: set the *Base URL* (e.g. `https://api.openai.com/v1` or `http://localhost:11434/v1` for Ollama), the model name, and a key if the backend needs one.

Keys are stored encrypted with your OS keychain when available. Edits made by the assistant land in the same sidecar files the viewers use — reload the file to see them. Send with `Enter`, stop a running response with the same button, and start over with **⟳ New**.

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

## Text editor

The **Edit** toolbar button opens the file currently loaded in the active mode (`.mdpa`, `.stp`, …) as plain text — handy for touching up an input deck without leaving the app. **Text Editor** on the home screen (or **File ▸ Open in Text Editor…**) opens any file via a dialog instead. It's a lightweight editor for input files, scripts and configuration — `.json` and `.py` get syntax highlighting; binary or very large files are refused with a notice. `Ctrl+S` saves, `Ctrl+Shift+S` saves as, and the toolbar has Open/Save/Save As buttons. Unsaved changes show a ● next to the file name; switching screens never loses the buffer, and closing the window with unsaved changes prompts to save. Pair it with the terminal panel (``Ctrl+` ``) to edit and launch a Kratos case side by side.

## Settings

The **Settings** menu (also reachable from the home screen's Settings button) holds app-level preferences, persisted across runs:

- **Color Theme** — Auto / Dark / Light / Scientific. The same scene theme the mesh viewer's own toolbar toggle controls; viewers apply it when they next load a file.
- **Terminal Shell** — the shell the embedded terminal launches (takes effect for the next terminal session).
- **LLM Assistant** — provider (Anthropic / OpenAI-compatible), API keys, model names, and the OpenAI-compatible base URL for the AI chat sidebar. Keys are encrypted with the OS keychain (Electron `safeStorage`) when one is available; changes apply to the next message, no restart needed.
- **MCP Server** — enable the localhost HTTP endpoint that exposes KKSS's toolset to an external MCP client, set its port, and copy or regenerate the bearer token (see *AI assistant ▸ Use your own MCP client* above). Off by default.

Viewer actions (mesh quality, field visualization, find entity…) are *not* in the menu bar — they live in each viewer's own toolbar.

## Opening files

- **Open… button** or `Ctrl+O` — opens a file in the current mode.
- **File ▸ Open** in the in-viewer File menu — same thing.
- Formats supported by both modes (`.stl`, `.obj`, `.ply`) open in whichever mode is currently active.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a file in the active mode |
| `Ctrl+S` | Save (CAD: flush sidecars · Mesh: overwrite the source file) |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+E` | Export |
| `Ctrl+0` | Back to the home screen (main menu) |
| `Ctrl+1` / `Ctrl+2` | Switch to Pre-Processing / Post-Processing |
| ``Ctrl+` `` | Toggle the embedded terminal |
| `Ctrl+Shift+L` | Toggle the AI chat sidebar |

On macOS use `Cmd` instead of `Ctrl`.
