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
| `kratos.threads` | Verified OpenMP threads per Kratos solve; `0` selects Auto (`available CPUs − 1`, minimum 1) | `0` (Auto) |
| `kratos.installPath` | Compiled Kratos install, or a source checkout built in-tree. Prepended to `PYTHONPATH` and the shared-library path | pip-installed Kratos |
| `kratos.extraEnv` | Extra variables; they override computed ones | — |
| `kratos.problemtypes.extraPaths` | Folders under the project folder scanned for user problemtypes | `.kratos/problemtypes` |
| `kratos.run.stopOnWindowClose` | Kill running solvers when KKSS quits | on |

Queue previews freeze their effective thread allocation; changing the setting requires a new preview. The environment probe only offers this control when both Kratos thread set and read APIs are available. Auto uses the available CPU count minus one, with a minimum of one. CAD meshing and MDPA case preparation have verified one-thread reservations; other case-preparation costs are unknown and run exclusively. The app permits one solve and one preparation task to overlap only when their recorded allocations fit the CPU budget; uncertain or legacy allocations block overlap. The install path and extra environment also reach the assistant's Kratos MCP server the next time it starts. **Restart with current environment** applies them immediately. The interpreter does not: that server runs in `uvx`'s own isolated environment.

## Interface scale

The **scale picker** on the right of the shell toolbar (75 %–150 %) sets how large the whole application is drawn — the toolbar, both viewers, the terminal, and the chat sidebar all scale together, so the layout stays proportional on high-DPI or low-resolution displays. The choice persists across launches. It's also on the keyboard: `Ctrl +` / `Ctrl -` step through the presets and `Ctrl+Shift+0` resets to 100 % (mirrored under **View ▸ Zoom In / Zoom Out / Reset Zoom**).

## LLM assistant

**Settings ▸ LLM Assistant** configures the AI chat sidebar ([Getting Started ▸ AI assistant](/guide/getting-started#ai-assistant)):

| Setting | Meaning | Default |
| --- | --- | --- |
| Provider | `Anthropic (Claude)`, `OpenAI-compatible`, `ChatGPT subscription (Codex)`, or `Claude subscription (Claude Code)` | Anthropic |
| Anthropic API Key | stored encrypted (OS keychain via `safeStorage`) | — |
| Anthropic Model | any Claude model id | `claude-opus-4-8` |
| OpenAI-compatible API Key | optional (keyless backends like Ollama work) | — |
| OpenAI-compatible Base URL | any `chat/completions` endpoint | `https://api.openai.com/v1` |
| OpenAI-compatible Model | model name your backend expects | `gpt-4o` |
| Tool Approval | `Ask before tools that change files` / `Ask before every tool` / `Never ask` | Ask before tools that change files |

The provider menu also includes **ChatGPT subscription (Codex)** and **Claude subscription (Claude Code)**. These options require the matching official local tool and an eligible signed-in subscription account. Their submenu offers a runtime check, official setup link, model override, and optional executable path. KKSS does not import or store subscription credentials.

**Tool Approval** decides when the assistant has to ask you before running one of its tools. Read versus write is a KKSS-side classification keyed by the tool's full name, not something the tool servers declare about themselves — a server's own claim about whether it is safe is exactly the thing that should not be trusted. A tool KKSS has no entry for always asks, which today is every tool from the Kratos server (it is fetched at runtime, so its tools cannot be classified in advance). The setting applies to the very next tool call. *Never ask* turns the gate off and confirms once before doing so; it covers the built-in sidebar only, since the HTTP MCP endpoint has no user to prompt.

Changes apply to the next chat message — no restart. API keys are encrypted with the OS keychain when one is available; on systems without a keyring they fall back to plaintext in `state.json` (below). Entering an empty value clears a stored key.

## Cloud accounts

**Settings ▸ Cloud Accounts** connects KKSS to Google Drive, Dropbox or OneDrive, so
**File ▸ Open from Cloud…** can open a model directly — no desktop sync client required.
See [Getting Started ▸ Working from cloud storage](/guide/getting-started#working-from-cloud-storage)
for how a cloud document behaves once it is open.

**KKSS ships no OAuth credentials of its own.** You register a desktop/installed-app client
in your own provider console and paste its client ID into the menu. That means nothing here
routes through an application account you do not control — and it means there is a one-time
setup step per provider:

| Provider | Redirect URI to register | Client secret | Scopes requested |
| --- | --- | --- | --- |
| Google Drive | `http://127.0.0.1/callback` — Google accepts a loopback redirect on **any** port | Issued for a "Desktop app" client; paste it too | `https://www.googleapis.com/auth/drive` |
| Dropbox | `http://127.0.0.1:53682/callback` — **exactly this**, Dropbox matches the whole URI including the port | None (PKCE public client) | `files.metadata.read`, `files.content.read`, `files.content.write`, `account_info.read` |
| OneDrive | `http://localhost/callback` as a **Mobile & desktop** platform redirect | None (PKCE public client) | `Files.ReadWrite`, `offline_access`, `User.Read` |

Two things worth knowing before you start:

- **Google's testing-mode refresh tokens expire after seven days.** While your OAuth consent
  screen is in "Testing", you will have to reconnect weekly. Publishing the consent screen
  (even for a single-user app) removes the limit.
- **Google Drive asks for full `drive` scope, not `drive.file`.** The narrower scope only sees
  files the app itself created or that were picked through *Google's own* file picker, which
  KKSS does not use — with it, the Open from Cloud browser would show an empty Drive.

Client IDs are stored in `state.json`; client secrets and refresh tokens go through the same
encrypted store as the LLM API key. **Disconnect…** forgets the sign-in and offers to delete
the cached copies with it.

## Where state lives

| State | Location |
| --- | --- |
| App state (theme, interface scale, project folder, recent files, last session, one-time warnings) | `state.json` in the platform's user-data dir (`~/.config/KKSS` on Linux, `%APPDATA%/KKSS` on Windows, `~/Library/Application Support/KKSS` on macOS) |
| CAD parts / edits / mesh options | JSON sidecars next to the opened model — see [Pre-Processing mode](/guide/cad-mode#sidecar-files) |
| Mesh operation recipes | Saved explicitly via the Edit sidebar's Save/Load buttons |
| Cloud client IDs | `state.json` (public by OAuth's design) |
| Cloud client secrets and refresh tokens | `state.json`, encrypted with the OS keychain like the LLM API key |
| Cloud staging cache and its manifest | `cloud-cache/` beside `state.json` in the same user-data dir |

Note that the user-data dir is **not** inside your project folder, so syncing a project folder
never syncs your settings or your credentials.

## Command-line

`kkss <file>` opens the given model on startup in the mode the file's extension implies.
