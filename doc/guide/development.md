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

A fourth, full-window `WebContentsView` — the **home screen** (`app/renderer/home/`) — is stacked on top and shown on launch (and via the toolbar's Home button, `Ctrl+0`, or **View ▸ Home**). It covers the shell and every mode tab; entering a mode hides it. Screens are tracked as `Screen = "home" | "editor" | Mode` in `app/main/ipc.ts` and switched with `MainWindow.setScreen()` (`app/main/windows.ts`). Each mode screen can hold several open documents ("tabs") — `MainWindow.openTab()`/`closeTab()`/`setActiveTab()` manage a `Tab {id, view}` registry per mode, one full `WebContentsView` per tab (the same lazy-create + `setVisible()` precedent as the terminal/chat panels, just N-of-a-kind); only the focused tab of the active mode is ever visible/bounded, so switching tabs or trips through the home screen never reload or lose a tab's camera/edit-history state. `app/main/index.ts`'s `createTab(mode)` builds a tab's view and its `CadHost`/`MeshHost` together; `activeCadHost()`/`activeMeshHost()` resolve whichever tab is currently focused for callers (the native menu, the terminal's cwd, the chat context) that only ever need "the current one." The tab strip is plain DOM inside the `shell` page (`app/renderer/shell/shell.ts`), synced wholesale via a `{type:"tabs", mode, tabs, activeTabId}` message on every open/close/focus/title change — see `CLAUDE.md`'s tabs invariant for the full model, including the two genuinely-shared pieces of state (`cadBRepCache.ts`'s session-keyed worker cache and mesh's ref-counted `FlowgraphController`). The home menu's buttons are config-driven: add an entry to `app/renderer/home/homeConfig.ts`, a `HomeAction` case in `app/main/ipc.ts`, and its handler in `app/main/index.ts` (`home:toHost`/`home:toWebview` channels via `app/preload/homePreload.ts`, same contextBridge pattern as the shell).

**Interface scale.** The shell toolbar's scale picker (and **View ▸ Zoom In / Zoom Out / Reset Zoom**, `Ctrl +`/`Ctrl -`/`Ctrl+Shift+0`) sets a single zoom factor via `MainWindow.setZoom()` (`app/main/windows.ts`). `setZoomFactor` scales each `WebContentsView`'s *content* but not its bounds, so `layout()` multiplies the fixed chrome constants (`SHELL_HEIGHT`, `TAB_STRIP_HEIGHT`, `TERMINAL_HEIGHT`, `CHAT_WIDTH`) by the factor in lockstep — otherwise the scaled toolbar would clip. `TAB_STRIP_HEIGHT` is only ever added while a mode screen (which actually has tabs) is active. Electron resets a view's zoom to 1 on every navigation, so each tab's view re-asserts the factor on `did-finish-load` (a tab reloads when a file opens into it). The picker round-trips over the shell channel (`ShellToHost.setZoom` / `ShellToWebview.zoom`), and `app/main/index.ts` persists it under the `uiZoom` stateStore key and re-applies it on the next launch (passed into `createMainWindow`). Presets live in `ZOOM_PRESETS` — the shell renderer mirrors the same list to build the dropdown.

### Flowgraph embedding

The mesh submodule's **Flowgraph** problemtype (`view: "flowgraph"`) splits the MDPA preview's viewport to embed the AGPL-3.0 [`@kratos-flowgraph/flowgraph`](https://www.npmjs.com/package/@kratos-flowgraph/flowgraph) node editor in an `<iframe>`, served by a small Express+EJS app the submodule forks on demand (`mesh/src/flowgraphServer.ts`, `mesh/src/ flowgraphController.ts`). `meshHost.ts` owns the shared, ref-counted `FlowgraphController` instance — mirroring `mesh/src/extension.ts`'s `activate()` — passing it into `new MdpaEditorProvider(context, flowgraph)` (the VTK provider still takes only `context`; it ships the same pane markup inertly for chrome parity) and disposing it on Electron's `will-quit` so the forked child process never outlives the app.

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

Tools come from three stdio MCP servers managed by `app/main/services/chat/mcpManager.ts` (spawned lazily on first chat use, per-server failure tolerated, tool names namespaced `cad__*` / `mesh__*` / `kratos__*`):

| Server | Bundle / command | Placement contract |
| --- | --- | --- |
| `cad-preview` (44 tools) | `out/cad-runtime/dist/mcp-server.js` | beside the OCCT/Gmsh WASM, so its `extensionPath` (= `dirname/..`) resolves to `out/cad-runtime` |
| `kratos-mdpa` (21 tools) | `out/mcpServer.js` | beside `out/mmg-core.wasm` (the bundle reads `__dirname/mmg-core.wasm`) and the `out/meshio/` tree (meshio++'s `__dirname/meshio` fallback, for the extended-format tools) |
| `kratos-mcp-server` (40 tools) | `uvx kratos-mcp-server@<version>` | pinned to `KRATOS_MCP_VERSION`; marked *unavailable* if `uv` is missing; chat continues without it |

The kratos server is **pinned** to `KRATOS_MCP_VERSION` (`mcpManager.ts`) — bump that constant to upgrade; the tool/resource/prompt surface is discovered at runtime (`listTools`), so no other code changes when it grows. Its 0.3.0 knowledge layer also ships MCP **resources** (worked examples) and **prompts** (guided setups); `McpManager` aggregates both (`listResources`/`readResource`/`listPrompts`/ `getPrompt`, resource URIs owner-mapped, prompt names namespaced). The provider loop only understands tools, so these are surfaced to the chat as four synthetic `mcp__*` tools (`chatTools()` = real tools + `mcp__list_resources` / `mcp__read_resource` / `mcp__list_prompts` / `mcp__get_prompt`).

The two Node bundles are spawned with **Electron's own binary + `ELECTRON_RUN_AS_NODE=1`** (packaged machines have no system Node), and the full parent environment is always passed to `StdioClientTransport` — the SDK otherwise strips env to a minimal set, which silently breaks `uvx` (PATH). The bundles are copied from the submodules' `dist/` by `esbuild.mjs`'s `copyArtifacts()` — which also mirrors the `out/meshio/` tree beside `out/mcpServer.js` so the `mesh_convert`/`mesh_info` tools can read/write the extended meshio++ formats (see *Extended mesh formats* above); the submodules themselves are unmodified (the MCP servers are built by their normal `build`/`package` scripts on the `kkss.dev` branch).

API keys are entered via **Settings ▸ LLM Assistant** (`showInputBox` modals) and stored in the stateStore encrypted with Electron `safeStorage` (`app/main/services/chat/secrets.ts`; plaintext fallback when the OS has no keyring). Settings are read per request — no restart needed. stateStore keys: `llmProvider`, `llmModelAnthropic`, `llmKeyAnthropic`, `llmModelOpenai`, `llmKeyOpenai`, `llmOpenaiBaseUrl`.

### Meta MCP server (expose the toolset over HTTP)

The same aggregated toolset can be re-exposed as a single MCP **server** so an *external* LLM client (Claude Desktop, another agent) drives KKSS — the inverse of the sidebar (which makes KKSS an MCP client). One `McpManager` is shared between both front-ends via **`McpHub`** (`app/main/services/chat/mcpHub.ts`), constructed once in `index.ts` and disposed on `will-quit`; whichever of {chat opened, external client connected} happens first spawns the three children, the other reuses them — never a double spawn.

`app/main/services/metaServer/` holds the server: `buildServer.ts` wires `McpManager` behind the low-level MCP `Server` (raw JSON-Schema tools forwarded verbatim via `callToolRaw`, resources & prompts re-exposed natively), and `metaServer.ts` (`MetaMcpServer`) runs a bare `http.createServer` bound to `127.0.0.1` with the SDK's `StreamableHTTPServerTransport` (stateful sessions keyed by `Mcp-Session-Id`; late server readiness emits `list_changed`). It is **off by default**, requires an `Authorization: Bearer <token>` (generated on first enable, safeStorage-encrypted like the API keys), and validates the `Host` header — these tools touch the filesystem and run simulations. The SDK server subpaths bundle into `out/main.js`; nothing new ships in `node_modules`. Enable it and copy the `http://127.0.0.1:<port>/mcp` address + token from **Settings ▸ MCP Server**. stateStore keys: `metaServerEnabled`, `metaServerPort` (default `7391`); secret: `metaServerToken`.

## Settings menu

The **Settings** native menu (`app/main/menu.ts`) holds app-level preferences persisted in `app/main/services/stateStore.ts`: **Color Theme** (`sceneTheme` — the same key the mesh viewer's own theme toggle persists; served to the mode views via their synchronous `initialState`, so it applies when a view next loads a file), **Terminal Shell** (`terminalShell`), and **LLM Assistant** (provider, API keys, models, base URL — see the chat sidebar section above), and **MCP Server** (enable/port/copy-address-&-token/ regenerate-token — the meta MCP server, see above). Viewer-level actions are deliberately absent from the menu bar — the submodules' own toolbars provide them.

Key pieces (all under `app/`):

- **`app/preload/viewPreload.ts` + `app/renderer/view/shim.ts`** — the entire VS Code compatibility layer: `acquireVsCodeApi().postMessage` → IPC, and inbound IPC → a normal window `message` event.
- **`app/main/vscodeShim.ts`** — a minimal `vscode` module (dialogs, messages, file watcher, progress, `openWith`, `getConfiguration` — always resolving to the caller's default, since KKSS has no settings.json equivalent — `openTextDocument`/`showTextDocument` routed to the app's own text-editor screen, and `env.asExternalUri` as an identity passthrough since there is no Remote-SSH/Codespaces tunnel) that esbuild aliases in place of the real API, letting `mesh/src/{mdpaEditorProvider,vtkEditorProvider,meshExport, opHistory,flowgraphController,ptController}.ts` run verbatim.
- **`app/main/cadHost.ts`** — a 1:1 port of `cad/src/provider.ts`'s editor session (the cad provider imports OCCT directly, which must live in a worker here, so the cad side is ported rather than shimmed). Deliberately *not* ported: the provider's `getHtml`/`getNonce` (KKSS generates its page with `tools/gen-webview-html.mjs`, whose CSP allow-lists the `kkss:` scheme instead of a nonce) and its `registerCommands` (KKSS's command surface is `app/main/menu.ts`, and its What's New lives in `app/main/services/whatsNew.ts`). Its `CadHostHooks.onMeshExported` fires after a meshing-panel export writes a file; `app/main/index.ts` wires it to `openFile(path, "mesh")` (gated by `modeForFile`) so a mesh exported in pre mode that post mode can display (`.mdpa`, `.vtk`, …) opens straight into the mesh view — a one-way pre → post sync.
- **`kkss://` and `kkss-file://`** schemes — replacements for `asWebviewUri`/`localResourceRoots` (app assets and allow-listed user files respectively).
- **`app/main/cadCompute.worker.ts` / `cadComputeClient.ts`** — the RPC boundary for everything WASM-backed on the cad side. The worker spreads five submodule modules into one method map (`occtService`, `gmshService`, `massProperties`, `entityFacts`, `meshioService`, plus `meshioRegionParts`, which is CPU-only but pulls in Three.js); the client re-exposes each with the submodule's own signature via `Parameters<typeof …>`, so a changed signature is a type error rather than a runtime surprise. Pure text helpers (`stepUnits`/`igesUnits` unit detection) stay in the main process — a worker round trip would buy nothing.
- **`app/main/cadBRepCache.ts`** — cad 1.2.6's `loadBRepCached` reuses a parsed base shape across interactive edits, but the cache entry it hands back owns live OCCT handles and can never be structured-cloned. So the entry lives in the worker beside the OCCT singleton that owns it, and only the plain `BRepResult` crosses the RPC. KKSS is one-document-per-mode, so one slot suffices; `releaseBRepCache` is the counterpart of the provider's `onDidDispose` teardown and is called from `CadHost.disposeSession`. On a thrown load the entry is dropped, never disposed — `loadBRepCached`'s own contract, since a WASM abort may have left it half-torn-down.
- **`app/main/cadMeshioLoader.ts`** — esbuild aliases it in place of `@meshioplusplus/wasm` in the cad worker. `cad/src/meshioService.ts` loads meshio++ with a bare `await import(...)` and no directory fallback (unlike mesh's own loader, which ends at `__dirname/meshio`), which would be `ERR_MODULE_NOT_FOUND` in a packaged install where KKSS ships no `node_modules`. The shim resolves the copied `out/meshio/` tree and passes a name-aware `locateFile`. It must not use `require.resolve("@meshioplusplus/wasm/package.json")` — the alias catches that subpath too, and esbuild would try to resolve it against the shim file itself.
- **`tools/gen-webview-html.mjs`** (→ `tools/webviewMarkup.ts`) — builds each mode's HTML page from the submodules' own markup modules (`viewerDom.ts`, `webviewChrome.ts`) at build time, so the DOM always matches what the extensions expect. The mesh page must mirror `mdpaEditorProvider.getHtml`'s body element for element, and links three stylesheets in order: the submodule's `design-system.css` (the `--ds-*` token layer `style.css` builds on), `style.css`, then `app/renderer/theme/mesh-overrides.css`.
- **`app/renderer/theme/mesh-overrides.css`** — KKSS-only overrides for the mesh webview. It currently hides `#menubar`: mesh 3.0.0 put the viewer's File menu and scene-theme picker in an in-flow strip, both of which the native menu already owns. The markup is still emitted (`webview/main.ts` looks those nodes up by id), so anything reachable *only* from that strip — Save/Load Problem — needs a native menu entry.
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
