# Architecture & Building

## The shim architecture

KKSS reuses the two VS Code extensions **without modifying them**. Both are already split into a browser-side webview bundle (whose only VS Code touchpoint is `acquireVsCodeApi()`), vscode-free compute/parser modules, and a thin vscode-coupled glue layer. KKSS replaces only the glue:

```
┌────────────────────────── BaseWindow ──────────────────────────┐
│ shell toolbar (Home · mode toggle · Open · title · toasts)     │
├────────────────────────────────────────────────────────────────┤
│ cad view                        │ mesh view                    │
│ cad/media/viewer.js (unmodified)│ mesh/media/webview.js (unmod)│
│ + acquireVsCodeApi shim         │ + acquireVsCodeApi shim      │
└───────────────▲─────────────────┴──────────────▲───────────────┘
                │ IPC = the extensions' own message protocols     │
┌───────────────▼──────────────────────────────────▼─────────────┐
│ Electron main                                                  │
│  cadHost.ts — port of cad/src/provider.ts                      │
│    OCCT + Gmsh WASM → worker thread (cadCompute.worker.ts)     │
│  meshHost.ts — runs the REAL Mdpa/VtkEditorProvider classes    │
│    behind a `vscode` shim module + a fake WebviewPanel         │
│    MMG → the submodule's own worker pair, unchanged            │
└────────────────────────────────────────────────────────────────┘
```

A fourth, full-window `WebContentsView` — the **home screen** (`app/renderer/home/`) — is stacked on top and shown on launch (and via the toolbar's Home button, `Ctrl+0`, or **View ▸ Home**). It covers the shell and both mode views; entering a mode hides it. Screens are tracked as `Screen = "home" | Mode` in `app/main/ipc.ts` and switched with `MainWindow.setScreen()` (`app/main/windows.ts`) — mode views are only ever `setVisible()`-toggled, so their state survives trips through the home screen. The home menu's buttons are config-driven: add an entry to `app/renderer/home/homeConfig.ts`, a `HomeAction` case in `app/main/ipc.ts`, and its handler in `app/main/index.ts` (`home:toHost`/`home:toWebview` channels via `app/preload/homePreload.ts`, same contextBridge pattern as the shell).

**Interface scale.** The shell toolbar's scale picker (and **View ▸ Zoom In / Zoom Out / Reset Zoom**, `Ctrl +`/`Ctrl -`/`Ctrl+Shift+0`) sets a single zoom factor via `MainWindow.setZoom()` (`app/main/windows.ts`). `setZoomFactor` scales each `WebContentsView`'s *content* but not its bounds, so `layout()` multiplies the fixed chrome constants (`SHELL_HEIGHT`, `TERMINAL_HEIGHT`, `CHAT_WIDTH`) by the factor in lockstep — otherwise the scaled toolbar would clip. Electron resets a view's zoom to 1 on every navigation, so each view re-asserts the factor on `did-finish-load` (the mode views reload on file open). The picker round-trips over the shell channel (`ShellToHost.setZoom` / `ShellToWebview.zoom`), and `app/main/index.ts` persists it under the `uiZoom` stateStore key and re-applies it on the next launch (passed into `createMainWindow`). Presets live in `ZOOM_PRESETS` — the shell renderer mirrors the same list to build the dropdown.

### Flowgraph embedding

The mesh submodule's **Flowgraph** problemtype (`view: "flowgraph"`) splits the MDPA preview's viewport to embed the AGPL-3.0 [`@kratos-flowgraph/flowgraph`](https://www.npmjs.com/package/@kratos-flowgraph/flowgraph) node editor in an `<iframe>`, served by a small Express+EJS app the submodule forks on demand (`mesh/src/flowgraphServer.ts`, `mesh/src/ flowgraphController.ts`). `meshHost.ts` owns the shared, ref-counted `FlowgraphController` instance — mirroring `mesh/src/extension.ts`'s `activate()` — passing it into `new MdpaEditorProvider(context, flowgraph)` (the VTK provider still takes only `context`; it ships the same pane markup inertly for chrome parity) and disposing it on Electron's `will-quit` so the forked child process never outlives the app.

**Path contract**: like the MMG worker pair, `flowgraphController.ts` resolves its server and assets via `__dirname`, so `esbuild.mjs`'s `copyArtifacts()` places `out/flowgraphServer.js` and the `out/flowgraph/` asset tree (copied from `mesh/dist/flowgraph/` — Flowgraph's `public/`+ `views/`, its `LICENSE`, and our `vscode-bridge.js`) directly beside `out/main.js`.

### Extended mesh formats (meshio++)

The mesh submodule reads ~29 (writes ~26) mesh formats it has no native parser for (Gmsh, Abaqus, Nastran, I-deas UNV, Medit, Netgen, SU2, XDMF, COMSOL, tetgen, …) through [`@meshioplusplus/wasm`](https://www.npmjs.com/package/@meshioplusplus/wasm) (6.1.0) — meshio++'s C++ core compiled to WebAssembly. meshio++ 6.1.0 adds the field-only `.dex`/`.ip`/`.mff` formats: they carry point fields with no cell geometry, so writing one keeps the points plus a field and drops connectivity, and reading one yields a point cloud (or an empty mesh). It is ESM-only (its Emscripten glue reads `import.meta.url`), so the submodule keeps it `external` and ships it verbatim as the `mesh/dist/meshio/` tree, and `mesh/src/parser/meshio.ts` loads it through a runtime dynamic `import()` rather than a bundled require.

**Path contract**: `meshio.ts`'s `packageDir()` falls back to `path.join(__dirname, "meshio")`, and `meshio.ts` is bundled into **both** `out/main.js` (mesh host → `meshFileParser`/`meshWriter`) and `out/mcpServer.js` — both with `__dirname === out/`. So `copyArtifacts()` mirrors `mesh/dist/meshio/` to a single `out/meshio/` tree beside `out/main.js`, serving the app host and the MCP server at once. The `.wasm` is loaded via meshio++'s `locateFile` hook (the `wasmBinary` buffer hook MMG uses is unavailable in this build), which is why `out/` stays unpacked (`asar: false`). `@meshioplusplus/wasm` is also added to the parent `mainConfig.external` in `esbuild.mjs`, because the bundled `meshio.ts` contains a `require.resolve("@meshioplusplus/wasm/package.json")` literal esbuild would otherwise try to resolve at build time.

### About dialog & updates

**Help ▸ About KKSS…** (and the home screen's Help button) opens a frameless singleton window (`app/main/services/about.ts`, same pattern as the modal picker) backed by `app/renderer/about/` over `about:init` / `about:toHost` / `about:toWebview` (`app/preload/aboutPreload.ts`). It shows the version (`app.getVersion()`), the author (injected from `package.json` by an esbuild `define`), and an update check.

Update flow (`app/main/services/updates.ts`):

- **Availability** — the GitHub REST API (`releases/latest`) + a `semver` compare; works in dev runs too. Offline / rate-limited / bad tags degrade to a "Couldn't check for updates" line with Retry — never a crash.
- **Delivery** — `electron-updater` (GitHub provider), only where the app can self-replace: the Windows NSIS install and the Linux AppImage. `.deb` installs and the (unsigned) macOS builds get an "Open releases page" button instead, as does any runtime updater failure.
- Both `semver` and `electron-updater` are devDependencies bundled into `out/main.js` by esbuild — the package still ships no `node_modules`.

The feed plumbing electron-updater needs: the `publish:` block in `electron-builder.yml` makes electron-builder emit `latest*.yml` into `release/` and embed `resources/app-update.yml` in each package (even with `--publish never`), and `.github/workflows/release.yml` uploads `release/latest*.yml` + `release/*.blockmap` so they land on the GitHub Release next to the installers. Remove either half and in-app updates stop finding releases.

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
| `cad-preview` (11 tools) | `out/cad-runtime/dist/mcp-server.js` | beside the OCCT/Gmsh WASM, so its `extensionPath` (= `dirname/..`) resolves to `out/cad-runtime` |
| `kratos-mdpa` (14 tools) | `out/mcpServer.js` | beside `out/mmg-core.wasm` (the bundle reads `__dirname/mmg-core.wasm`) and the `out/meshio/` tree (meshio++'s `__dirname/meshio` fallback, for the extended-format tools) |
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
- **`app/main/cadHost.ts`** — a 1:1 port of `cad/src/provider.ts` (the cad provider imports OCCT directly, which must live in a worker here, so the cad side is ported rather than shimmed). Its `CadHostHooks.onMeshExported` fires after a meshing-panel export writes a file; `app/main/index.ts` wires it to `openFile(path, "mesh")` (gated by `modeForFile`) so a mesh exported in pre mode that post mode can display (`.mdpa`, `.vtk`, …) opens straight into the mesh view — a one-way pre → post sync.
- **`kkss://` and `kkss-file://`** schemes — replacements for `asWebviewUri`/`localResourceRoots` (app assets and allow-listed user files respectively).
- **`tools/gen-webview-html.mjs`** — builds each mode's HTML page from the submodules' own markup modules (`viewerDom.ts`, `webviewChrome.ts`) at build time, so the DOM always matches what the extensions expect.
- **`app/renderer/theme/vscode-vars.css`** — the `--vscode-*` theme variables VS Code normally injects; `tools/check-theme-vars.mjs` fails the build if a submodule update uses one that is missing.

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
