# Configuration

KKSS deliberately keeps configuration minimal ("Keep Kratos Simple Stupid"). Every preference lives on the **Settings page** (**Settings ▸ Open Settings…**, `Ctrl+,`). It is searchable and grouped by category. The settings the two embedded VS Code extensions read (`cadPreview.*`, `kratos.*`) appear there under their VS Code ids. See [Getting Started ▸ Settings](/guide/getting-started#settings) for the full list.

## UI theme

**Appearance ▸ UI Theme** chooses the colour theme of the whole application. The options are Follow system (the default), Dark, Light, High contrast (dark) and High contrast (light). The change is immediate, and it covers:
- the shell, home screen, editor, terminal, chat and dialogs;
- both viewers' panels;
- the CAD scene;
- the mesh scene, while its **3D Scene Theme** is *Auto*.

The four kinds are VS Code's own, so both viewers restyle exactly as they would inside VS Code.

![The home screen in the Light theme](/screenshots/home-screen-light.png)

**Appearance ▸ 3D Scene Theme** (Auto / Dark / Light / Scientific) pins the mesh viewer's scene background and palette independently of the UI. It applies to meshes opened afterwards.

## Mesh 3D renderer

**Mesh Viewer ▸ 3D Renderer** — or the **View ▸ 3D Renderer** quick radio, which reads the same setting — chooses what draws the Post-Processing scene:

| Value | Meaning |
| --- | --- |
| `vtkjs` (default) | The established vtk.js renderer, with the panels, field modes, split view and picking you normally see. |
| `VTK-wasm` | **Experimental.** VTK's own C++ rendering engine compiled to WebAssembly, through the same panels and features. |

VTK-wasm is opt-in and not a replacement: vtk.js stays the default, and switching does nothing to a scene already open — the choice is read when a preview page loads, so it applies to the previews you open afterwards, and KKSS says so when you change it.

It needs a host with **WebAssembly JSPI** (`WebAssembly.Suspending`) and WebGL2, and a build that ships the runtime. When any of those is missing, the runtime fails to load, or the install simply does not include it, the preview opens on vtk.js anyway and says so on the status line — nothing about the rest of the viewer changes. In a build without the runtime, the menu marks VTK-wasm *unavailable in this build* and refuses it, so the fallback is explained before you pick it rather than only afterwards. Only VTK-wasm widens the page's Content Security Policy, and only by `'wasm-unsafe-eval'`, which permits WebAssembly to compile and nothing else; the runtime's JavaScript glue is rewritten at build time so it evaluates no dynamic code.

## Mesh exports and material libraries

**Mesh Viewer ▸ Mesh Export Provenance** controls what accompanies mesh exports:

| Value | Behavior |
| --- | --- |
| `Automatic` (default) | Embed provenance in supported native comments/headers and meshio++ slots. Problem archives keep a separate record inside the ZIP without rewriting pristine mesh bytes. |
| `Write a full sidecar report` | Also write a complete `.kratosexport.json` report beside the output; packing/resampling share one collection sidecar instead of one per step. |
| `Do not record provenance` | Add no new provenance or sidecar. Copying source bytes preserves any record already in those bytes; fidelity reports remain available. |

**Show report** opens the graphical inspector (also **Advanced ▸ Export report…**) with retained, transformed, omitted and unverified categories, companions, provenance, warnings and copyable JSON. Packed-series reports open in a separate script-free window. Native MDPA, OBJ, PLY and VTK XML can embed comments; legacy VTK uses a limited title. STL and temporal XDMF need sidecars for their complete record. MCP write tools with `verify: true` additionally re-read claims and report contradictions; this returned verification evidence is added after the write-time sidecar has been published. Unknown/unmeasured topology, structured VTI and temporal XDMF are not silently treated as verified.

**Kratos ▸ Material Library Folders** lists project-relative folders to scan for user material presets (default `.kratos/materials`). Importing a preset into a case writes a snapshot, so generated cases do not depend on the library remaining unchanged.

## Kratos environment

**Kratos** holds what a problemtype **Run** uses:

| Setting | Meaning | Default |
| --- | --- | --- |
| `kratos.pythonPath` | Python interpreter for queued and direct case runs | `python3` (`python` on Windows) |
| `kratos.mpiRanks` | Ranks for guided queue solves; `0` keeps OpenMP threads. A positive value launches the solve under MPI on one node (here or on the ssh host); needs an MPI launcher and an MPI-enabled Kratos, otherwise the preview refuses. Solver Threads then means threads per rank | `0` (off) |
| `kratos.threads` | Verified OpenMP threads per Kratos solve; `0` selects Auto (`available CPUs − 1`, minimum 1) | `0` (Auto) |
| `kratos.installPath` | Compiled Kratos install, or a source checkout built in-tree. Prepended to `PYTHONPATH` and the shared-library path | pip-installed Kratos |
| `kratos.extraEnv` | Extra variables; they override computed ones | — |
| `kratos.problemtypes.extraPaths` | Folders under the project folder scanned for user problemtypes | `.kratos/problemtypes` |
| `kratos.run.stopOnWindowClose` | Kill running solvers when KKSS quits | on |
| `kratos.run.isolate` | Give every Mesh Problemtype run its own workspace (`<case folder>/<runs folder>/<stem>-<run id>/`): the mesh and case state are copied there, the case files are generated there and the solver writes `vtk_output/` there | off |
| `kratos.run.runsFolder` | Folder under the case folder for isolated run workspaces; only a relative path is used | `runs` |

Queue previews freeze their effective thread allocation; changing the setting requires a new preview. The environment probe only offers this control when both Kratos thread set and read APIs are available. Auto uses the available CPU count minus one, with a minimum of one. CAD meshing and MDPA case preparation have verified one-thread reservations; other case-preparation costs are unknown and run exclusively. The app permits one solve and one preparation task to overlap only when their recorded allocations fit the CPU budget; uncertain or legacy allocations block overlap. The install path and extra environment also reach the assistant's Kratos MCP server the next time it starts. **Restart with current environment** applies them immediately. The interpreter does not: that server runs in `uvx`'s own isolated environment.

## Interface scale

The **scale picker** on the right of the shell toolbar (75 %–150 %) sets how large the whole application is drawn — the toolbar, both viewers, the terminal, and the chat sidebar all scale together, so the layout stays proportional on high-DPI or low-resolution displays. The choice persists across launches. It's also on the keyboard: `Ctrl +` / `Ctrl -` step through the presets and `Ctrl+Shift+0` resets to 100 % (mirrored under **View ▸ Zoom In / Zoom Out / Reset Zoom**).

## General

| Setting | Meaning | Default |
| --- | --- | --- |
| Language | Language of the KKSS interface (`English` or `Español`). Applies on the next launch. The mesh viewer follows this language (its chrome and monitor prompts); CAD-Preview stays English. | English |
| Project Folder | **Choose…** / **Clear** — the default folder for the terminal, file dialogs and the assistant (also **File ▸ Open Folder…**). It is a default, never a restriction. | — |
| Restore Last Session | Reopen the previous run's documents, screen and panels at launch. `KKSS_NO_RESTORE=1` overrides it for one launch. | On |
| Show What's New After Updates | Show the release notes the first time a new version starts. **Help ▸ What's New…** always works. | On |
| Update Channel | `Stable releases` or `Include prereleases` — which releases **Help ▸ About KKSS** offers to install. | Stable |

**Appearance** also holds **UI Font Family** (a CSS font-family for the application chrome; empty uses the system UI font) and **UI Font Size** (base size in pixels for the chrome and both viewers' panels, default 13).

## CAD Viewer defaults

These seed newly opened models; per-model choices saved beside the model (see [Pre-Processing mode](/guide/cad-mode#sidecar-files)) always win.

| Setting | Meaning | Default |
| --- | --- | --- |
| Background | Default 3D view background. The viewer's Appearance swatch still overrides it per session. | `#1e1e1e` |
| Up Axis | `Y up` or `Z up` for newly opened models. | Y up |
| Show Grid & Axes on Open | Show the ground grid and the axes helper when a model opens. | On |
| Default Mesh Size | `Coarse` / `Medium` / `Fine` element-size preset for models with no saved `.mesh.json`. | Medium |
| Tessellation Quality | `Draft (fastest)` / `Standard` / `Fine (most detail)` for STEP/IGES/BREP display. Re-read on every edit or reopen; it does not affect FE meshing. | Standard |
| OpenSCAD Binary | Fallback `openscad` executable, used only when the bundled OpenSCAD declines a model (`import()`/`surface()`, a missing include, over the staging caps). | `openscad` |
| OpenSCAD Backend | `Auto (no flag)`, `CGAL` or `Manifold (2025+)` for the fallback binary. | Auto |
| OpenSCAD Library Folders | Extra library folders prepended to `OPENSCADPATH` for `.scad` conversion only. Absolute paths. | none |
| Kernel Job Timeout (minutes) | The longest a single CAD kernel job (a tessellation, a boolean, a meshing run) may take before its worker is restarted. Applies to models opened afterwards; raise it for very large assemblies. | 5 |

## Mesh Viewer

| Setting | Meaning | Default |
| --- | --- | --- |
| Large-Mesh Summary Threshold (MB) | Meshes above this size open as a header summary with an **Open full mesh anyway** button; `0` always opens in full. | 250 |
| Timeline Frame Cache (MB) | Memory budget for keeping recently viewed time-series frames parsed, so stepping back and forth does not reread files. Takes effect live. | 256 |
| 3D Renderer | `vtk.js` or the experimental `VTK-wasm` — see [Mesh 3D renderer](#mesh-3d-renderer). | vtk.js |
| Plot Extraction Cache | Keep a bounded on-disk cache of disk-backed plot extractions under the app's mesh storage, so reopening a plot after a restart does not re-extract. Off keeps extractions in memory only. | Off |
| Mesh Export Provenance | `Automatic`, `Write a full sidecar report` (a `.kratosexport.json` per export series) or `Do not record provenance` — see [Mesh exports](#mesh-exports-and-material-libraries). | Automatic |
| Flowgraph Split | Where the Flowgraph problemtype's node editor opens: `Below the 3D view` or `Beside the 3D view`. | Below |

## Text editor and terminal

| Setting | Meaning | Default |
| --- | --- | --- |
| Text Editor ▸ Font Size / Font Family | Size in pixels and CSS font-family of the built-in text editor; an empty family uses the default monospace stack. | 13 / — |
| Text Editor ▸ Tab Size | Width of a tab and of one indentation level. | 4 |
| Text Editor ▸ Word Wrap / Line Numbers | Wrap long lines at the editor width; show the line-number gutter. | Off / On |
| Terminal ▸ Shell | `System default ($SHELL)`, `bash` or `zsh`. A change applies to the next shell you open, not the running one. | System default |
| Terminal ▸ Font Size / Font Family | Size in pixels and CSS font-family of the embedded terminal. | 13 / — |
| Terminal ▸ Scrollback Lines | Lines kept above the visible area. | 5000 |
| Terminal ▸ Cursor Style / Cursor Blink | `Block`, `Underline` or `Bar`; blink on or off. | Block / On |

All of these apply to open editors and terminals immediately, except the shell.

## LLM assistant

**Settings ▸ LLM Assistant** configures the AI chat sidebar ([Getting Started ▸ AI assistant](/guide/getting-started#ai-assistant)):

| Setting | Meaning | Default |
| --- | --- | --- |
| Provider | `Anthropic (Claude)`, `OpenAI-compatible`, `OpenCode Zen`, `OpenCode Go`, `ChatGPT subscription (Codex)`, or `Claude subscription (Claude Code)` | Anthropic |
| Anthropic API Key | stored encrypted (OS keychain via `safeStorage`) | — |
| Anthropic Model | any Claude model id | `claude-opus-4-8` |
| OpenAI-compatible API Key | optional (keyless backends like Ollama work) | — |
| OpenAI-compatible Base URL | any `chat/completions` endpoint | `https://api.openai.com/v1` |
| OpenAI-compatible Model | model name your backend expects | `gpt-4o` |
| OpenCode API Key | one key for both Zen and Go (from `https://opencode.ai/auth`) | — |
| OpenCode Zen Model | any Zen `chat/completions` model id | `glm-5.3-flash` |
| OpenCode Go Model | any Go `chat/completions` model id | `glm-5.3-flash` |
| Thinking | `Auto` / `Off` / `Low effort` / `High effort` — also the brain picker in the chat sidebar; not used by the subscription providers | Auto |
| Max Output Tokens | upper bound on one reply (256–128000); empty keeps the built-in 16000 (Anthropic) or the gateway default | — |
| Allow Image Attachments (OpenAI-compatible) | lets the chat composer attach images for the OpenAI-compatible, OpenCode Zen and OpenCode Go providers — off because KKSS cannot know whether a gateway's model has vision; Anthropic always accepts images and PDFs, the subscription providers neither (see [Attaching images and PDFs](getting-started.md#attaching-images-and-pdfs)) | Off |
| Tool Approval | `Ask before tools that change files` / `Ask before every tool` / `Never ask` | Ask before tools that change files |
| Lifecycle Hooks | Run the commands in your `hooks.json` (and a trusted project folder's) before and after the assistant's tool calls and messages. A hook can refuse a call or make it ask first; it can never approve one. Off runs none. Stored as `llmHooks`. See [Lifecycle hooks](/guide/assistant-extensions#lifecycle-hooks). | On |
| Kraty | Show a small animated face in the chat sidebar that reacts to what the assistant is doing. It only reflects the sidebar's own state and never speaks unprompted. Off by default. |
| Standing Instructions & Skills | Send your `instructions.md` and a catalog of your skills with each message, and expand `/name` prompt templates. Off sends and expands nothing. Stored as `llmAssistantDefs`. | On |
| Instructions, Skills & Prompts Folder | **Open folder…** creates and opens `<userData>/assistant/` (`instructions.md`, `skills/<name>/SKILL.md`, `prompts/<name>.md`, and `hooks.json` for [lifecycle hooks](/guide/assistant-extensions#lifecycle-hooks)). A trusted project folder's `.kkss/assistant/` adds its own (see [Assistant extensions](/guide/assistant-extensions)). | — |
| MCP Servers | **Open manager…** opens the chat sidebar's MCP manager: add your own stdio or streamable-HTTP servers, enable, disable or restart them, mark their tools read-only, and trust a project folder's `.kkss/assistant/mcp.json` (see [Assistant extensions](/guide/assistant-extensions)). The definitions live in `state.json` under `assistantMcpServers` (names only); environment values and bearer tokens are stored encrypted like the API keys; marks (`assistantMcpToolMarks`) and folder trust (`assistantFolderTrust`) are stored beside them. A managed deployment that locks any of those keys makes the manager read-only. | — |
| Custom Context Window (tokens) | The context window of the current model, used **only** when KKSS has no reviewed figure for it. Shows how full the context is and lets compaction start early. | — |
| Custom Input / Output Price (USD per 1M tokens) | Prices for a model KKSS has no reviewed figures for. A cost estimate needs **both**; with only one, the sidebar shows token counts alone. Stays on this computer. | — |
| Custom Cache Read / Write Price (USD per 1M tokens) | Prices of cached input and of tokens written to the cache. Empty assumes the input price (no discount). | Input price |

The provider menu also includes **ChatGPT subscription (Codex)** and **Claude subscription (Claude Code)**. These options require the matching official local tool and an eligible signed-in subscription account. Their submenu offers a runtime check, official setup link, model override, and optional executable path. KKSS does not import or store subscription credentials.

**OpenCode Zen** is a pay-as-you-go gateway over curated, benchmarked models; **OpenCode Go** is a $10/$40 subscription over open coding models. One API key from `https://opencode.ai/auth` unlocks both, and KKSS sends its own `User-Agent` plus a stable per-conversation session id so Go can route and cache. The first cut speaks `chat/completions` only, so it offers those models (check `/models` in the OpenCode TUI — the list changes); per-model `/responses` and `/messages` endpoints (Muse Spark, GPT, Claude, Qwen Max) need their own adapters. Prices for the matching `chat/completions` ids are reviewed in `modelInfo.ts`; anything else shows tokens only unless you enter your own prices and context window (**LLM Assistant ▸ Custom … Price / Custom Context Window**; see [Tokens, context and cost](getting-started.md#tokens-context-and-cost)).

**Tool Approval** decides when the assistant has to ask you before running one of its tools. Read versus write is a KKSS-side classification keyed by the tool's full name, not something the tool servers declare about themselves — a server's own claim about whether it is safe is exactly the thing that should not be trusted. A tool KKSS has no entry for always asks. The Kratos server's 110 tools are classified against the pinned 0.9.0 release (status, listing and validation tools run without asking; scaffolding, solver and job control, and anything that writes a file ask), while a tool a different server version adds stays unclassified and asks. The setting applies to the very next tool call. *Never ask* turns the gate off and confirms once before doing so; it covers the built-in sidebar only, since the HTTP MCP endpoint has no user to prompt.

The model and thinking level can also be changed from the strip above the chat message box ([Choosing the model and thinking level](/guide/getting-started#choosing-the-model-and-thinking-level)); it writes these same settings. Changes apply to the next chat message — no restart. API keys are encrypted with the OS keychain when one is available; on systems without a keyring they fall back to plaintext in `state.json` (below). Entering an empty value clears a stored key.

## External MCP endpoint

**Settings ▸ MCP Server** exposes the same CAD, mesh, Kratos and app tools the sidebar uses over a localhost HTTP MCP endpoint, for an external client such as Claude Desktop or an IDE ([Getting Started ▸ Use your own MCP client](/guide/getting-started#use-your-own-mcp-client)). Off by default.

| Setting | Meaning | Default |
| --- | --- | --- |
| Enable External Access | Start or stop the endpoint (`http://127.0.0.1:<port>/mcp`). Bearer-token protected, and it checks the `Host` header. | Off |
| Port | The localhost port. Applies the next time the endpoint is enabled. | 7391 |
| Allowed Tools | `Read-only tools`, `Read-only tools and the listed write tools`, or `All tools`. A client has nobody to ask, so this setting — not a prompt — decides; calls to other tools are refused with an error naming the setting. A newly enabled endpoint starts read-only. | Read-only |
| Allowed Write Tools | Full tool names (for example `cad__apply_edit_ops`) a client may call in addition to the read-only ones; used by the middle mode only. A tool KKSS has no classification for is never allowed unless listed. | none |
| Address & Token | **Copy address & token** puts the client configuration on the clipboard; **Regenerate token…** rotates the token (connected clients must be updated). The token is stored encrypted. | — |

[Lifecycle hooks](/guide/assistant-extensions#lifecycle-hooks) run on this endpoint too; a hook that would ask for confirmation refuses the call there.

## Advanced

**Flowgraph Asset Override** (`kratos.flowgraph.assetPathOverride`) is for development only: it serves a local `@kratos-flowgraph/flowgraph` checkout instead of the copy bundled with the Flowgraph problemtype. It applies the next time the Flowgraph server starts, and normally stays empty.

## Cloud accounts

**Settings ▸ Cloud Accounts** connects KKSS to Google Drive, Dropbox or OneDrive, so **File ▸ Open from Cloud…** can open a model directly — no desktop sync client required. See [Getting Started ▸ Working from cloud storage](/guide/getting-started#working-from-cloud-storage) for how a cloud document behaves once it is open.

**Settings ▸ Remote** lists the ssh hosts offered by **File ▸ Open Remote…** and **View ▸ New Remote Shell…**, and can point the assistant's Kratos tools at a host. See [Remote Sessions](/guide/remote-sessions).

**KKSS ships no OAuth credentials of its own.** You register a desktop/installed-app client in your own provider console and paste its client ID into the menu. That means nothing here routes through an application account you do not control — and it means there is a one-time setup step per provider:

| Provider | Redirect URI to register | Client secret | Scopes requested |
| --- | --- | --- | --- |
| Google Drive | `http://127.0.0.1/callback` — Google accepts a loopback redirect on **any** port | Issued for a "Desktop app" client; paste it too | `https://www.googleapis.com/auth/drive` |
| Dropbox | `http://127.0.0.1:53682/callback` — **exactly this**, Dropbox matches the whole URI including the port | None (PKCE public client) | `files.metadata.read`, `files.content.read`, `files.content.write`, `account_info.read` |
| OneDrive | `http://localhost/callback` as a **Mobile & desktop** platform redirect | None (PKCE public client) | `Files.ReadWrite`, `offline_access`, `User.Read` |

Two things worth knowing before you start:

- **Google's testing-mode refresh tokens expire after seven days.** While your OAuth consent screen is in "Testing", you will have to reconnect weekly. Publishing the consent screen (even for a single-user app) removes the limit.
- **Google Drive asks for full `drive` scope, not `drive.file`.** The narrower scope only sees files the app itself created or that were picked through *Google's own* file picker, which KKSS does not use — with it, the Open from Cloud browser would show an empty Drive.

**Cache Size Limit (MB)** (default 2048) bounds the local staging cache for cloud documents — the least recently opened documents are evicted first, and documents that are open or still hold unuploaded changes never are — and **Clear cache…** deletes every cached cloud document that is not currently open after a confirmation (anything that has not finished uploading is lost with it; files already on the provider can be opened again).

Client IDs are stored in `state.json`; client secrets and refresh tokens go through the same encrypted store as the LLM API key. **Disconnect…** forgets the sign-in and offers to delete the cached copies with it.

## Where state lives

| State | Location |
| --- | --- |
| App state (theme, interface scale, project folder, recent files, last session, one-time warnings) | `state.json` in the platform's user-data dir (`~/.config/KKSS` on Linux, `%APPDATA%/KKSS` on Windows, `~/Library/Application Support/KKSS` on macOS) |
| CAD parts / edits / mesh options | JSON sidecars next to the opened model — see [Pre-Processing mode](/guide/cad-mode#sidecar-files) |
| Mesh operation recipes | Saved explicitly via the Edit sidebar's Save/Load buttons |
| Cloud client IDs | `state.json` (public by OAuth's design) |
| Cloud client secrets and refresh tokens | `state.json`, encrypted with the OS keychain like the LLM API key |
| Cloud staging cache and its manifest | `cloud-cache/` beside `state.json` in the same user-data dir |

Note that the user-data dir is **not** inside your project folder, so syncing a project folder never syncs your settings or your credentials.

## Command-line

`kkss <file>` opens the given model on startup in the mode the file's extension implies. Several files may be given (`kkss a.step b.mdpa`); each opens in its own tab in the mode its extension implies, and duplicates are opened once. A relative path is resolved against the directory you ran the command from, including when the file is forwarded to an already-running KKSS. `kkss://open?file=<path>` links open the same way.

### Headless study runs

`kkss --headless study run <project> [options]` runs a study's **already-persisted** queue plan without a window and prints one JSON report on stdout (the plan is the one you previewed and enqueued in KKSS, so this suits CI and batch use). It resumes exactly the plan revision stored in `<project>/.kkss/project.json` — it never previews, enqueues or edits anything, and `--plan <revision>` must equal the stored revision or nothing starts. It waits until every task is terminal, then builds each solve's run review for its findings and convergence state.

| Option | Meaning |
| --- | --- |
| `--study <id>` | Wait for and report only that study's tasks (the plan resumes as a whole) |
| `--plan <revision>` | Refuse unless this is the persisted plan revision |
| `--timeout <seconds>` | Wall-clock limit (default 24 h). On expiry the queue is paused and running tasks are cancelled |
| `--settings <state.json>` | Read the Kratos interpreter, install path, extra environment, thread and rank settings from a saved `state.json` (read only) — the plan froze them, and a different runtime is refused with the queue's usual message |
| `--python <path>` | Override the interpreter |
| `--output <file>` | Also write the report here |
| `--no-review` | Skip the run reviews |
| `--require-converged` | Fail unless every run's review establishes convergence |
| `--user-data-dir <dir>` | The Electron profile; without it a throwaway one is used |

It takes no single-instance lock and writes no `state.json`, so it can run beside a live KKSS; use a project folder that session is not also running. Only the CAD and mesh tool servers start. Solves on an ssh host (**Settings ▸ Remote**) are not supported headless.

| Exit code | Meaning |
| --- | --- |
| `0` | Every task `succeeded` — this is not numerical convergence; read each run's `convergence` |
| `1` | A task failed, was cancelled, blocked or refused by validation |
| `2` | A task ended `uncertain` (never retried automatically) |
| `3` | Bad usage, or the folder holds no KKSS project |
| `4` | No persisted plan, a `--plan` mismatch, or the queue refused the plan |
| `5` | Timed out |
| `6` | Succeeded, but `--require-converged` was not met |

## Settings reference

Generated from `app/main/services/settings/registry.ts`; do not edit between the markers (`UPDATE_DOCS_REFERENCE=1 npm test -- docsReference` rewrites it, and CI fails when it drifts). Secrets are stored encrypted and never shown.

<!-- reference:settings-reference:begin -->

#### Appearance

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| UI Theme | `appearance.uiTheme` | one of `system`, `dark`, `light`, `hcDark`, `hcLight` | `system` | live | `uiTheme` |
| 3D Scene Theme | `appearance.sceneTheme` | one of `auto`, `dark`, `light`, `scientific` | `auto` | nextOpen | `sceneTheme` |
| UI Font Family | `appearance.fontFamily` | string | empty | live | `uiFontFamily` |
| UI Font Size | `appearance.fontSize` | number | `13` | live | `uiFontSize` |
| Interface Scale | `appearance.zoom` | one of `0.75`, `0.9`, `1`, `1.1`, `1.25`, `1.5` | `1` | live | `uiZoom` |

#### General

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Language | `general.language` | one of `en`, `es` | `en` | nextStart | `uiLanguage` |
| Project Folder | `general.projectRoot` | action | — | — | `projectRoot` |
| Restore Last Session | `general.restoreSession` | boolean | `true` | nextStart | `restoreSession` |
| Show What's New After Updates | `general.showWhatsNew` | boolean | `true` | nextStart | `showWhatsNew` |
| Update Channel | `general.updateChannel` | one of `stable`, `prerelease` | `stable` | live | `updateChannel` |

#### CAD Viewer

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Background | `cadPreview.background` | color | `#1e1e1e` | nextOpen | `cadBackground` |
| Up Axis | `cadPreview.upAxis` | one of `y`, `z` | `y` | nextOpen | `cadUpAxis` |
| Show Grid & Axes on Open | `cadPreview.showGridAndAxesOnOpen` | boolean | `true` | nextOpen | `cadShowGridAndAxesOnOpen` |
| Default Mesh Size | `cadPreview.defaultMeshSizePreset` | one of `coarse`, `medium`, `fine` | `medium` | nextOpen | `cadDefaultMeshSizePreset` |
| Navigation Preset | `cadPreview.navigationPreset` | one of `default`, `fusion` | `default` | nextOpen | `cadNavigationPreset` |
| Single-Key Commands | `cadPreview.singleKeyCommands` | boolean | `false` | nextOpen | `cadSingleKeyCommands` |
| Tessellation Quality | `cadPreview.tessellationQuality` | one of `draft`, `standard`, `fine` | `standard` | nextRun | `cadTessellationQuality` |
| OpenSCAD Binary | `cadPreview.openscadBinary` | path | `openscad` | nextOpen | `cadOpenscadBinary` |
| OpenSCAD Backend | `cadPreview.openscadBackend` | one of `auto`, `cgal`, `manifold` | `auto` | nextOpen | `cadOpenscadBackend` |
| OpenSCAD Library Folders | `cadPreview.openscadLibraryPaths` | stringList | empty | nextOpen | `cadOpenscadLibraryPaths` |
| Kernel Job Timeout (minutes) | `cadPreview.kernelTimeoutMinutes` | number | `5` | nextOpen | `cadKernelTimeoutMinutes` |

#### Mesh Viewer

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Large-Mesh Summary Threshold (MB) | `kratos.preview.summaryThresholdMb` | number | `250` | nextOpen | `meshSummaryThresholdMb` |
| Timeline Frame Cache (MB) | `kratos.preview.frameCacheMb` | number | `256` | live | `meshFrameCacheMb` |
| 3D Renderer | `kratos.preview.renderer` | one of `vtkjs`, `vtkwasm` | `vtkjs` | nextOpen | `kratos.preview.renderer` |
| Plot Extraction Cache | `kratos.plots.persistentCache` | boolean | `false` | live | `kratos.plots.persistentCache` |
| Mesh Export Provenance | `kratos.export.provenance` | one of `auto`, `sidecar`, `none` | `auto` | live | `kratos.export.provenance` |
| Flowgraph Split | `kratos.flowgraph.splitOrientation` | one of `horizontal`, `vertical` | `horizontal` | nextOpen | `kratos.flowgraph.splitOrientation` |

#### Kratos

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Solver Threads | `kratos.threads` | number | `0` | nextRun | `kratos.threads` |
| MPI Ranks | `kratos.mpiRanks` | number | `0` | nextRun | `kratos.mpiRanks` |
| Python Interpreter | `kratos.pythonPath` | path | empty | nextRun | `kratos.pythonPath` |
| Kratos Install | `kratos.installPath` | path | empty | nextRun | `kratos.installPath` |
| Extra Environment | `kratos.extraEnv` | stringMap | empty | nextRun | `kratos.extraEnv` |
| Problemtype Folders | `kratos.problemtypes.extraPaths` | stringList | `[".kratos/problemtypes"]` | nextOpen | `kratos.problemtypes.extraPaths` |
| Material Library Folders | `kratos.materials.extraPaths` | stringList | `[".kratos/materials"]` | nextOpen | `kratos.materials.extraPaths` |
| Batch Recipe Folders | `kratos.recipes.extraPaths` | stringList | `[".kratos/recipes"]` | nextOpen | `kratos.recipes.extraPaths` |
| Stop Runs on Quit | `kratos.run.stopOnWindowClose` | boolean | `true` | live | `kratos.run.stopOnWindowClose` |
| Isolate Runs | `kratos.run.isolate` | boolean | `false` | nextRun | `kratos.run.isolate` |
| Runs Folder | `kratos.run.runsFolder` | string | `runs` | nextRun | `kratos.run.runsFolder` |
| Simulation Environment | `kratos.environment` | action | — | — | — |
| Kratos Assistant Tools | `kratos.tools` | action | — | — | — |

#### Text Editor

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Font Size | `editor.fontSize` | number | `13` | live | `editor.fontSize` |
| Font Family | `editor.fontFamily` | string | empty | live | `editor.fontFamily` |
| Tab Size | `editor.tabSize` | number | `4` | live | `editor.tabSize` |
| Word Wrap | `editor.wordWrap` | boolean | `false` | live | `editor.wordWrap` |
| Line Numbers | `editor.lineNumbers` | boolean | `true` | live | `editor.lineNumbers` |

#### Terminal

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Shell | `terminal.shell` | one of ``, `/bin/bash`, `/bin/zsh` | empty | nextShell | `terminalShell` |
| Font Size | `terminal.fontSize` | number | `13` | live | `terminal.fontSize` |
| Font Family | `terminal.fontFamily` | string | empty | live | `terminal.fontFamily` |
| Scrollback Lines | `terminal.scrollback` | number | `5000` | live | `terminal.scrollback` |
| Cursor Style | `terminal.cursorStyle` | one of `block`, `underline`, `bar` | `block` | live | `terminal.cursorStyle` |
| Cursor Blink | `terminal.cursorBlink` | boolean | `true` | live | `terminal.cursorBlink` |

#### LLM Assistant

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Provider | `llm.provider` | one of `anthropic`, `openai`, `opencode-zen`, `opencode-go`, `codex`, `claude-code` | `anthropic` | live | `llmProvider` |
| Tool Approval | `llm.toolApproval` | one of `askOnWrite`, `askAlways`, `never` | `askOnWrite` | live | `llmToolApproval` |
| Standing Instructions & Skills | `llm.assistantDefs` | boolean | `true` | live | `llmAssistantDefs` |
| Instructions, Skills & Prompts Folder | `llm.assistantDefsFolder` | action | — | — | — |
| Lifecycle Hooks | `llm.hooks` | boolean | `true` | live | `llmHooks` |
| Kraty | `llm.kraty` | boolean | `false` | live | `llmKraty` |
| MCP Servers | `llm.mcpServers` | action | — | — | — |
| Anthropic API Key | `llm.anthropicKey` | secret | — | live | `llmKeyAnthropic` |
| Anthropic Model | `llm.anthropicModel` | string | empty | live | `llmModelAnthropic` |
| OpenAI-compatible API Key | `llm.openaiKey` | secret | — | live | `llmKeyOpenai` |
| OpenAI-compatible Base URL | `llm.openaiBaseUrl` | string | empty | live | `llmOpenaiBaseUrl` |
| OpenAI-compatible Model | `llm.openaiModel` | string | empty | live | `llmModelOpenai` |
| OpenCode API Key | `llm.opencodeKey` | secret | — | live | `llmKeyOpencode` |
| OpenCode Zen Model | `llm.zenModel` | string | empty | live | `llmModelZen` |
| OpenCode Go Model | `llm.goModel` | string | empty | live | `llmModelGo` |
| Codex Model | `llm.codexModel` | string | empty | live | `llmModelCodex` |
| Codex Executable | `llm.codexExecutable` | path | empty | live | `llmCodexExecutable` |
| Claude Code Model | `llm.claudeCodeModel` | string | empty | live | `llmModelClaudeCode` |
| Claude Code Executable | `llm.claudeCodeExecutable` | path | empty | live | `llmClaudeCodeExecutable` |
| Thinking | `llm.thinking` | one of `auto`, `off`, `low`, `high` | `auto` | live | `llmThinking` |
| Max Output Tokens | `llm.maxOutputTokens` | number | — | live | `llmMaxOutputTokens` |
| Allow Image Attachments (OpenAI-compatible) | `llm.imageInput` | boolean | `false` | live | `llmImageInput` |
| Custom Context Window (tokens) | `llm.customContextWindow` | number | — | live | `llmCustomContextWindow` |
| Custom Input Price (USD per 1M tokens) | `llm.customInputPrice` | number | — | live | `llmCustomInputPrice` |
| Custom Output Price (USD per 1M tokens) | `llm.customOutputPrice` | number | — | live | `llmCustomOutputPrice` |
| Custom Cache Read Price (USD per 1M tokens) | `llm.customCacheReadPrice` | number | — | live | `llmCustomCacheReadPrice` |
| Custom Cache Write Price (USD per 1M tokens) | `llm.customCacheWritePrice` | number | — | live | `llmCustomCacheWritePrice` |

#### MCP Server

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Enable External Access | `mcpServer.enabled` | boolean | `false` | live | `metaServerEnabled` |
| Port | `mcpServer.port` | number | `7391` | nextStart | `metaServerPort` |
| Allowed Tools | `mcpServer.access` | one of `readOnly`, `readListed`, `all` | `readOnly` | live | `metaServerAccess` |
| Allowed Write Tools | `mcpServer.allowedWrites` | stringList | empty | live | `metaServerAllowedTools` |
| Address & Token | `mcpServer.token` | action | — | — | — |

#### Cloud Accounts

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Google Drive Client ID | `cloud.gdrive.clientId` | string | empty | live | `cloud.gdrive.clientId` |
| Google Drive Client Secret | `cloud.gdrive.clientSecret` | secret | — | live | `cloud.gdrive.clientSecret` |
| Google Drive Account | `cloud.gdrive.account` | action | — | — | — |
| Dropbox Client ID | `cloud.dropbox.clientId` | string | empty | live | `cloud.dropbox.clientId` |
| Dropbox Client Secret | `cloud.dropbox.clientSecret` | secret | — | live | `cloud.dropbox.clientSecret` |
| Dropbox Account | `cloud.dropbox.account` | action | — | — | — |
| OneDrive Client ID | `cloud.onedrive.clientId` | string | empty | live | `cloud.onedrive.clientId` |
| OneDrive Client Secret | `cloud.onedrive.clientSecret` | secret | — | live | `cloud.onedrive.clientSecret` |
| OneDrive Account | `cloud.onedrive.account` | action | — | — | — |
| Cache Size Limit (MB) | `cloud.cacheLimitMb` | number | `2048` | live | `cloudCacheLimitMb` |
| Cloud Cache | `cloud.cache` | action | — | — | — |

#### Remote

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| SSH Hosts | `remote.hosts` | stringList | empty | live | `remote.hosts` |
| Run Kratos tools on | `remote.kratosHost` | string | empty | nextStart | `remote.kratosHost` |

#### Advanced

| Setting | Id | Type | Default | Applies | Store key |
| --- | --- | --- | --- | --- | --- |
| Flowgraph Asset Override | `kratos.flowgraph.assetPathOverride` | path | empty | nextStart | `kratos.flowgraph.assetPathOverride` |

<!-- reference:settings-reference:end -->

## Assistant tool reference

Generated from `app/main/services/chat/toolPolicy.ts` and `toolPaths.ts`. *Read* tools run without a prompt; *write* (and unlisted) tools are approved in the transcript. A project-folder grant is offered only for tools with listed path arguments.

<!-- reference:tool-reference:begin -->

| Server | Tools | Read | Write | Path-scoped |
| --- | --- | --- | --- | --- |
| `app` | 42 | 17 | 25 | 0 |
| `cad` | 95 | 48 | 47 | 43 |
| `kratos` | 110 | 45 | 65 | 44 |
| `mcp` | 4 | 4 | 0 | 0 |
| `mesh` | 61 | 22 | 39 | 32 |
| `pdf` | 12 | 12 | 0 | 0 |

<details><summary><code>app</code> (42)</summary>

| Tool | Class | Project-folder grant |
| --- | --- | --- |
| `app__check_simulation_environment` | read | — |
| `app__goal_seek_iterates` | read | — |
| `app__goal_seek_next` | read | — |
| `app__project_pack` | write | — |
| `app__project_unpack` | write | — |
| `app__queue_cancel` | write | — |
| `app__queue_enqueue` | write | — |
| `app__queue_geometry_sweep_preview` | read | — |
| `app__queue_inspect` | read | — |
| `app__queue_parameter_sweep_preview` | read | — |
| `app__queue_pause` | write | — |
| `app__queue_plan_preview` | read | — |
| `app__queue_reorder` | write | — |
| `app__queue_resume` | write | — |
| `app__queue_resume_row` | write | — |
| `app__queue_retry_variant_preview` | read | — |
| `app__queue_variants_preview` | read | — |
| `app__run_compare` | read | — |
| `app__run_quantity_evaluate` | write | — |
| `app__run_quantity_reevaluate` | write | — |
| `app__run_refinement_set` | write | — |
| `app__run_review` | read | — |
| `app__run_review_export` | write | — |
| `app__skill_load` | read | — |
| `app__study_attach_mesh` | write | — |
| `app__study_copy_source_into_project` | write | — |
| `app__study_create` | write | — |
| `app__study_duplicate` | write | — |
| `app__study_import_handoff` | write | — |
| `app__study_import_run` | write | — |
| `app__study_list` | read | — |
| `app__study_next_step` | read | — |
| `app__study_open` | write | — |
| `app__study_region_references` | read | — |
| `app__study_region_rename` | write | — |
| `app__study_relink_source` | write | — |
| `app__study_select` | write | — |
| `app__study_set_settings` | write | — |
| `app__variants_compare` | read | — |
| `app__variants_compare_export` | write | — |
| `app__variants_create` | write | — |
| `app__variants_preview` | read | — |

</details>

<details><summary><code>cad</code> (95)</summary>

| Tool | Class | Project-folder grant |
| --- | --- | --- |
| `cad__analyze_passages` | read | — |
| `cad__analyze_surface_geometry` | read | — |
| `cad__apply_edit_ops` | write | paths: `path` |
| `cad__apply_mesh_preset` | write | paths: `path`, `libraryPath` |
| `cad__assign_layer` | write | paths: `path` |
| `cad__batch_export` | write | — |
| `cad__check_brep_health` | read | — |
| `cad__check_draft` | read | — |
| `cad__check_handoff_manifest` | read | — |
| `cad__check_interference` | read | — |
| `cad__check_interference_all` | read | — |
| `cad__check_mesh_conformity` | read | — |
| `cad__check_mesh_health` | read | — |
| `cad__check_mesh_quality` | read | — |
| `cad__check_printability` | read | — |
| `cad__check_tolerance` | read | — |
| `cad__compare_mesh_refinement` | write | paths: `path`, `outputDir` |
| `cad__compare_models` | read | — |
| `cad__convert_scad` | write | paths: `path`, `outputPath`, `libraryPaths` |
| `cad__decompose_to_primitives` | write | paths: `path`, `outputPath`, `saveScript.libraryPath` |
| `cad__describe_capabilities` | read | — |
| `cad__diagnostics_report` | read | — |
| `cad__download_standard_part` | write | paths: `outputPath` |
| `cad__estimate_mesh_budget` | read | — |
| `cad__export_brep` | write | paths: `path`, `outputPath` |
| `cad__export_drawing_sheet` | write | paths: `path`, `outputPath`, `libraryPath` |
| `cad__export_mesh` | write | paths: `path`, `outputPath`, `handoffPath`, `receiptPath` |
| `cad__export_svg_silhouette` | write | paths: `path`, `outputPath` |
| `cad__export_technical_drawing` | write | paths: `path`, `outputPath` |
| `cad__export_tessellated_stl` | write | paths: `path`, `outputPath`, `libraryPath` |
| `cad__find_mesh_intersections` | read | — |
| `cad__fit_mesh_region` | write | paths: `path` |
| `cad__fit_mesh_to_cad` | write | paths: `path`, `outputPath`, `cadJsonPath` |
| `cad__generate_bom` | read | — |
| `cad__generate_hole_table` | read | — |
| `cad__generate_mesh` | read | — |
| `cad__generate_prep_report` | write | paths: `path`, `outputDir`, `manifestPath` |
| `cad__get_mass_properties` | read | — |
| `cad__get_state` | read | — |
| `cad__grow_prism_layers` | write | paths: `path`, `outputPath` |
| `cad__hit_test` | read | — |
| `cad__iga_evaluate` | read | — |
| `cad__iga_refine` | write | paths: `path`, `outputPath` |
| `cad__iga_sample` | read | — |
| `cad__import_svg` | write | paths: `path`, `svgPath` |
| `cad__inspect` | read | — |
| `cad__inspect_meshio_fields` | read | — |
| `cad__job_cancel` | write | — |
| `cad__job_status` | read | — |
| `cad__list_layers` | read | — |
| `cad__list_mesh_presets` | read | — |
| `cad__list_parametric_scripts` | read | — |
| `cad__list_scad_parameters` | read | — |
| `cad__list_sheet_templates` | read | — |
| `cad__list_standard_hole_sizes` | read | — |
| `cad__list_workspace_models` | read | — |
| `cad__load_model` | read | — |
| `cad__load_preprocess` | write | paths: `zipPath`, `outputPath` |
| `cad__measure` | read | — |
| `cad__measure_exact` | read | — |
| `cad__measure_mesh_deviation` | write | paths: `path`, `deviationMeshPath` |
| `cad__measure_mesh_thickness` | read | — |
| `cad__mesh_adjacency` | write | paths: `path`, `outputPath` |
| `cad__mesh_cad_surface` | write | paths: `path`, `outputPath` |
| `cad__pin_annotation` | write | paths: `path` |
| `cad__project_to_cad` | write | paths: `path`, `cadPath`, `outputPath` |
| `cad__promote_mesh_to_brep` | write | paths: `path`, `outputPath` |
| `cad__recognize_primitives` | read | — |
| `cad__register_meshes` | write | paths: `path`, `targetPath`, `outputPath` |
| `cad__remesh_mesh` | write | paths: `path`, `outputPath` |
| `cad__remove_edit_op` | write | paths: `path` |
| `cad__render_ops_prefix` | read | — |
| `cad__render_snapshot` | read | — |
| `cad__repair_mesh` | write | paths: `path`, `outputPath` |
| `cad__resolve_selector` | read | — |
| `cad__run_parametric_script` | write | — |
| `cad__run_saved_script` | write | — |
| `cad__save_mesh_preset` | write | paths: `libraryPath` |
| `cad__save_model` | write | paths: `path` |
| `cad__save_parametric_script` | write | paths: `libraryPath` |
| `cad__save_preprocess` | write | paths: `path`, `outputPath` |
| `cad__save_sheet_template` | write | paths: `libraryPath` |
| `cad__screenshot_shape` | read | — |
| `cad__search_standard_parts` | read | — |
| `cad__segment_mesh_surface` | read | — |
| `cad__select_mesh_region` | read | — |
| `cad__set_configuration` | write | paths: `path` |
| `cad__set_edit_op_state` | write | paths: `path` |
| `cad__set_layer` | write | paths: `path` |
| `cad__set_mesh_options` | write | paths: `path` |
| `cad__set_part` | write | paths: `path` |
| `cad__set_plane` | write | paths: `path` |
| `cad__set_variables` | write | paths: `path` |
| `cad__synthesize_selector` | read | — |
| `cad__transform_mesh` | write | paths: `path`, `outputPath` |

</details>

<details><summary><code>kratos</code> (110)</summary>

| Tool | Class | Project-folder grant |
| --- | --- | --- |
| `kratos__add_boundary_condition` | write | paths: `parameters_file` |
| `kratos__add_output_process` | write | paths: `parameters_file`, `output_path`, `output_file` |
| `kratos__add_remeshing_process` | write | paths: `parameters_file` |
| `kratos__configure_checkpoints` | write | paths: `case_dir`, `parameters_file` |
| `kratos__create_cosim_project` | write | — |
| `kratos__create_fsi_project` | write | — |
| `kratos__create_materials` | write | paths: `output_file` |
| `kratos__create_multistage_project` | write | paths: `directory` |
| `kratos__create_project` | write | paths: `directory` |
| `kratos__create_project_parameters` | write | paths: `output_file` |
| `kratos__explain_project_parameters` | read | — |
| `kratos__export_case_to_flowgraph` | write | paths: `parameters_file`, `output_file` |
| `kratos__import_flowgraph_to_case` | write | paths: `graph_file`, `output_file` |
| `kratos__job_cancel` | write | — |
| `kratos__job_checkpoints` | read | — |
| `kratos__job_list` | read | — |
| `kratos__job_logs` | read | — |
| `kratos__job_rerun` | write | — |
| `kratos__job_resume` | write | — |
| `kratos__job_status` | read | — |
| `kratos__kratos_check_installation` | read | — |
| `kratos__kratos_get_process_defaults` | read | — |
| `kratos__kratos_get_solver_defaults` | read | — |
| `kratos__kratos_get_variable_info` | read | — |
| `kratos__kratos_install` | write | — |
| `kratos__kratos_list_applications` | read | — |
| `kratos__kratos_list_conditions` | read | — |
| `kratos__kratos_list_constitutive_laws` | read | — |
| `kratos__kratos_list_elements` | read | — |
| `kratos__kratos_list_processes` | read | — |
| `kratos__kratos_list_solvers` | read | — |
| `kratos__kratos_list_variables` | read | — |
| `kratos__list_linear_solver_presets` | read | — |
| `kratos__list_material_presets` | read | — |
| `kratos__list_templates` | read | — |
| `kratos__materials_check` | read | — |
| `kratos__materials_get` | read | — |
| `kratos__materials_remove_property` | write | paths: `materials_file` |
| `kratos__materials_set_property` | write | paths: `materials_file` |
| `kratos__mdpa_add_entities` | write | paths: `path`, `output` |
| `kratos__mdpa_add_nodes` | write | paths: `path`, `output` |
| `kratos__mdpa_convert_cells` | write | paths: `path`, `output` |
| `kratos__mdpa_create_geometry_mesh` | write | paths: `path` |
| `kratos__mdpa_create_structured_mesh` | write | paths: `path` |
| `kratos__mdpa_create_sub_model_part` | write | paths: `path`, `output` |
| `kratos__mdpa_delete_entities` | write | paths: `path`, `output` |
| `kratos__mdpa_delete_nodes` | write | paths: `path`, `output` |
| `kratos__mdpa_delete_table` | write | paths: `path`, `output` |
| `kratos__mdpa_edit_sub_model_part` | write | paths: `path`, `output` |
| `kratos__mdpa_extract` | write | paths: `path`, `output` |
| `kratos__mdpa_extract_boundary` | write | paths: `path`, `output` |
| `kratos__mdpa_extrude` | write | paths: `path`, `output` |
| `kratos__mdpa_get_data_blocks` | read | — |
| `kratos__mdpa_get_entities` | read | — |
| `kratos__mdpa_get_nodes` | read | — |
| `kratos__mdpa_inspect` | read | — |
| `kratos__mdpa_merge` | write | paths: `path`, `other`, `output` |
| `kratos__mdpa_move_nodes` | write | paths: `path`, `output` |
| `kratos__mdpa_quality` | read | — |
| `kratos__mdpa_renumber` | write | paths: `path`, `output` |
| `kratos__mdpa_select_nodes` | read | — |
| `kratos__mdpa_set_elemental_data` | write | paths: `path`, `output` |
| `kratos__mdpa_set_entity_properties` | write | paths: `path`, `output` |
| `kratos__mdpa_set_nodal_data` | write | paths: `path`, `output` |
| `kratos__mdpa_set_properties` | write | paths: `path`, `output` |
| `kratos__mdpa_set_sub_model_part_data` | write | paths: `path`, `output` |
| `kratos__mdpa_set_table` | write | paths: `path`, `output` |
| `kratos__mdpa_transform` | write | paths: `path`, `output` |
| `kratos__mdpa_validate` | read | — |
| `kratos__mesh_export` | write | paths: `path`, `output` |
| `kratos__mesh_generate_gmsh` | write | paths: `output`, `cad_file` |
| `kratos__mesh_import` | write | paths: `source`, `output` |
| `kratos__mesh_remesh` | write | paths: `input_mdpa`, `output_mdpa` |
| `kratos__project_add_process` | write | — |
| `kratos__project_delete_setting` | write | paths: `parameters_file` |
| `kratos__project_get_setting` | read | — |
| `kratos__project_list_processes` | read | — |
| `kratos__project_remove_process` | write | paths: `parameters_file` |
| `kratos__project_set_setting` | write | — |
| `kratos__project_update_process` | write | — |
| `kratos__project_update_solver` | write | — |
| `kratos__results_animate` | write | paths: `files`, `gif_path` |
| `kratos__results_compare` | write | — |
| `kratos__results_convergence` | read | — |
| `kratos__results_list` | read | — |
| `kratos__results_probe` | read | — |
| `kratos__results_render` | write | paths: `file`, `image_path` |
| `kratos__results_summary` | read | — |
| `kratos__results_time_history` | write | — |
| `kratos__run_simulation` | write | — |
| `kratos__session_advance` | write | — |
| `kratos__session_close` | write | — |
| `kratos__session_exec_python` | write | — |
| `kratos__session_field_summary` | read | — |
| `kratos__session_get_parameters` | read | — |
| `kratos__session_inspect_element` | read | — |
| `kratos__session_inspect_node` | read | — |
| `kratos__session_list` | read | — |
| `kratos__session_model_info` | read | — |
| `kratos__session_set_nodal_values` | write | — |
| `kratos__session_start` | write | — |
| `kratos__session_status` | read | — |
| `kratos__study_cancel` | write | — |
| `kratos__study_list` | read | — |
| `kratos__study_results` | write | paths: `csv_file` |
| `kratos__study_resume` | write | — |
| `kratos__study_start` | write | — |
| `kratos__study_status` | read | — |
| `kratos__validate_case` | read | — |
| `kratos__validate_project_parameters` | read | — |

</details>

<details><summary><code>mcp</code> (4)</summary>

| Tool | Class | Project-folder grant |
| --- | --- | --- |
| `mcp__get_prompt` | read | — |
| `mcp__list_prompts` | read | — |
| `mcp__list_resources` | read | — |
| `mcp__read_resource` | read | — |

</details>

<details><summary><code>mesh</code> (61)</summary>

| Tool | Class | Project-folder grant |
| --- | --- | --- |
| `mesh__case_compare` | read | — |
| `mesh__case_convergence` | write | paths: `meshPath`, `outputPath` |
| `mesh__case_estimate_timestep` | read | — |
| `mesh__case_evaluate_quantity` | read | — |
| `mesh__case_export_results` | write | paths: `meshPath`, `folder` |
| `mesh__case_generate` | write | paths: `meshPath`, `casePath` |
| `mesh__case_material_assign` | write | paths: `meshPath`, `smpPath`, `casePath` |
| `mesh__case_monitors` | write | paths: `meshPath`, `outputPath`, `resultPath`, `run.recordPath` |
| `mesh__case_optimization` | write | paths: `meshPath`, `outputPath` |
| `mesh__case_optimization_cad` | write | paths: `meshPath`, `outputPath` |
| `mesh__case_rom` | read | — |
| `mesh__case_run` | write | — |
| `mesh__case_run_quantity` | write | — |
| `mesh__case_status` | read | — |
| `mesh__case_stop` | write | — |
| `mesh__case_validate` | read | — |
| `mesh__case_write_state` | write | paths: `meshPath` |
| `mesh__material_preset_import` | write | paths: `path` |
| `mesh__material_preset_list` | read | — |
| `mesh__mesh_ale_quality` | write | paths: `path`, `outputPath` |
| `mesh__mesh_batch_transform` | write | paths: `paths`, `recipePath`, `outputDir` |
| `mesh__mesh_capabilities` | read | — |
| `mesh__mesh_compare` | write | paths: `pathA`, `pathB`, `outputPath` |
| `mesh__mesh_convert` | write | paths: `path`, `outputPath` |
| `mesh__mesh_curvature` | read | — |
| `mesh__mesh_derive` | write | paths: `path`, `outputPath` |
| `mesh__mesh_export_table` | write | paths: `path`, `outputPath` |
| `mesh__mesh_extract_skin` | write | paths: `path`, `outputPath` |
| `mesh__mesh_extract_submodelpart` | write | paths: `path`, `outputPath` |
| `mesh__mesh_field_integrate` | read | — |
| `mesh__mesh_field_series` | write | paths: `path`, `outputPath` |
| `mesh__mesh_find_entity` | read | — |
| `mesh__mesh_fit_primitives` | write | paths: `path`, `outputPath` |
| `mesh__mesh_flow_balance` | write | paths: `path`, `outputPath` |
| `mesh__mesh_graph` | write | paths: `path`, `outputPath` |
| `mesh__mesh_info` | read | — |
| `mesh__mesh_intersections` | read | — |
| `mesh__mesh_pack_series` | write | paths: `path`, `outputPath` |
| `mesh__mesh_periodic` | write | paths: `path`, `outputPath` |
| `mesh__mesh_probe` | write | paths: `path`, `outputPath` |
| `mesh__mesh_quality` | read | — |
| `mesh__mesh_recover_flux` | write | paths: `path`, `outputPath` |
| `mesh__mesh_resample` | write | paths: `path`, `outputPath` |
| `mesh__mesh_select` | write | paths: `path`, `outputPath` |
| `mesh__mesh_size` | read | — |
| `mesh__mesh_split` | write | paths: `path`, `outputDir` |
| `mesh__mesh_transform` | write | paths: `path`, `recipePath`, `outputPath` |
| `mesh__plot_dataset` | write | — |
| `mesh__plot_preset` | write | — |
| `mesh__plot_run_bind` | read | — |
| `mesh__plot_run_resolve` | read | — |
| `mesh__plot_run_target` | read | — |
| `mesh__plot_runs` | read | — |
| `mesh__plot_table_read` | read | — |
| `mesh__plot_time_cursor` | read | — |
| `mesh__problem_pack` | write | paths: `meshPath`, `outputPath`, `recipePath` |
| `mesh__problem_unpack` | write | paths: `archivePath`, `destDir` |
| `mesh__problemtype_describe` | write | — |
| `mesh__problemtype_list` | write | — |
| `mesh__wind_tunnel_generate` | write | paths: `bodyPath`, `bodies.path`, `outputFolder` |
| `mesh__wind_tunnel_plan` | read | — |

</details>

<details><summary><code>pdf</code> (12)</summary>

| Tool | Class | Project-folder grant |
| --- | --- | --- |
| `pdf__compare_pdf_pages` | read | — |
| `pdf__extract_pdf_images` | read | — |
| `pdf__extract_pdf_links` | read | — |
| `pdf__extract_pdf_tables` | read | — |
| `pdf__get_pdf_annotations` | read | — |
| `pdf__get_pdf_info` | read | — |
| `pdf__get_pdf_outline` | read | — |
| `pdf__get_pdf_page_info` | read | — |
| `pdf__get_pdf_text_stats` | read | — |
| `pdf__read_pdf_as_images` | read | — |
| `pdf__read_pdf_as_text` | read | — |
| `pdf__search_pdf_text` | read | — |

</details>

<!-- reference:tool-reference:end -->
