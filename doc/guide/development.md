# Architecture & Building

## The shim architecture

KKSS reuses the two VS Code extensions **without modifying them**. Both are already split into a browser-side webview bundle (whose only VS Code touchpoint is `acquireVsCodeApi()`), vscode-free compute/parser modules, and a thin vscode-coupled glue layer. KKSS replaces only the glue:

```
┌────────────────────────── BaseWindow ──────────────────────────┐
│ shell toolbar (Home · mode toggle · Open · title · toasts)     │
│ tab strip (per mode — several open documents, one per tab)     │
├────────────────────────────────────────────────────────────────┤
│ cad tab(s)                      │ mesh tab(s)                  │
│ cad/media/viewer.js (unmodified)│ mesh/media/webview.js (unmod)│
│ + acquireVsCodeApi shim         │ + acquireVsCodeApi shim      │
│ (one WebContentsView per tab)   │ (one WebContentsView per tab)│
└───────────────▲─────────────────┴──────────────▲───────────────┘
                │ IPC = the extensions' own message protocols     │
┌───────────────▼──────────────────────────────────▼─────────────┐
│ Electron main                                                  │
│  one CadHost per open cad tab — port of cad/src/provider.ts    │
│    OCCT + Gmsh WASM → shared worker thread (cadCompute.worker) │
│  one MeshHost per open mesh tab — runs the REAL                │
│    Mdpa/VtkEditorProvider classes behind a `vscode` shim       │
│    module + a fake WebviewPanel; MMG → the submodule's own     │
│    worker pair; Flowgraph's child process is shared, ref-      │
│    counted across every mesh tab, unchanged                    │
└────────────────────────────────────────────────────────────────┘
```

A fourth, full-window `WebContentsView` — the **home screen** (`app/renderer/home/`) — is stacked on top and shown on launch (and via the toolbar's Home button, `Ctrl+0`, or **View ▸ Home**). It covers the shell and every mode tab; entering a mode hides it. Screens are tracked as `Screen = "home" | "editor" | Mode` in `app/main/ipc.ts` and switched with `MainWindow.setScreen()` (`app/main/windows.ts`). Each mode screen can hold several open documents ("tabs") — `MainWindow.openTab()`/`closeTab()`/`setActiveTab()` manage a `Tab {id, view}` registry per mode, one full `WebContentsView` per tab (the same lazy-create + `setVisible()` precedent as the terminal/chat panels, just N-of-a-kind); only the focused tab of the active mode is ever visible/bounded, so switching tabs or trips through the home screen never reload or lose a tab's camera/edit-history state. `app/main/index.ts`'s `createTab(mode)` builds a tab's view and its `CadHost`/`MeshHost` together; `activeCadHost()`/`activeMeshHost()` resolve whichever tab is currently focused for callers (the native menu, the terminal's cwd, the chat context) that only ever need "the current one." The tab strip is plain DOM inside the `shell` page (`app/renderer/shell/shell.ts`), synced wholesale via a `{type:"tabs", mode, tabs, activeTabId}` message on every open/close/focus/title change — see `CLAUDE.md`'s tabs invariant for the full model, including the two genuinely-shared pieces of state (`cadBRepCache.ts`'s session-keyed worker cache and mesh's ref-counted `FlowgraphController`). The home menu's buttons are config-driven: add an entry to `app/renderer/home/homeConfig.ts`, a `HomeAction` case in `app/main/ipc.ts`, and its handler in `app/main/index.ts` (`home:toHost`/`home:toWebview` channels via `app/preload/homePreload.ts`, same contextBridge pattern as the shell). The recents list below those buttons is *not* config-driven: main pushes it over `home:toWebview` (`sendHome()`/`pushRecents()`), pre-formatted, because that renderer is a browser bundle and cannot import `node:path`. The renderer re-requests nothing — it replays on its own `homeReady`, the same handshake the shell uses, so a reload or a crash recovery repaints it.

**Interface scale.** The shell toolbar's scale picker (and **View ▸ Zoom In / Zoom Out / Reset Zoom**, `Ctrl +`/`Ctrl -`/`Ctrl+Shift+0`) sets a single zoom factor via `MainWindow.setZoom()` (`app/main/windows.ts`). `setZoomFactor` scales each `WebContentsView`'s *content* but not its bounds, so `layout()` multiplies the fixed chrome constants (`SHELL_HEIGHT`, `TAB_STRIP_HEIGHT`, `TERMINAL_HEIGHT`, `CHAT_WIDTH`) by the factor in lockstep — otherwise the scaled toolbar would clip. `TAB_STRIP_HEIGHT` is only ever added while a mode screen (which actually has tabs) is active. Electron resets a view's zoom to 1 on every navigation, so each tab's view re-asserts the factor on `did-finish-load` (a tab reloads when a file opens into it). The picker round-trips over the shell channel (`ShellToHost.setZoom` / `ShellToWebview.zoom`), and `app/main/index.ts` persists it under the `uiZoom` stateStore key and re-applies it on the next launch (passed into `createMainWindow`). Presets live in `ZOOM_PRESETS` — the shell renderer mirrors the same list to build the dropdown.

**One instance, one open queue.** KKSS takes `app.requestSingleInstanceLock()` at module load (`app/main/index.ts`). A second launch does not become a second app: it prints a diagnostic, quits, and its argv reaches the running instance through the `second-instance` event, which focuses the window and opens the file. This matters beyond convenience — two instances share one `userData/state.json`, and because the store rewrites that file whole, the loser's first settings write would silently discard everything the winner had changed, including the safeStorage-encrypted API key and the MCP bearer token. macOS's `open-file` (Finder "Open With", a file dropped on the dock icon) fires *before* `app.whenReady()`, so an early path is queued and flushed once the window and its starter tabs exist; the command-line argument drains through the same queue, so there is exactly one "open this path at launch" mechanism. A relative path forwarded by a second instance resolves against *that* process's working directory, which `second-instance` supplies. Set `KKSS_ALLOW_MULTIPLE_INSTANCES=1` to opt out — `tools/e2eShared.mjs` does, because the e2e harness relaunches the app repeatedly and SIGKILLs the process tree between runs, and it is the escape hatch for a developer who keeps KKSS open while running `npm run smoke` or `npm run docs:screenshots` against the same `~/.config/kkss`.

**Renderer-crash recovery.** `wireView()` in `app/main/windows.ts` is the single place every `WebContentsView` in the window is wired up — it re-asserts the zoom factor on `did-finish-load` *and* watches for a dead renderer (`render-process-gone`, plus a main-frame `did-fail-load` on one of our own `kkss://app/` pages; aborted loads and subresource failures are ignored). It only reports: the policy lives in `app/main/index.ts`, which owns the host maps and so knows what to replay. Recovery leans entirely on handshakes that already exist — the shell replays screen, tab strips and zoom on `shellReady`, the editor replays its last document on `editorReady`, the terminal's `termReady` reuses the still-running pty, the chat replays from its main-side transcript (now also on disk), and a mode tab re-runs the provider handshake through `openPath()` (whose `disposeSession()` is also what rejects the pending promises a crash would otherwise leak). So recovery is a reload, plus a file replay for a mode tab. It is bounded (a few attempts inside a five-minute window) so a reproducible crash cannot become a reload loop, and every recovery raises a toast. `unresponsive` is deliberately **not** wired to recovery — it fires on any long synchronous parse, which is exactly what both viewers do on a large mesh, so reloading on it would destroy a working session mid-load.

### Flowgraph embedding

The mesh submodule's **Flowgraph** problemtype (`view: "flowgraph"`) splits the MDPA preview's viewport to embed the AGPL-3.0 [`@kratos-flowgraph/flowgraph`](https://www.npmjs.com/package/@kratos-flowgraph/flowgraph) node editor in an `<iframe>`, served by a small Express+EJS app the submodule forks on demand (`mesh/src/flowgraphServer.ts`, `mesh/src/ flowgraphController.ts`). `app/main/index.ts` owns the shared, ref-counted `FlowgraphController` instance — mirroring `mesh/src/extension.ts`'s `activate()` — and injects it into every `MeshHost`, which passes it into `new MdpaEditorProvider(context, flowgraph, runs, recents)` (the VTK provider takes `(context, recents)`; it ships the same pane markup inertly for chrome parity) and disposes it on Electron's `will-quit` so the forked child process never outlives the app. `runs` is the shared `RunManager` and `recents` mesh 3.15.0's `RecentMeshStore` — the same construct-once-inject-everywhere rule, for the same reason: a solve, and the recent-file list, both outlive the tab they came from.

**Path contract**: like the MMG worker pair, `flowgraphController.ts` resolves its server and assets via `__dirname`, so `esbuild.mjs`'s `copyArtifacts()` places `out/flowgraphServer.js` and the `out/flowgraph/` asset tree (copied from `mesh/dist/flowgraph/` — Flowgraph's `public/`+ `views/`, its `LICENSE`, and our `vscode-bridge.js`) directly beside `out/main.js`.

### Extended mesh formats (meshio++)

The mesh submodule reads 43 (writes ~37) mesh formats it has no native parser for (Gmsh, Abaqus, Nastran, I-deas UNV, Medit, Netgen, SU2, XDMF, COMSOL, tetgen, EnSight Gold, Triangle, Exodus II, CGNS, MOAB, Salome MED, …) through [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm) (10.20.2) — meshio++'s C++ core compiled to WebAssembly. meshio++ adds the field-only `.dex`/`.ip`/`.mff` formats: they carry point fields with no cell geometry, so writing one keeps the points plus a field and drops connectivity, and reading one yields a point cloud (or an empty mesh); plus write-only SVG/TikZ figure formats (a 2D/3D-projected drawing of the mesh) surfaced in the export menu's "Figures" group. Since 8.5.0 the WASM statically links HDF5 and netCDF, which is what makes Exodus/CGNS/H5M/HMF/MED reachable — and since 8.6.0 a multi-step file exposes its steps through `ReadOptions.timeStep` / `MeshMetadata.timeValues`, which is the in-file timeline (9.9.0 added `timeStep` for MED too, but MED has no metadata reader upstream, so only Exodus can report its step count before a read). 9.9.0 also made MED a writable format and let SubModelParts survive an export to MED/Abaqus, by fixing the shapeless-data boundary that silently reshaped an `(n, 3)` vector field into `(3n, 1)` on the way into the WASM. It is ESM-only (its Emscripten glue reads `import.meta.url`), so the submodule keeps it `external` and ships it verbatim as the `mesh/dist/meshio/` tree, and `mesh/src/parser/meshio.ts` loads it through a runtime dynamic `import()` rather than a bundled require.

**Path contract**: `meshio.ts`'s `packageDir()` falls back to `path.join(__dirname, "meshio")`, and `meshio.ts` is bundled into **both** `out/main.js` (mesh host → `meshFileParser`/`meshWriter`) and `out/mcpServer.js` — both with `__dirname === out/`. So `copyArtifacts()` mirrors `mesh/dist/meshio/` to a single `out/meshio/` tree beside `out/main.js`, serving the app host and the MCP server at once. The `.wasm` is loaded via meshio++'s `locateFile` hook (the `wasmBinary` buffer hook MMG uses is unavailable in this build), which is why `out/` stays unpacked (`asar: false`). `@meshioplusplus/wasm` is also added to the parent `mainConfig.external` in `esbuild.mjs`, because the bundled `meshio.ts` contains a `require.resolve("@meshioplusplus/wasm/package.json")` literal esbuild would otherwise try to resolve at build time.

**Both WASM variants must ship.** Since meshio++ 8.8.0 the package carries a threaded build (`meshioplusplus_wasm_mt.{mjs,wasm}`, ~+6.2 MB) alongside the sequential one, and its `resolveVariant()` picks the threaded one under Node — which is what KKSS's main process and `out/mcpServer.js` are. Shipping only the sequential pair makes **every** extended format fail with an opaque `LinkError`. The mesh submodule's own copy plugin emits all four files into `mesh/dist/meshio/`, and `copyArtifacts()` mirrors that tree wholesale (`fs.cpSync(..., { recursive: true })`), so no parent-side enumeration needs updating — but after a submodule bump, check `out/meshio/dist/meshioplusplus_wasm*` really lists four files.

### About dialog & updates

**Help ▸ About KKSS…** (and the home screen's Help button) opens a frameless singleton window (`app/main/services/about.ts`, same pattern as the modal picker) backed by `app/renderer/about/` over `about:init` / `about:toHost` / `about:toWebview` (`app/preload/aboutPreload.ts`). It shows the version (`app.getVersion()`), the author (injected from `package.json` by an esbuild `define`), and an update check.

Update flow (`app/main/services/updates.ts`):

- **Availability** — the GitHub REST API (`releases/latest`) + a `semver` compare; works in dev runs too. Offline / rate-limited / bad tags degrade to a "Couldn't check for updates" line with Retry — never a crash.
- **Delivery** — `electron-updater` (GitHub provider), only where the app can self-replace: the Windows NSIS install and the Linux AppImage. `.deb` installs and the (unsigned) macOS builds get an "Open releases page" button instead, as does any runtime updater failure.
- Both `semver` and `electron-updater` are devDependencies bundled into `out/main.js` by esbuild — the package still ships no `node_modules`.

The feed plumbing electron-updater needs: the `publish:` block in `electron-builder.yml` makes electron-builder emit `latest*.yml` into `release/` and embed `resources/app-update.yml` in each package (even with `--publish never`), and `.github/workflows/release.yml` uploads `release/latest*.yml` + `release/*.blockmap` so they land on the GitHub Release next to the installers. Remove either half and in-app updates stop finding releases.

### What's New / changelog dialog

`app/main/services/whatsNew.ts` shows a frameless singleton window (same pattern as the About dialog) backed by `app/renderer/whatsnew/` over `whatsNew:init` / `whatsNew:toHost` (`app/preload/whatsNewPreload.ts`). `checkForNewVersion()` runs once at startup (`app/main/index.ts`): it compares the `lastSeenVersion` stateStore key against `app.getVersion()` and, if the version changed, shows the CHANGELOG.md entries newer than the last-seen one (`semver.gt` per entry). It stays silent on a fresh install (nothing to diff against yet) and under the e2e smoke test (`KKSS_E2E`). **Help ▸ What's New…** (`showChangelog()`) reopens the full history on demand, regardless of version.

Content comes straight from the repo's `CHANGELOG.md` — `esbuild.mjs`'s `copyArtifacts()` copies it verbatim to `out/CHANGELOG.md` (read via `__dirname` next to `out/main.js`, same path-contract pattern as the other `out/`-relative assets), and `app/main/services/changelog.ts`'s `parseChangelog()` — kept electron-import-free like `updateCheck.ts`, so `test/changelog.test.ts` can exercise it directly — splits it on the `## [X.Y.Z] - YYYY-MM-DD` headings the `CLAUDE.md` changelog-sync rule enforces. Keeping that format is what keeps this dialog's content accurate; a heading that doesn't match the pattern is silently skipped.

## Embedded terminal (node-pty + xterm.js)

The Terminal toolbar button / ``Ctrl+` `` toggles a bottom panel `WebContentsView` (lazily created in `app/main/windows.ts`; `layout()` shrinks the mode views by `TERMINAL_HEIGHT` while it's shown). The renderer (`app/renderer/terminal/`, `@xterm/xterm` + fit addon) talks to `app/main/services/terminal.ts` over `term:toHost` / `term:toWebview` (`app/preload/terminalPreload.ts`): one node-pty session shared by both modes, spawned on first show in the current file's directory — PowerShell on Windows, `$SHELL` elsewhere, overridable via **Settings ▸ Terminal Shell** (`stateStore` key `terminalShell`) — kept alive while hidden, killed on quit; the renderer offers an Enter-to-restart when the shell exits.

**node-pty is the app's only native module**, and the only `node_modules` entry that ships in the package (see the `files` rules in `electron-builder.yml`; `asar: false` means the `.node` binaries load directly). It is N-API, so **no Electron-ABI rebuild step exists or is needed** — Windows/macOS use the prebuilt binaries shipped in the npm package, Linux compiles once during `npm ci` (GitHub runners and typical dev boxes have the toolchain). Two consequences to keep in mind:

- `package.json`'s `allowScripts` must keep the `node-pty@…` entry — without it the install scripts are skipped and the binaries never materialize.
- The release workflow builds on **one runner per OS/arch** (`ubuntu-24.04-arm`, `windows-11-arm` for the arm64 targets): Linux needs a native compile and Windows assembles arch-specific ConPTY binaries at install time, so cross-arch packaging from a single runner is no longer possible.

**CSP note:** xterm.js injects `<style>` elements at runtime, so `app/renderer/terminal/index.html` allows `'unsafe-inline'` styles — this page only; every other page keeps the strict `style-src kkss:`.

## Text editor (CodeMirror 6)

The `editor` screen (`Screen = "home" | "editor" | Mode`) is a `WebContentsView` with body bounds — the shell toolbar stays visible and the terminal panel shares space with it. `app/renderer/editor/` bundles CodeMirror 6 (`codemirror` basic setup + `@codemirror/lang-json`/`lang-python`
+ one-dark theme); all fs work lives in `app/main/services/editor.ts` behind `editor:toHost` / `editor:toWebview` (`app/preload/editorPreload.ts`) — the renderer never touches the filesystem. File ▸ Save / Save As route to the editor when it's the active screen (`main.screen()`), and the in-page CodeMirror keymap binds `Mod-s` for the focused case. Dirty handling: the buffer survives screen switches (views are only hidden), so prompts fire only on the destructive paths — window close (Save / Don't Save / Cancel) and opening another file over unsaved changes. Like the terminal page, the editor page allows `'unsafe-inline'` styles (CodeMirror injects `<style>` at runtime).

## AI chat sidebar (LLM agent + MCP)

The Chat toolbar button / `Ctrl+Shift+L` toggles a right-hand sidebar `WebContentsView` (lazily created in `app/main/windows.ts`; `layout()` shrinks the body views and the terminal panel by `CHAT_WIDTH` while it's shown). The renderer (`app/renderer/chat/`, dependency-free, strict CSP) talks to `app/main/services/chat/chatService.ts` over `chat:toHost` / `chat:toWebview` (`app/preload/chatPreload.ts`); all network and child-process work stays in the main process, and the transcript is replayed on `chatReady` so hiding/showing the sidebar never loses the conversation.

`ChatService` runs the agent loop: a provider adapter streams one model turn, tool calls are dispatched, and the loop repeats until the model stops calling tools (or the user hits Stop — dangling tool calls are pruned from the next request by `transcript.ts`). Two providers exist behind one interface (`app/main/services/chat/providers/`): **Anthropic** via `@anthropic-ai/sdk` (adaptive thinking, with a one-shot conservative retry for older models) and **OpenAI-compatible** via raw `fetch` + SSE against a configurable `{baseUrl}/chat/completions` (works with OpenAI, Ollama, OpenRouter…). Both SDKs are devDeps bundled into `out/main.js` — nothing new ships in `node_modules`.

**Conversations are durable, and there are many of them.** Transcripts live under `<userData>/chats/` — one `<id>.json` per conversation plus a small `index.json` of the rows the sidebar's `☰` history popover lists (title, last-used time, entry count, and which conversation was last active). Each file is its own `JsonStore` instance, so every write is the same atomic temp+fsync+rename behind a single-writer chain, and only the active conversation is held in memory (`TranscriptStore.close()` flushes and drops the rest). The split mirrors `sessionCore.ts`/`session.ts`: `transcriptStoreCore.ts` is pure (the versioned blob shapes, parsing that *repairs* a damaged entry list rather than losing the conversation, title derivation, the caps) and `transcriptStore.ts` is the filesystem glue. `CHAT_STORE_VERSION` is ignored wholesale on mismatch, and an index row whose file is gone — or whose blob this build cannot read — is pruned at read time rather than reconciled by a transaction across the two files. Entries are written on append boundaries with a 1 s debounce (never per stream delta: a tool result is capped at `RESULT_CHARS` = 50 000 characters), plus an undebounced save on each user message and at the end of every turn, and `ChatService.flushSync()` from `will-quit` (which lands a still-pending debounced save rather than cancelling it, so quitting inside the debounce window loses nothing). Caps: `MAX_CONVERSATIONS` = 50 (least-recently-updated evicted, never the active one) and `CONVERSATION_ENTRY_CAP` = 2000. Stored entries keep the **full** tool-result text the model was given — `toWire()`/`PREVIEW_CHARS` in `transcript.ts` remains the single truncation point, so the renderer never sees it.

**A turn is bound to the conversation it started in.** `run()` captures the active conversation once and every append targets that object; every message it emits goes through a guard that drops it unless that conversation is still on screen. Switching, or deleting the *active* conversation, therefore aborts the in-flight turn and waits for it to unwind before the switch takes effect — the interrupted turn is recorded as an assistant entry carrying whatever text had streamed, flagged `stopped` (an append, not a flag set on the previous entry, which would mislabel an already-finished turn when the abort lands on iteration 2+ of the tool loop). Deleting a *background* conversation never disturbs the running one. `newChat` archives rather than destroys, so there is nothing to confirm; an untouched conversation is neither written nor listed, so **New** costs nothing.

Tools come from three stdio MCP servers managed by `app/main/services/chat/mcpManager.ts` (spawned lazily on first chat use, per-server failure tolerated, tool names namespaced `cad__*` / `mesh__*` / `kratos__*`):

| Server | Bundle / command | Placement contract |
| --- | --- | --- |
| `cad-preview` (46 tools) | `out/cad-runtime/dist/mcp-server.js` | beside the OCCT/Gmsh WASM, so its `extensionPath` (= `dirname/..`) resolves to `out/cad-runtime` |
| `kratos-mdpa` (21 tools) | `out/mcpServer.js` | beside `out/mmg-core.wasm` (the bundle reads `__dirname/mmg-core.wasm`) and the `out/meshio/` tree (meshio++'s `__dirname/meshio` fallback, for the extended-format tools) |
| `kratos-mcp-server` (40 tools) | `uvx kratos-mcp-server@<version>` | pinned to `KRATOS_MCP_VERSION`; marked *unavailable* if `uv` is missing; chat continues without it |

The kratos server is **pinned** to `KRATOS_MCP_VERSION` (`mcpManager.ts`) — bump that constant to upgrade; the tool/resource/prompt surface is discovered at runtime (`listTools`), so no other code changes when it grows. Its 0.3.0 knowledge layer also ships MCP **resources** (worked examples) and **prompts** (guided setups); `McpManager` aggregates both (`listResources`/`readResource`/`listPrompts`/ `getPrompt`, resource URIs owner-mapped, prompt names namespaced). The provider loop only understands tools, so these are surfaced to the chat as four synthetic `mcp__*` tools (`chatTools()` = real tools + `mcp__list_resources` / `mcp__read_resource` / `mcp__list_prompts` / `mcp__get_prompt`).

The two Node bundles are spawned with **Electron's own binary + `ELECTRON_RUN_AS_NODE=1`** (packaged machines have no system Node), and the full parent environment is always passed to `StdioClientTransport` — the SDK otherwise strips env to a minimal set, which silently breaks `uvx` (PATH). The bundles are copied from the submodules' `dist/` by `esbuild.mjs`'s `copyArtifacts()` — which also mirrors the `out/meshio/` tree beside `out/mcpServer.js` so the `mesh_convert`/`mesh_info` tools can read/write the extended meshio++ formats (see *Extended mesh formats* above); the submodules themselves are unmodified (the MCP servers are built by their normal `build`/`package` scripts on the `kkss.dev` branch).

API keys are entered via **Settings ▸ LLM Assistant** (`showInputBox` modals) and stored in the stateStore encrypted with Electron `safeStorage` (`app/main/services/chat/secrets.ts`; plaintext fallback when the OS has no keyring). Settings are read per request — no restart needed. stateStore keys: `llmProvider`, `llmModelAnthropic`, `llmKeyAnthropic`, `llmModelOpenai`, `llmKeyOpenai`, `llmOpenaiBaseUrl`, `llmToolApproval`.

### Tool-call approval

`app/main/services/chat/toolPolicy.ts` decides whether a tool the model asked for runs straight away or has to be approved. It is a **pure** module (no `electron`, no `node:*`, the approval mode passed in rather than read from the stateStore) so `test/` drives it directly — `test/chatToolPolicy.test.ts`.

Classification is a **KKSS-side table keyed by the full namespaced name** (`cad__apply_edit_ops`, `mesh__mesh_transform`), covering all 72 tools the two bundled servers and the in-process `mcp__*` meta tools advertise. It is deliberately *not* derived from MCP's `Tool.annotations`: the SDK's own type declarations say a client must never make tool-use decisions from a server's annotations, and no cad/mesh tool declares any in the first place. Name-prefix and description heuristics are rejected for the same reason — `mesh__problemtype_list` looks like a listing and actually *executes* workspace problemtypes. Anything unlisted is `unknown`, which always asks; that is what makes the external `kratos-mcp-server` (40 tools, resolved by uvx at runtime) safe without pretending to know what it does. `gateFor`'s precedence is `never` → an always-allow grant → `askAlways` → read-is-auto → ask.

The gate sits in `chatService.ts`'s tool loop, between appending the `toolCall` entry (so the user can read the arguments they are approving) and `mcp.callTool`. Three rules are load-bearing and easy to break:

- **`awaitApproval` never rejects and always settles.** `settleTurn()` *awaits* the running turn and five paths reach it (Stop, New chat, selecting another conversation, deleting the active one, `will-quit`), so a promise that could stay pending would deadlock all five — the abort listener is what keeps the app closable. `flushSync()` settles it too, before the store latches shut.
- **A denial still appends a `toolResult`** (`ok:false`). `transcript.ts` drops a `toolCall` with no matching result, so a silent denial would vanish from the next request and the model would re-emit the same call, burning one of `MAX_ITERATIONS`.
- **A *pending* approval is never persisted.** It rides `ChatToWebview`'s `state.pendingApproval` and is replayed on `chatReady`, so a renderer reload resumes a blocked turn rather than stranding it — while a hard crash cannot replay live-looking buttons wired to a promise that no longer exists. The *decision* is persisted, as an optional `approval` field on the `toolCall` entry, which needed **no `CHAT_STORE_VERSION` bump** (a bump discards every stored conversation; an optional field degrades correctly in both directions).

"Always allow in this conversation" lives in a service-level `Map<conversationId, Set<string>>`, **not** on `LiveConversation`: `store.close()` drops that object on every conversation switch, so a grant there would expire on a round trip through the history popover. New wire messages: `approveTool` (renderer → main, correlated by `callId`), `approvalRequest` and `approvalResolved`.

`unclassifiedTools()` is the submodule-bump seam: `ChatService` logs the unclassified names once per process, and `test/chatToolPolicy.test.ts` pins the exact 72-name key set, so a bump that adds a tool is a visible edit rather than a silent slide into "ask about everything".

#### Validate (dry run)

Three cad tools take a `dryRun` parameter (`cad__apply_edit_ops`, `cad__run_parametric_script`, `cad__run_saved_script`), listed in `toolPolicy.ts`'s `DRY_RUN_PARAM`. When the blocked call is one of them the prompt grows a fourth button, **Validate (dry run)**, which re-issues it with that flag set so the user can answer the prompt with a report in front of them.

It is deliberately **not** a fourth decision. `dryRunTool` (renderer → main, `callId`-correlated like `approveTool`) leaves the gate open, and the report is pushed back as `dryRunResult` and **never appended to the transcript** — so the model is never handed a result for a call that did not happen, which is the semantics problem that kept this unbuilt, and no `contextSuffix()` or system-prompt change was needed. `dryRunArgs()` in `toolPolicy.ts` is the single decision point: it rewrites the arguments without mutating them, and returns `null` (which is also what hides the button) for a tool with no row, unparseable or non-object arguments, or a call the model already marked `dryRun: true`.

Because the handler runs outside `run()`, the turn's conversation and abort signal are carried on the `pendingApproval` record and re-read when the call returns — a Stop, a conversation switch or a delete drops the report rather than painting it into whatever is on screen. `awaitApproval`'s `finish()` nulls that record, which is what makes an in-flight dry run stale on Deny, Allow, abort and `flushSync()` alike. Re-entrancy is guarded on main rather than by disabling the button, since a `state` replay rebuilds the prompt with a fresh one. A completed report rides `pendingApproval.dryRunPreview` so a reload keeps it.

The wording is narrow on purpose: cad gates its OCCT replay on the same flag it gates its writes on, so the report says which operations parse and are legal — not what the geometry would become.

#### Images in tool results

`mcpManager.extractImages()` forwards an MCP tool result's `{type:"image"}` blocks to the sidebar, which is how `cad__render_snapshot` and `cad__compare_models` become visible. `flattenContent()` is untouched, so the *model* still reads its `[image content]` placeholder and the two views cannot drift apart (a test in `test/chatMcpRouting.test.ts` pins the pairing).

They are **session-only**. The transcript store holds the full tool-result text *the model was given*, and the model is not given the bytes — so `ChatEntry`, `parseEntry` and `CHAT_STORE_VERSION` are unchanged, and no conversation file carries megabytes of base64 through its whole-file atomic rewrite. They also never ride a `ChatWireEntry`: they travel as their own `toolImages` message, sent after the entry and replayed after `state`, because `sendState()` fires on far more than a reload and `webContents.send` structured-clones synchronously on the main thread. The cache is one `Map<callId, ChatImage[]>` for the active conversation, cleared in `switchTo()`, so `IMAGE_BUDGET_BYTES` is the global bound by construction (oldest-first eviction).

Caps are set for the renderer's benefit, not the wire's: a byte cap bounds the transfer but not the decoded bitmap, so the per-image cap is small, the message carries `live` (a replay never force-opens a chip), and the `<img>` is created lazily when the chip is actually expanded. SVG is excluded from the mime allow-list and the base64 is shape-validated — it is interpolated into a `data:` URL by a page with no `'unsafe-inline'`. `app/renderer/chat/index.html`'s CSP already allowed `img-src kkss: data:`, so it needed no change.

#### Token, cost and context

`TurnResult.usage` carries what a turn cost, and is **optional**: absent means the provider reported nothing, which must stay distinguishable from "cost nothing". Getting one comparable number out of two APIs takes work on both sides — Anthropic bills `cache_read_input_tokens` and `cache_creation_input_tokens` *in addition to* `input_tokens` (so the context figure is the sum of all three), while OpenAI counts cached tokens *inside* `prompt_tokens` (so `parseUsageChunk` subtracts them back out). `TurnUsage.input` means uncached input on both.

The OpenAI-compatible path needs a request change too: usage is only sent when `stream_options: {include_usage: true}` is asked for, and it arrives in a final chunk with an **empty `choices` array** — which is why it is parsed before the `delta` guard that skips choice-less chunks. A stricter gateway may reject the unknown field outright, so a 400 mentioning `stream_options` retries once without it and accepts no usage, mirroring the Anthropic conservative retry.

`app/main/services/chat/modelInfo.ts` holds context windows and per-1M prices, in the same deliberate-table mould as `toolPolicy.ts`: a row is a reviewed edit and `test/chatModelInfo.test.ts` pins the key set. **An unrecognised model resolves to `null`, and the sidebar then shows raw token counts with no cost and no context percentage** — the normal case for the OpenAI-compatible provider, which points at arbitrary gateways whose pricing KKSS cannot know. Cache rates are stored per row rather than derived from the input price, because the usual 0.1x/1.25x relationship has exceptions.

Cumulative usage is an optional `usage` field on `StoredConversation`, needing **no `CHAT_STORE_VERSION` bump** (the `approval` precedent), and is persisted rather than session-only because a lifetime cost that reset on restart would be worse than none. `lastInput` is replaced per turn rather than summed — "how full is the window" is a different question from "what has this cost". Main resolves the price and window before sending, so the renderer never carries the pricing table.

Two new `ChatErrorKind`s, `context` and `rateLimit`, replace the bare `other` banner these used to get. **Any new kind must also be added to `ERROR_KINDS` in `transcriptStoreCore.ts`**, or a stored error of that kind is silently rewritten to `other` on read. A context overflow also suppresses the Anthropic conservative retry: it is a 400, but lowering `max_tokens` cannot shorten an over-long prompt, so retrying only cost a round trip and reported the wrong error.

#### Prompt caching

The Anthropic request carries one `cache_control` breakpoint, on the `system` block. The render order is `tools` → `system` → `messages`, so it covers the tool definitions too — which is the point, since the whole MCP toolset is re-sent on each of up to `MAX_ITERATIONS` iterations. This is what `SYSTEM_PROMPT`'s byte-stability and `contextSuffix()`'s "volatile context rides the newest user message" rule were always for; before the breakpoint existed the discipline was paid for and never collected on. Consequently **changing the system prompt, or moving volatile context into it, now has a measurable cost**, and `cache_read_input_tokens` reading zero across repeated turns means something is invalidating the prefix. The conservative retry drops `cache_control` along with `thinking`.

`ChatService.run()` snapshots the available tool definitions once per user turn and uses that list for every model request, including context-overflow retries and the unclassified-tool check. It does not wait for all MCP servers to connect: newly connected servers contribute tools on the next user turn. This keeps asynchronous startup from changing the tools + system cache prefix between iterations of the first turn. The system prompt is unchanged.

#### Transcript compaction

A long conversation eventually stops fitting in the model's context window. `app/main/services/chat/compaction.ts` handles that by **clearing the text of older tool results from requests** — not by summarizing. It runs on the copy `requestEntries()` builds, so `convo.entries`, the sidebar and `<id>.json` all keep the full text; the sidebar still shows every result, and a line under the header discloses that the model is no longer being sent them.

Clearing works because it is structurally invisible: `groupTurns` matches a result to its call by `callId` alone and the "answered" filter is a `Map.has`, so replacing a `toolResult`'s text leaves the message list role-for-role identical. That removes the cut-point rule, the orphan-`tool_result` hazard and the model call summarizing would have needed. It only holds for tool *results* — blanking an assistant entry can delete a whole message. Only `ok === true` results are cleared: a denied call's text is the "do not retry" instruction the approval gate depends on.

The boundary is a **count** (`StoredConversation.compactedResults`), not a reference to a particular call. An id anchor fails twice — it vanishes when `capEntries` trims the front, and tool-call ids are not unique on the OpenAI-compatible path, where a gateway that streams no ids gets synthetic `call_<index>` values that repeat every iteration. A count has no identity to lose, and when it no longer matches the entries it simply clears more. The invariant is that a stale boundary must never clear *less* than before. It is persisted (with a parse line in `parseConversation`, which rebuilds field by field) so it survives a restart and a conversation switch, and it only ever grows.

Two triggers. **Proactive**: after the per-iteration usage fold, when `lastInput` passes 70% of a known context window — which with 1M windows rarely fires. **Reactive**: a `context` provider error advances the boundary and retries, and this is the path that does the real work, and the only one that helps a model whose window KKSS does not know. The retry wraps only the `streamTurn` call, never the loop body, because `assistantStart` opens a fresh assistant bubble in the renderer; it retries once by construction, since the second call has no catch.

What it cannot fix: the tool schemas re-sent every iteration, and `toolCall.argsJson`, which nothing truncates and which cannot be blanked because the wire formats need real JSON. And "tool results dominate" is an empirical claim, not a bound — one maximal assistant message is larger than one maximal tool result.

Two latent defects were fixed alongside it: `capEntries` snapped its cut forward to the next user entry instead of slicing mid-turn, and `toAnthropicMessages`'s first-message trim now *strips* leading `tool_result` blocks rather than dropping the message (same-role merging means that first user message routinely carries the orphan and the first real user text together).

### Meta MCP server (expose the toolset over HTTP)

The same aggregated toolset can be re-exposed as a single MCP **server** so an *external* LLM client (Claude Desktop, another agent) drives KKSS — the inverse of the sidebar (which makes KKSS an MCP client). One `McpManager` is shared between both front-ends via **`McpHub`** (`app/main/services/chat/mcpHub.ts`), constructed once in `index.ts` and disposed on `will-quit`; whichever of {chat opened, external client connected} happens first spawns the three children, the other reuses them — never a double spawn.

`app/main/services/metaServer/` holds the server: `buildServer.ts` wires `McpManager` behind the low-level MCP `Server` (raw JSON-Schema tools forwarded verbatim via `callToolRaw`, resources & prompts re-exposed natively), and `metaServer.ts` (`MetaMcpServer`) runs a bare `http.createServer` bound to `127.0.0.1` with the SDK's `StreamableHTTPServerTransport` (stateful sessions keyed by `Mcp-Session-Id`; late server readiness emits `list_changed`). It is **off by default**, requires an `Authorization: Bearer <token>` (generated on first enable, safeStorage-encrypted like the API keys), and validates the `Host` header — these tools touch the filesystem and run simulations. The SDK server subpaths bundle into `out/main.js`; nothing new ships in `node_modules`. Enable it and copy the `http://127.0.0.1:<port>/mcp` address + token from **Settings ▸ MCP Server**. stateStore keys: `metaServerEnabled`, `metaServerPort` (default `7391`); secret: `metaServerToken`. **Note the asymmetry with the built-in sidebar: `callToolRaw` here is deliberately NOT gated by the tool-approval policy above** — an external client has no user to prompt, so this path is protected by the bearer token alone. That means one `McpHub` serving two front-ends with different trust models; it is a known gap, not an oversight.

### Cloud staging layer

`app/main/services/cloud/` opens a Google Drive / Dropbox / OneDrive file by **downloading it into
a local staging cache and handing that local path to `openFile()`**. Nothing below the staging
layer knows a document is remote: routing (`router.ts`'s longest-suffix rule), `allowRoot()`, both
hosts' `fs` calls and the submodules' own MCP servers all keep working unmodified. That is the only
shape that was available — every consumer of an opened path assumes a real file already on disk,
and the zero-modification invariant rules out teaching the submodules' `node:fs` calls to speak a
provider API.

The pure/glue split is the usual one, so `test/` can drive the interesting parts without Electron:
`cloudCore.ts` (types, `CLOUD_KEYS`), `cachePathCore.ts` (path derivation, sidecar rules),
`manifestCore.ts`, `conflictCore.ts`, `oauthCore.ts`, `uploadChunkCore.ts` and the three
`providerCore/*.ts` parsers are pure; `oauth.ts`, `providers/*.ts`, `stagingCache.ts`,
`cloudSync.ts` and the `cloudService.ts` façade are the glue. Tests:
`cloudCachePath`, `cloudManifest`, `cloudConflict`, `cloudOauth`, `cloudProviders`,
`cloudUploadChunks` and `cloudSync` — the last drives the whole write-back engine against a real
temp directory, real chokidar and a fake provider.

Decisions worth knowing before changing any of it:

- **Layout.** `<userData>/cloud-cache/<provider>/<sha256(account,item)[0:16]>/<original filename>`.
  Deterministic so sidecars survive across sessions, opaque so a Dropbox path or Drive id cannot
  escape the cache root, and the filename is preserved byte-for-byte because routing is
  extension-driven (`case.post.msh` must not become `case.msh`). **One directory holds exactly one
  document plus its sidecars** — that is what makes cad's `${modelPath}.parts.json` siblings land
  correctly with no `cadHost.ts` change, and makes "every other non-artifact file here is a
  sidecar" a safe rule rather than a guess.
- **`allowRoot()` is untouched.** `CadHost.openPath` already allow-lists `path.dirname(fsPath)`,
  which for a staged file *is* its staging directory. Allow-listing `cloud-cache/` itself would
  make every cached document from every account fetchable by any webview — the mistake the
  project-folder invariant exists to avoid.
- **Write-back is watcher-driven, not host-driven, and that is forced.**
  `mesh/src/meshExport.ts`'s `saveMesh()` overwrites the document in place with a bare
  `fs.promises.writeFile` inside the submodule and never reports the path back, so a save can be
  observed but never intercepted. One `depth: 0` chokidar watch per staging directory (the bare
  `*` pattern added to `services/watcher.ts`) covers cad's eight sidecar writers, mesh's in-place
  save, an export aimed back into the directory and `EditorService` at once. Its `depth: 0` is also
  a real limit: XDMF's sibling `.h5` is uploaded, OpenFOAM's nested `constant/polyMesh/` tree is
  deliberately not.
- **Revisions.** Drive `headRevisionId`, Dropbox `rev`, Graph **`cTag` — never `eTag`**, which also
  moves on metadata-only edits and would manufacture a conflict copy every time OneDrive touched
  the file for its own reasons. The wire-level precondition is carried separately (`precondition`
  on `CloudFile`) because Graph's `if-match` accepts only `eTag`. Only Dropbox enforces the
  conditional server-side; Drive has no conditional media overwrite at all, so its guard is
  check-then-upload with a residual race, which its module header states plainly.
- **Conflicts** keep the local file untouched and upload it beside the remote one, named with
  `meshExtname`'s longest-suffix split so `case.post.msh` stays routable. The remote's current
  revision is then adopted as the new baseline, or every subsequent tick would conflict forever.
- **`cad-preview-macros.json` is never synced** — it is a per-*folder* library while the cache is
  per-*file*, so uploading it would let two models from one remote folder overwrite each other's.
- **Quit.** `will-quit` cannot await an HTTPS upload, so `before-quit` calls `preventDefault()`
  **once** (guarded by a flag, so it can never loop), drains for up to 10 s, then re-quits.
  Anything still unsent stays `dirty: true` in the manifest and is reported on the next launch.
  `will-quit` only calls `cloud.flushSync()`, the manifest `JsonStore`'s last synchronous write.
- **OAuth is bring-your-own-client.** No KKSS client id is baked in. `oauth.ts` reuses
  `metaServer.ts`'s listen/error/Host-check shape for a one-shot `127.0.0.1` listener, with PKCE
  S256 and a `state` check; tokens go through `chat/secrets.ts`. Dropbox pins port 53682 because
  its console requires an exact redirect URI; Google and Microsoft take an ephemeral one.
- **Uploads take a simple path below ~4 MB** (Drive `uploadType=media`/`multipart`, Graph
  `PUT .../content`, Dropbox `files/upload`) and a chunked one above it. That is not only about
  cost — a sidecar is a couple of KB and a session would be three round trips for nothing —
  neither Drive nor Graph can finalise a *zero-byte* resumable session, so `uploadChunked` rejects
  `size === 0` outright rather than spinning on a chunk it can never produce.
- **No new dependencies.** All three providers are plain REST over `net.fetch`, `node:crypto`,
  `node:http` and `node:stream`, plus the `chokidar` KKSS already ships. The official SDKs are
  license-compatible but each drags a large tree into `out/main.js` for three endpoints.

#### Verifying a provider by hand

The consent round trip, the live endpoint shapes and resumable uploads cannot be unit-tested — they
need a real registration. Per provider, once per release that touches this area:

1. Register a desktop/installed-app OAuth client (see [Configuration ▸ Cloud accounts](/guide/configuration#cloud-accounts) for redirect URIs and scopes) and paste the client ID under **Settings ▸ Cloud Accounts**.
2. **Connect…** — the browser opens, consent returns to the loopback listener, and the status row shows the account.
3. **File ▸ Open from Cloud…** → open a `.stp`. Confirm the tab shows ☁ and the model renders.
4. Edit something, wait ~5 s, and confirm the sidecars appear beside the model remotely.
5. Change the file from the provider's web UI, edit locally again, and confirm a `(conflict …)` copy appears and the local file is untouched.
6. Upload something over 4 MB (Graph) / 150 MB (Dropbox) to exercise the chunked path.
7. Quit mid-upload and confirm the next launch reports the unsynced file.

## Settings menu

The **Settings** native menu (`app/main/menu.ts`) holds app-level preferences persisted in `app/main/services/stateStore.ts`: **Color Theme** (`sceneTheme` — the same key the mesh viewer's own theme toggle persists; served to the mode views via their synchronous `initialState`, so it applies when a view next loads a file), **Terminal Shell** (`terminalShell`), and **LLM Assistant** (provider, API keys, models, base URL, and **Tool Approval** — see the chat sidebar section above; "Never ask" is confirmed once by dialog, and cancelling rebuilds the menu to put the radio back), **MCP Server** (enable/port/copy-address-&-token/ regenerate-token — the meta MCP server, see above), and **Cloud Accounts** (per provider: client ID, client secret, connect, disconnect; plus the shared cache size limit and Clear Cloud Cache — see the cloud staging layer above). Viewer-level actions are deliberately absent from the menu bar — the submodules' own toolbars provide them.

Key pieces (all under `app/`):

- **`app/preload/viewPreload.ts` + `app/renderer/view/shim.ts`** — the entire VS Code compatibility layer: `acquireVsCodeApi().postMessage` → IPC, and inbound IPC → a normal window `message` event.
- **`app/main/vscodeShim.ts`** — a minimal `vscode` module. Its `workspace.workspaceFolders` is a **getter** backed by the *explicit* project folder (via the `__configureVscodeShim` hooks object): that is what makes `ptController.discoverExternal()` scan `<root>/.kratos/problemtypes`, so a project-local problemtype appears in the Problemtype list — impossible while this was permanently `undefined`. Explicit-only is a safety decision, not a style one: `discoverExternal` *executes* what it finds (sandboxed in a `node:vm` with no `require`/`process`/`fs`, no codegen and a 2 s timeout), so merely opening a mesh that happens to sit beside a `.kratos/problemtypes/` must never run it. Python problemtypes stay unavailable in KKSS (pyodide is not copied into `out/`) and surface as a per-file error row rather than a crash. The rest of the shim (dialogs, messages, file watcher, progress, `openWith`, `getConfiguration` — resolving to the caller's default for every key except `kratos.preview.summaryThresholdMb`, which Settings makes user-settable, since KKSS otherwise has no settings.json equivalent — `openTextDocument`/`showTextDocument` routed to the app's own text-editor screen, and `env.asExternalUri` as an identity passthrough since there is no Remote-SSH/Codespaces tunnel) that esbuild aliases in place of the real API, letting `mesh/src/{mdpaEditorProvider,vtkEditorProvider,meshExport, opHistory,flowgraphController,ptController,runManager,recentMeshes,previewHtml,meshDocument}.ts` run verbatim.

mesh 3.18.0 made both preview providers full `vscode.CustomEditorProvider`s (were `CustomReadonlyEditorProvider`): applying an operation now marks the document dirty, and only `vscode.workspace.save(uri)` clears it. `app/main/mesh/meshHost.ts`'s `resolveProviderFor` mints the document from the provider's own `openCustomDocument(uri, {backupId: undefined, ...}, token)` rather than a bare stand-in (`resolveCustomEditor` unconditionally reads `document.takeRestoredOps()`), keeps it (and the provider that minted it) alongside its panel, and the shim's fifth hook, `saveMesh(fsPath)`, is what `workspace.save` calls into — it finds the `MeshHost` whose document owns the uri and calls its `saveDocument()`, which calls `saveCustomDocument` on that exact document. `MeshHost.isDirty()`/the `onDidChangeCustomDocument` subscription back the tab strip's dirty dot and `index.ts`'s close/quit prompts (`confirmDiscardMeshTab`, mirroring `EditorService.confirmClose`'s dialog shape). Three modules are deliberately left *unreachable* rather than shimmed — `runTreeView.ts`, `sidebarViews.ts` and `emptyPreview.ts`, each constructed only from the submodule's own `activate()`, which KKSS never calls — which is what keeps `createTreeView`/`TreeItem`/`registerCommand`/`createWebviewPanel` out of both the bundle and the shim.
- **`app/main/cadHost.ts`** — a 1:1 port of `cad/src/provider.ts`'s editor session (the cad provider imports OCCT directly, which must live in a worker here, so the cad side is ported rather than shimmed). Its `readOcctSource` is the single choke point every OCCT path reads through, so a `.scad` is converted to `.csg` by the user-installed `openscad` binary once and nothing downstream ever sees format `"scad"`. Deliberately *not* ported: SpaceMouse (it needs `node-hid`, a second native module — see the node-pty section) and the Models activity-bar view (a VS Code TreeView with no KKSS analogue); nor the provider's `getHtml`/`getNonce` (KKSS generates its page with `tools/gen-webview-html.mjs`, whose CSP allow-lists the `kkss:` scheme instead of a nonce) and its `registerCommands` (KKSS's command surface is `app/main/menu.ts`, and its What's New lives in `app/main/services/whatsNew.ts`). Its `CadHostHooks.onMeshExported` fires after a meshing-panel export writes a file; `app/main/index.ts` wires it to `openFile(path, "mesh")` (gated by `modeForFile`) so a mesh exported in pre mode that post mode can display (`.mdpa`, `.vtk`, …) opens straight into the mesh view — a one-way pre → post sync.
- **`app/main/services/jsonStore.ts`** — the Electron-free half of `stateStore.ts` (the same split as `chat/secretCodec.ts` under `chat/secrets.ts`, and unit-tested by `test/stateStore.test.ts`). It is instantiated **per file** — `state.json` plus one instance per chat conversation and one for their index — so each file gets its own writer chain and `will-quit` flushes each of them. Every write goes through **`app/main/services/atomicWrite.ts`** — a sibling temp file, fsynced, then renamed over the target (atomic on POSIX and NTFS) — behind a single-writer chain, so concurrent `update()` calls cannot interleave or tear the file. This is not incidental: the LLM API key and the MCP meta-server's bearer token live in that same `state.json`, so one torn write used to lose every setting *and* both credentials at once, after which the store's silent corrupt-file fallback booted the app looking factory-fresh. A write that is still queued absorbs later mutations rather than making them wait, which is what the many fire-and-forget `void stateStore.update(...)` callers (every Settings menu click, the zoom picker, the mesh Memento) want. `will-quit` cannot await, so it calls `flushSync()` — an in-flight async write can only resume after that returns, and re-checks a stopped flag before its own rename, so it can never land a stale snapshot on top.
- **`app/main/services/atomicWrite.ts`** (tested by `test/atomicWrite.test.ts`) — the temp-file + fsync + rename primitive, extracted from `jsonStore.ts` so cadHost's eight sidecar writers get the same guarantee. It also **serializes writes per resolved path**, which is not optional once a temp name is involved: two overlapping writes to one path would share `<file>.<pid>.tmp` and the second `rename` would fail with ENOENT. Two such overlaps exist in `cadHost.ts` — `flushSidecars()` clears the six debounce timers but cannot cancel one that has *already fired*, and `cad-preview-macros.json` is a per-*folder* library that two tabs on models in one directory both write. The sync variant deliberately skips the fsync and the Windows rename retry (it runs on the quit path, where being fast matters more than being durable) and uses a distinct `.sync.tmp` name — it bypasses the chain, so sharing the async temp name would let a write that is mid-`open()` end up holding a handle to the file the sync write has just renamed into place. Sidecar suffixes live in `app/main/services/sidecarSuffixes.ts`, imported by both `cadHost.ts` and the cloud layer so the two lists cannot drift.
- **`app/main/services/recentFiles.ts`** (+ the pure `recentFilesCore.ts`, tested by `test/recentFiles.test.ts`) — the app-wide recents list, covering both modes. Recorded at exactly one choke point, `openFile()`, which is why every user-facing open routes through that function; the three `host.openPath()` callers that bypass it (crash replay, `openLatestResults`, `onMeshExported`) and session restore deliberately record nothing. De-duplication is by path with the mode refreshed, so a format both modes can read is one row that remembers where it was last opened. An entry carrying a `cloud` ref is **exempt from the existence prune**: its local copy is a staging copy the cache may have evicted, while the remote file is still there, so the row survives and clicking it re-downloads. The mesh submodule's own `RecentMeshStore` keeps running — both providers require it — but no longer drives any UI. `recentKey`/`recentLabel`/`recentDescription` are reused from `mesh/src/recentMeshesCore.ts`, which is vscode-free; its `recordRecent`/`parseRecentList` are not, because they would silently drop the `mode` field.
- **`app/main/services/projectRoot.ts`** (+ the pure `projectRootCore.ts`, tested by `test/projectRoot.test.ts`) — the project folder. Two levels: **explicit** (chosen via File ▸ Open Folder…, persisted under `projectRoot`) and **effective** (explicit, else the focused document's directory). Consumers use `effective()`, so with no explicit root every one of them behaves exactly as it did before the concept existed. Only `explicit()` is ever *displayed* or handed to the shim — an inferred root would change with the focused tab, and would put a developer's absolute path into the committed docs screenshots. A stored root that has been deleted or unmounted degrades to "none" on read but is deliberately not erased. `describeWithin()` is what makes Open Recent read as "this project": entries inside the root show their folder relative to it, everything else keeps the `~`-abbreviated form — no re-sectioning, which would fight the list's newest-first order.
- **`app/main/services/session.ts`** (+ the pure `sessionCore.ts`, tested by `test/session.test.ts`) — session restore. Persists each mode's open documents in tab order plus the focused *path* (tab ids are a per-process counter, and an index shifts when pruning drops an earlier file), the screen, and panel visibility. Captured debounced from `syncTabs()`/`setScreen()`/the panel toggles — so a SIGKILL still leaves a usable session — and once more on `will-quit` **before** `stateStore.flushSync()`, since that call stops the store and would swallow a later write. Restoring prunes vanished paths *first*, opens each file with `openPath()` (append, no re-routing, no recording), closes the blank starter tab, then restores screen and panels. Gated by `KKSS_E2E`, `KKSS_NO_RESTORE=1`, and **Settings ▸ Restore Last Session**.
- **`kkss://` and `kkss-file://`** schemes — replacements for `asWebviewUri`/`localResourceRoots` (app assets and allow-listed user files respectively).
- **`app/main/cadCompute.worker.ts` / `cadComputeClient.ts`** — the RPC boundary for everything WASM-backed on the cad side. The worker spreads five submodule modules into one method map (`occtService`, `gmshService`, `massProperties`, `entityFacts`, `meshioService`, plus `meshioRegionParts`, which is CPU-only but pulls in Three.js); the client re-exposes each with the submodule's own signature via `Parameters<typeof …>`, so a changed signature is a type error rather than a runtime surprise. Pure text helpers (`stepUnits`/`igesUnits` unit detection) stay in the main process — a worker round trip would buy nothing.
- **`app/main/cadBRepCache.ts`** — cad 1.2.6's `loadBRepCached` reuses a parsed base shape across interactive edits, but the cache entry it hands back owns live OCCT handles and can never be structured-cloned. So the entry lives in the worker beside the OCCT singleton that owns it, and only the plain `BRepResult` crosses the RPC. Entries are keyed by a stable per-tab session id, so every open cad tab gets its own slot; `releaseBRepCache` is the counterpart of the provider's `onDidDispose` teardown and is called from `CadHost.disposeSession`. On a thrown load the entry is dropped, never disposed — `loadBRepCached`'s own contract, since a WASM abort may have left it half-torn-down.
- **`app/main/cadMeshioLoader.ts`** — esbuild aliases it in place of `@meshioplusplus/wasm` in the cad worker. `cad/src/meshioService.ts` loads meshio++ with a bare `await import(...)` and no directory fallback (unlike mesh's own loader, which ends at `__dirname/meshio`), which would be `ERR_MODULE_NOT_FOUND` in a packaged install where KKSS ships no `node_modules`. The shim resolves the copied `out/meshio/` tree and passes a name-aware `locateFile`. It must not use `require.resolve("@meshioplusplus/wasm/package.json")` — the alias catches that subpath too, and esbuild would try to resolve it against the shim file itself.
- **`tools/gen-webview-html.mjs`** (→ `tools/webviewMarkup.ts`) — builds each mode's HTML page from the submodules' own markup modules (`viewerDom.ts`, `webviewChrome.ts`) at build time, so the DOM always matches what the extensions expect. The mesh page must mirror `webviewChrome.buildPreviewHtml`'s body element for element (since mesh 3.15.0 that one function is the skeleton both editor providers and the standalone empty panel share, via `previewHtml.ts`; it can't simply be called, because KKSS links two extra stylesheets and must load `shim.js` before the bundle), and links three stylesheets in order: the submodule's `design-system.css` (the `--ds-*` token layer `style.css` builds on), `style.css`, then `app/renderer/theme/mesh-overrides.css`.
- **`app/renderer/theme/mesh-overrides.css`** — KKSS-only overrides for the mesh webview. It currently hides `#menubar`: mesh 3.0.0 put the viewer's File menu and scene-theme picker in an in-flow strip, both of which the native menu already owns. The markup is still emitted (`webview/main.ts` looks those nodes up by id), so anything reachable *only* from that strip — Save/Load Problem — needs a native menu entry. Note the converse: mesh 3.14.4's **Edges** toggle lives in the visible `View ▾` popup, not the strip, so it deliberately has no native entry (and no host message that could drive one).
- **`app/renderer/theme/vscode-vars.css`** — the `--vscode-*` theme variables VS Code normally injects; `tools/check-theme-vars.mjs` fails the build if a submodule update uses one that is missing, and likewise for a `--ds-*` token `style.css` uses but `design-system.css` doesn't define.

## Building from source

```bash
git clone --recurse-submodules https://github.com/loumalouomega/KKSS.git
cd KKSS
npm ci
npm run submodules:install   # npm ci in cad/ and mesh/
npm run build                # submodule bundles → app bundles → HTML gen → theme guard
npm start                    # build + launch
npm run dist                 # package installers into release/
```

Day-to-day:

```bash
npm run build:app   # skip the submodule rebuild when only app/ changed
npm run typecheck
npm test            # vitest glue tests (test/)
npm run smoke       # headless end-to-end smoke test (needs xvfb on Linux)
```

### Dependency security pins

Only `node-pty` is a runtime dependency, but that understates the shipped
surface: esbuild **bundles** several devDependencies into `out/main.js`
(`@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `electron-updater`,
`semver`, and everything they pull in). A "dev-only" advisory on one of those
transitives is therefore a real advisory against the packaged app, so check
where a flagged package actually lands before dismissing it:

```bash
npm ls <package> --all      # who requires it
grep -c "<package>" out/main.js   # does it reach the bundle?
```

When an upstream range still admits a vulnerable version, pin it in the root
`package.json`'s `overrides` block (the `cad/` and `mesh/` submodules keep
equivalent pins for their own trees) and drop the entry once upstream's own
range excludes the bad versions. Current pins — `fast-uri` and
`@hono/node-server`, both reaching the bundle through
`@modelcontextprotocol/sdk` (via `ajv` and the SDK's `streamableHttp.js`
transport respectively). Advisories that resolve only inside the
**electron-builder** toolchain (`brace-expansion`, `minimatch`, `tar`) are
build-time only — they never enter `out/`, and GitHub's Dependabot
auto-dismisses them; do not force-resolve them, since the requested majors
differ across that tree and a blanket override breaks packaging.

## Regenerating documentation screenshots

Screenshots are **generated, not hand-captured** — the same philosophy as the cad submodule's `scripts/screenshots/` pipeline, but even more end-to-end: `tools/screenshots.mjs` launches the real Electron app (Playwright-Electron) on real example files from the submodules and captures the live windows at 2x pixel density.

```bash
npm run build                          # once, so out/ is complete
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run docs:screenshots   # headless Linux
```

PNGs land in `doc/public/screenshots/` (committed, kebab-case) and the two README heroes are refreshed in `images/`. Any change to the shell toolbar, the generated webview pages, or visible viewer behavior means re-running this — don't hand-edit the PNGs.

## Icons

`icons/` holds TikZ-drawn icon sources, mirroring the submodules' pipeline (`pdflatex` + `pdftocairo` required — see `icons/README.md`):

- `tikz-ui/*.tex` → `svg-ui/*.svg` → the generated (and committed) `app/renderer/shell/shellIcons.ts` — monochrome `currentColor` shell toolbar icons, tinted by the surrounding element's color.
- `tikz-app/kkss.tex` → `icons/app/icon{,-256,-1024}.png` — the colored "split cube" application icon consumed by `electron-builder.yml` and the Linux window icon (`out/icon.png`).

Regenerate everything with `npm run build:icons` and commit the sources together with the regenerated artifacts.

## Updating the submodules

Upstream improvements are inherited by bumping the submodule pointer:

```bash
git submodule update --remote cad    # or mesh
npm run build                        # rebuilds the bundle + re-runs check-theme-vars
npm test && npm run smoke            # protocol drift shows up here
git add cad && git commit -m "Bump cad submodule"
```

The typecheck imports the extensions' protocol types and the build re-greps their stylesheets, so a breaking protocol or theming change fails loudly rather than silently misbehaving.

If a change **inside** a submodule is ever unavoidable, commit it to a dedicated branch in that submodule (e.g. `application-downstream`) and point the KKSS gitlink there — never to the submodule's default branch.

## Releasing

Tag and push: `git tag v0.2.0 && git push --tags`. The release workflow builds Windows/macOS/Linux installers and attaches them to a GitHub Release; tags containing a hyphen (`v0.2.0-rc1`) are marked as prereleases.
