# CLAUDE.md

Project memory for KKSS (Keep Kratos Simple Stupid) — an Electron desktop app
for pre- and post-processing Kratos Multiphysics simulations, built on two
VS Code extensions embedded as git submodules (`cad/` = CAD-Preview, `mesh/` =
VSCode-MDPA-Preview) and reused **without modification**.

## Commands

```bash
npm ci && npm run submodules:install   # first-time setup
npm run build          # submodule bundles → app bundles → HTML gen → theme guard
npm run build:app      # app only (skip submodule rebuild)
npm run watch          # rebuild app bundles on change
npm run typecheck      # tsc --noEmit (esbuild owns ALL emit — never tsc-emit)
npm test               # vitest glue tests in test/ (submodules run their own suites)
npm run smoke          # headless e2e (Linux: xvfb-run -a npm run smoke)
npm start              # full build + launch
npm run dist           # package installers into release/
npm run build:icons    # TikZ → SVG/PNG icons (needs pdflatex + pdftocairo)
npm run docs:screenshots  # regenerate doc screenshots from the live app (see below)
npm run docs:dev / docs:build  # VitePress site in doc/
```

Headless/CI gotchas: launch Electron with `env -u ELECTRON_RUN_AS_NODE` (that
variable is set in some dev environments and turns the binary into plain
Node), plus `--no-sandbox --enable-unsafe-swiftshader` under xvfb.

## Keep docs in sync

**Every time you change code in this repo, check whether `doc/`, `README.md`, and
this file need updating too — and update them if they do.** Treat doc drift as part
of the change, not a follow-up. Concretely:
- New/changed IPC channels, shim surface, or protocol handling (`app/main/ipc.ts`,
  `vscodeShim.ts`, `cadHost.ts`, `mesh/meshHost.ts`, preloads) → update
  `doc/guide/development.md`'s architecture section.
- New/changed file-format routing (`app/main/router.ts`) → update
  `doc/guide/file-formats.md` and the format tables in `README.md` /
  `doc/index.md` / `doc/guide/getting-started.md`.
- New/changed module, exported function, or architectural decision → update
  `doc/guide/development.md` and, for non-negotiable invariants or non-obvious
  gotchas, this file.
- New/changed toolbar buttons, menu items, or UI flows → update
  `doc/guide/getting-started.md`'s mode/shortcut tables — and re-run
  `npm run docs:screenshots` so the images match the UI.
If a change is purely internal refactoring with no observable behavior or API
difference, docs don't need to move — use judgment, but default to checking.

## Keep chat features in sync

**Every time a new feature is added to the app, update the AI chat sidebar so
the assistant can see and use it — part of the same change, not a follow-up.**
Concretely:
- New viewer/file capability (formats, edit ops, mesh operations…) → check the
  submodule MCP servers expose it. If they don't, that's upstream work on the
  submodule's `kkss.dev` branch (the zero-modification rule applies to the MCP
  servers too); bump the gitlink when it lands.
- New app-level ability, setting, or workflow → update the system prompt's
  capability description in `app/main/services/chat/chatService.ts`, the
  server wiring in `app/main/services/chat/mcpManager.ts` if a new tool source
  is involved, and the **Settings ▸ LLM Assistant** menu if it's configurable.
- New context the assistant should know (e.g. a new "current file" notion) →
  extend `ChatDeps.currentFiles()` / the context suffix — not the system
  prompt, which stays byte-stable for prompt caching.
- Plus the matching docs: `doc/guide/development.md`'s chat section and
  `doc/guide/getting-started.md`'s AI assistant section.

## Architecture (non-negotiable invariants)

- **Zero submodule modifications.** The app consumes the submodules' built
  webview bundles verbatim and imports their vscode-free modules. If a change
  inside `cad/` or `mesh/` is ever unavoidable, commit it to a dedicated
  branch in that submodule (e.g. `application-downstream`) and point the KKSS
  gitlink there — never to the submodule's default branch.
- **Asymmetric reuse — port vs shim.** `app/main/cadHost.ts` is a 1:1 *port*
  of `cad/src/provider.ts` (that provider imports OCCT directly, which must
  live in a worker here). The mesh providers run *verbatim*:
  `app/main/vscodeShim.ts` is aliased as the `vscode` module (esbuild alias,
  main bundle only) and `app/main/mesh/meshHost.ts` supplies a fake
  ExtensionContext + WebviewPanel. **If a mesh submodule update starts using a
  vscode API the shim lacks, extend the shim — never patch the submodule.**
  The shim throws loudly on unsupported commands by design.
- **Heavy WASM stays off the UI thread.** OCCT + Gmsh run in
  `app/main/cadCompute.worker.ts` (RPC via `cadComputeClient.ts`); MMG runs in
  the mesh submodule's own worker pair. Path contracts of the unmodified
  submodule code: `out/mmgWorker.js` + `out/mmg-core.wasm` must sit **beside
  `out/main.js`** (`__dirname` resolution in `mesh/src/mmgWorkerClient.ts`),
  and the OCCT/Gmsh binaries live under `out/cad-runtime/dist/` (the services
  take `extensionPath` and append `dist/…`). This is also why
  `electron-builder.yml` sets **`asar: false`**.
- **meshio++ (extended mesh formats) is a verbatim WASM tree, loaded in-process.**
  The mesh submodule reads/writes ~25 formats it has no native parser for (Gmsh,
  Abaqus, Nastran, UNV, Medit, Netgen, SU2, XDMF, tetgen, …) through the ESM-only
  `@meshioplusplus/wasm` package. Like pyodide/flowgraph it ships verbatim as
  `mesh/dist/meshio/`; `copyArtifacts()` mirrors it to a single **`out/meshio/`**
  tree beside `out/main.js` — `mesh/src/parser/meshio.ts`'s `packageDir()` falls
  back to `__dirname/meshio`, and since `meshio.ts` is bundled into **both**
  `out/main.js` and `out/mcpServer.js` (`__dirname === out/` for each) that one
  copy serves the mesh host and the MCP server. It loads the `.wasm` via meshio++'s
  `locateFile` hook (the `wasmBinary` buffer hook MMG uses is pruned from this
  build), so the tree must exist on disk — another reason for `asar: false`.
  `@meshioplusplus/wasm` (and `@meshioplusplus/wasm/*`) is in `mainConfig.external`
  in `esbuild.mjs`: the bundled `meshio.ts` has a
  `require.resolve("@meshioplusplus/wasm/package.json")` literal esbuild would
  otherwise resolve at build time. Not bundled → **never patch the submodule**;
  after a mesh bump, rerun `npm run package --prefix mesh` so `mesh/dist/meshio/`
  is regenerated before the parent build copies it.
- **Flowgraph embedding is a forked child process, not WASM.** The mesh
  submodule's Flowgraph problemtype embeds the AGPL-3.0
  `@kratos-flowgraph/flowgraph` node editor in an iframe backed by a small
  Express server the submodule forks on demand. `app/main/mesh/meshHost.ts`
  owns one shared `FlowgraphController` (mirroring `mesh/src/extension.ts`
  activate()), passes it to `new MdpaEditorProvider(context, flowgraph)` (the
  VTK provider takes only `context`), and disposes it on Electron's
  `will-quit` so the child process doesn't outlive the app. Same `__dirname`
  path-contract pattern as MMG: `out/flowgraphServer.js` and the
  `out/flowgraph/` asset tree (mesh's `dist/flowgraph/` — Flowgraph's
  `public/`+`views/`, its `LICENSE`, and our `vscode-bridge.js`) must sit
  beside `out/main.js`.
- **Custom schemes replace VS Code webview plumbing.** `kkss://app/...`
  serves out/ assets; `kkss-file://local/<enc>` serves user files from
  allow-listed roots only (`app/main/protocol.ts` — the `localResourceRoots`
  equivalent). cad's `loadUrl` strategy fetches `kkss-file:` URLs; the CSP in
  each generated page must keep allowing that (and `worker-src blob:` for
  vtk.js).
- **Webview HTML pages are build-generated — never hand-edit
  `out/renderer/*/index.html`.** `tools/gen-webview-html.mjs` assembles them
  from the submodules' own markup modules (`cad/src/viewerDom.ts`,
  `mesh/src/webviewChrome.ts` + `toolbarIcons.ts`), so the DOM always matches
  what the bundles expect. The shim script must load **before** the bundle.
- **Theme variables are guarded.** The submodule stylesheets consume
  `--vscode-*` variables; `app/renderer/theme/vscode-vars.css` defines them
  and `tools/check-theme-vars.mjs` fails the build if a submodule update uses
  one that is missing.
- **One document per mode** (v1): opening a file disposes the mode's session,
  reloads its view, and replays the extension's own `ready` handshake order.
  `.stl/.obj/.ply` are viewable in both modes — the active mode wins
  (`app/main/router.ts`). **Pre → post is one-way synced:** a mesh exported
  from CAD/pre that post mode can display (`.mdpa`, `.vtk`, …) auto-opens in the
  mesh view (`CadHost.onMeshExported` → `openFile(…, "mesh")` in
  `app/main/index.ts`, gated by `modeForFile` so shared/CAD-only outputs never
  jump). Post → pre is deliberately not synced.
- **node-pty is the ONLY native module and the ONLY shipped node_modules
  entry** (embedded terminal, `app/main/services/terminal.ts`). It is N-API:
  never add an electron-rebuild step — Windows/macOS use its npm-shipped
  prebuilds, Linux compiles during `npm ci` (keep its `allowScripts` entry in
  package.json or the binaries never materialize). It stays `external` in
  esbuild's mainConfig and ships via the node-pty `files` rules in
  electron-builder.yml. Release CI builds on one runner per OS/arch because
  of it. **Never add a `files` list under `win:`** — a per-platform files
  list is a second matcher over the same tree, electron-builder copies every
  matched file once per matcher, and on Windows the duplicate concurrent
  copies of the big OCCT WASM collide in EBUSY (see the comment in
  electron-builder.yml; linux/mac tolerate it, which is also what
  `USE_HARD_LINKS=false` in release.yml is about). Pages that need
  runtime-injected styles (terminal's xterm.js) may relax CSP to
  `style-src kkss: 'unsafe-inline'` — that page only.
- **Menu bar holds app-level items only.** Viewer actions (quality, fields,
  find entity…) live in the submodules' own toolbars — don't duplicate them
  in the native menu. App preferences go in the Settings menu, persisted via
  `stateStore` (`sceneTheme` is shared with the mesh viewer's own theme
  toggle; it reaches views through `initialState` on their next file load).
- **Chat sidebar: main process owns network + processes; MCP servers ship
  as-built.** `app/main/services/chat/` runs the LLM agent loop and spawns
  the three stdio MCP servers; the chat renderer keeps the strict CSP and
  never sees an API key. Placement contracts of the unmodified server
  bundles: `cad/dist/mcp-server.js` is copied to
  **`out/cad-runtime/dist/mcp-server.js`** (its `extensionPath` = the
  bundle's `dirname/..`, and the OCCT/Gmsh WASM already live there) and
  `mesh/dist/mcpServer.js` to **`out/mcpServer.js`** (it reads
  `__dirname/mmg-core.wasm`). Spawn the Node bundles with
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (no system Node in packaged
  installs), and **always pass `{...process.env}` to `StdioClientTransport`**
  — the MCP SDK otherwise strips env to a minimal set, silently losing PATH
  (breaks `uvx kratos-mcp-server`). The kratos server is **pinned** to
  `KRATOS_MCP_VERSION` in `mcpManager.ts` (`uvx kratos-mcp-server@<v>`) — bump
  that constant to upgrade; its 40 tools + resources + prompts are discovered
  at runtime, so nothing else changes. `McpManager` also aggregates MCP
  resources/prompts (surfaced to the chat as synthetic `mcp__*` tools via
  `chatTools()`). API keys go through `services/chat/secrets.ts`
  (safeStorage-encrypted in the stateStore) — never store them
  plaintext-by-design or ship them to a renderer.
- **One shared McpManager, two front-ends.** `McpHub`
  (`services/chat/mcpHub.ts`) owns the single `McpManager`; both the chat loop
  and the optional **HTTP meta MCP server** (`services/metaServer/`) call
  `hub.ensureStarted()`, so the three children are spawned once (constructed in
  `index.ts`, disposed on `will-quit`). The meta server re-exposes the same
  aggregated toolset (+ resources/prompts) over `127.0.0.1:<port>/mcp`
  (`StreamableHTTPServerTransport`) for an external LLM client — **off by
  default, bearer-token + Host-checked** (these tools touch disk). Wired via
  **Settings ▸ MCP Server**. New stateStore keys: `metaServerEnabled`,
  `metaServerPort`; secret: `metaServerToken`. Still ships no `node_modules`
  (SDK server subpaths bundle into `out/main.js`).
- **Update feed is two-part — keep both halves.** The `publish:` block in
  `electron-builder.yml` makes electron-builder emit `latest*.yml` update
  metadata and embed `app-update.yml` in each package; the release workflow
  uploads `release/latest*.yml` + `release/*.blockmap` to the GitHub Release.
  electron-updater (About dialog, `app/main/services/updates.ts`) needs both;
  it and `semver` are devDeps **bundled into out/main.js** — the package
  still ships no node_modules. In-app install only on win-NSIS/AppImage;
  everything else falls back to the releases page.
- **Screens vs modes.** `Screen = "home" | "editor" | Mode`
  (`app/main/ipc.ts`): the home screen (`app/renderer/home/`, config-driven
  buttons in `homeConfig.ts`; full-window) and the text editor
  (`app/renderer/editor/`, CodeMirror 6; body bounds under the toolbar) are
  extra WebContentsViews next to the mode views; `MainWindow.setScreen()`
  only toggles visibility, so every view keeps its state across switches
  (this is also why the editor needs no dirty-prompt on navigation — only on
  window close and open-over-unsaved), and `mode()` keeps returning the last
  active mode on non-mode screens (the router and File-menu actions rely on
  that). Opening a file (CLI arg included) jumps straight to the owning
  mode. The editor's fs work stays in `app/main/services/editor.ts` — its
  renderer never touches the filesystem.

## Screenshots are generated, not hand-captured

`npm run docs:screenshots` (`tools/screenshots.mjs`) launches the **real app**
via Playwright-Electron on real submodule example files (bull.stp,
double_arch.mdpa, Main_0_6.vtk) and captures the live windows at 2x. PNGs are
committed under `doc/public/screenshots/` (kebab-case) and the two README
heroes are refreshed in `images/` (`pre_processing.png` ← cad-viewer,
`post_processing.png` ← mesh-viewer). **Any change to the shell toolbar, the
generated webview pages, or visible viewer behavior means re-running it** —
don't hand-edit the PNGs. Prereq: one full `npm run build`; run headless with
`env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run docs:screenshots`. Shared
launch helpers live in `tools/e2eShared.mjs` (used by the smoke test too).

## Icons — TikZ pipeline (never hand-edit generated files)

`icons/` mirrors the submodules' icon pipeline (see `icons/README.md`):
`tikz-ui/*.tex` → pdflatex + pdftocairo → `svg-ui/*.svg` →
`build-toolbar-icons.mjs` (copied verbatim from mesh) → **generated, committed**
`app/renderer/shell/shellIcons.ts` (currentColor, theme-adaptive; `open.tex`
and `edit.tex` are copied verbatim from mesh so the family stays visually
consistent; the home-screen menu buttons consume the same generated icons).
No pdflatex? tectonic + poppler via micromamba is a verified drop-in for the
`.tex → .svg` steps (see icons/README.md). The
**app icon** is `icons/tikz-app/kkss.tex` (the colored "split cube": blue CAD
half, orange mesh half) → `icons/app/icon{,-256,-1024}.png`, consumed by
`electron-builder.yml` and copied to `out/icon.png` for the Linux window icon.
Regenerate with `npm run build:icons`; commit sources + regenerated artifacts
together.

## License

KKSS is **AGPL-3.0** because it distributes the GPL-2.0-or-later CAD-Preview
engine (whose WASM statically links Gmsh + OpenCASCADE) together with the
now-AGPL-3.0-or-later mesh engine — its Flowgraph problemtype embeds the
AGPL-3.0 `@kratos-flowgraph/flowgraph` node editor. Before adding any
dependency that ships in the packaged app, check GPL/AGPL compatibility first
(same rule as cad's CLAUDE.md).
