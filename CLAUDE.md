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
npm run docker:build   # build the streamed-desktop web image (docker compose build)
npm run docker:up      # serve the app to a browser at http://localhost:6080/vnc.html
npm run docker:up:ghcr # same, from the published image (no checkout/build needed)
npm run dist:dir       # package to release/linux-unpacked (what the image ships)
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

## Keep CHANGELOG.md in sync

**Every version bump (`chore: bump version to X.Y.Z` in `package.json` /
`package-lock.json`, immediately followed by a `vX.Y.Z` tag) must add a
matching entry to `CHANGELOG.md` in the same change** — don't leave it for a
follow-up. Format (Keep a Changelog style, newest first):
- A `## [X.Y.Z] - YYYY-MM-DD` heading (use the tag's date; UTC) with bullet
  points summarizing the notable commits since the previous tag — feature
  work and user-facing fixes, not every `chore:`/merge commit. If the release
  is a version bump only with no functional change, say so in one line (see
  the 1.0.1 entry for the pattern).
- A compare-link reference at the bottom:
  `[X.Y.Z]: https://github.com/loumalouomega/KKSS/compare/vPREV...vX.Y.Z`.
`git log vPREV..HEAD --oneline` (or `gh release view vX.Y.Z` once the release
exists) is the source of truth for what changed — don't guess.

## Keep chat features in sync

**Every time a new feature is added to the app, update the AI chat sidebar so
the assistant can see and use it — part of the same change, not a follow-up.**
Concretely:
- New viewer/file capability (formats, edit ops, mesh operations…) → check the
  submodule MCP servers expose it. If they don't, that's upstream work on the
  submodule's `kkss.dev` branch (the zero-modification rule applies to the MCP
  servers too); bump the gitlink when it lands.
- New viewer/file capability that becomes a **new MCP tool** → it also needs a
  row in `app/main/services/chat/toolPolicy.ts`'s table, or it silently defaults
  to asking on every call (safe, but it degrades the gate into noise).
  `test/chatToolPolicy.test.ts`'s key-set assertion is what fails to remind you.
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
  The shim throws loudly on unsupported commands by design. Three mesh modules
  are deliberately **out of reach** rather than shimmed, because each is only
  ever constructed from the submodule's own `activate()`, which KKSS never
  calls: `runTreeView.ts`, `sidebarViews.ts` and `emptyPreview.ts` (the last two
  arrived with mesh 3.15.0's Kratos activity-bar panel). That is what keeps
  `createTreeView`/`TreeItem`/`registerCommand`/`createWebviewPanel` out of both
  the bundle and the shim; KKSS covers the same ground natively — runs via
  **File ▸ Stop Kratos Run**, recent files via **File ▸ Open Recent** (KKSS's
  own app-wide store, not the submodule's), and the
  empty-preview shell via the tab model itself.
- **Heavy WASM stays off the UI thread.** OCCT + Gmsh run in
  `app/main/cadCompute.worker.ts` (RPC via `cadComputeClient.ts`); MMG runs in
  the mesh submodule's own worker pair. Path contracts of the unmodified
  submodule code: `out/mmgWorker.js` + `out/mmg-core.wasm` must sit **beside
  `out/main.js`** (`__dirname` resolution in `mesh/src/mmgWorkerClient.ts`),
  and the OCCT/Gmsh binaries live under `out/cad-runtime/dist/` (the services
  take `extensionPath` and append `dist/…`). This is also why
  `electron-builder.yml` sets **`asar: false`**.
- **meshio++ (extended mesh formats) is a verbatim WASM tree, loaded in-process.**
  The mesh submodule reads 39 (writes ~35) formats it has no native parser for
  (Gmsh, Abaqus, Nastran, UNV, Medit, Netgen, SU2, XDMF, tetgen, EnSight Gold,
  Triangle, Exodus II, CGNS, MOAB, Salome MED, …) through the ESM-only
  `@meshioplusplus/wasm` package (10.20.2, which adds the field-only
  `.dex`/`.ip`/`.mff` formats — point fields, no geometry — the write-only
  SVG/TikZ figure formats exposed in the export menu's "Figures" group, and,
  since it statically links HDF5/netCDF, the Exodus/CGNS/H5M/HMF/MED family
  plus `timeStep`/`timeValues` for the in-file Exodus timeline). **Both WASM
  variants must ship**: since 8.8.0 the package carries
  `meshioplusplus_wasm_mt.{mjs,wasm}` beside the sequential pair (~+6.2 MB) and
  auto-selects the threaded one under Node — i.e. in the main process and
  `out/mcpServer.js` — so shipping only the old pair makes *every* extended
  format die with an opaque `LinkError`. The submodule's copy plugin emits all
  four and `copyArtifacts()` mirrors the tree wholesale, so nothing parent-side
  enumerates them; verify `out/meshio/dist/meshioplusplus_wasm*` lists four
  files after a bump. Like pyodide/flowgraph it ships verbatim as
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
  `tools/webviewMarkup.ts`'s `meshBody()` is a hand-kept replica of the mesh
  page's body — mirror it element for element on every mesh bump, and consume
  `webviewChrome.ts`'s exports rather than inlining markup. **Since mesh 3.15.0
  the upstream original is `webviewChrome.buildPreviewHtml`**, not
  `mdpaEditorProvider.getHtml`: both editor providers and the standalone empty
  panel now reach it through `previewHtml.ts`, so there is one skeleton to track
  instead of two. It cannot simply be called — it bakes in one `<script>` and
  exactly two `<link>`s, while KKSS also links `vscode-vars.css` and
  `mesh-overrides.css` and must load `shim.js` *before* the bundle. Its
  `startEmpty` branch (`data-start-empty` + the `#empty-hint` overlay) is
  deliberately never emitted here: KKSS has no such state, since a mode screen
  always holds at least one tab. Mesh links **three** stylesheets in order: `design-system.css` (the
  `--ds-*` token layer `style.css` builds on — copy it in `esbuild.mjs` too),
  `style.css`, then `app/renderer/theme/mesh-overrides.css`.
- **The mesh menubar is emitted, then hidden.** mesh 3.0.0 put the viewer's
  File menu + scene-theme picker in an in-flow `#menubar` strip. KKSS's native
  menu already owns both, so `mesh-overrides.css` hides it — but the markup
  still ships, because `webview/main.ts` looks those nodes up by id. Anything
  reachable **only** from that strip needs a native menu entry (that is why
  File ▸ Save/Load Problem… exist).
- **Theme variables are guarded.** The submodule stylesheets consume
  `--vscode-*` variables; `app/renderer/theme/vscode-vars.css` defines them
  and `tools/check-theme-vars.mjs` fails the build if a submodule update uses
  one that is missing. The same guard also asserts `--ds-*` closure between
  mesh's `style.css` and `design-system.css`.
- **The cad B-rep cache lives in the worker, not the host.**
  `loadBRepCached` (cad 1.2.6) returns a `BRepCacheEntry` owning live OCCT
  handles — never structured-clone-safe, so it can't cross the compute RPC.
  `app/main/cadBRepCache.ts` holds it beside the OCCT singleton and returns
  only the plain `BRepResult`; `CadHost.disposeSession` calls
  `releaseBRepCache`, mirroring the provider's `onDidDispose`. A thrown load
  **drops** the entry without disposing it (a WASM abort may have left it
  half-torn-down) — same rule the provider's own catch follows.
- **Submodule deps aren't in the root tree.** A glue test (or any root-level
  module) that reaches into submodule source needs that submodule's own
  `node_modules`. esbuild walks up from the importing file and finds them;
  `vitest.config.ts` and `tsconfig.json`'s `paths` need explicit aliases (today:
  `fflate`, for the preprocess archive).
- **cad's meshio++ loader needs a KKSS-side resolver.**
  `cad/src/meshioService.ts` does a bare `await import("@meshioplusplus/wasm")`
  with no directory fallback (mesh's own loader ends at `__dirname/meshio`), so
  in a packaged install — no `node_modules` — every meshio route would throw
  `ERR_MODULE_NOT_FOUND`. `app/main/cadMeshioLoader.ts` is aliased in its place
  in `cadWorkerConfig` and resolves the copied `out/meshio/` tree. It must not
  use `require.resolve("@meshioplusplus/wasm/package.json")`: the alias catches
  that subpath too and esbuild fails at build time on it.
- **fTetWild needs the same treatment, and harder.** cad 1.5.0 added
  `float-tetwild-wasm` (MPL-2.0 — the first non-permissive runtime dep; keep it
  in the third-party notices) as a fourth WASM kernel behind mesh repair and
  mesh→B-rep promotion. It is ESM-only *and* its threaded glue has a
  **top-level await**, which esbuild refuses to emit into a `cjs` bundle — so
  unlike meshio++ this is a hard **build** failure, not just a packaged-install
  one. `app/main/cadFtetwildLoader.ts` is aliased in its place in
  `cadWorkerConfig` and resolves an `out/ftetwild/` tree copied straight from
  `cad/node_modules` (the submodule's own build does not stage it into `dist/`).
- **The cad MCP server needs `kernel-worker.js` beside it.** Since cad 1.3.0
  every OCCT/Gmsh/meshio++/fTetWild call from `dist/mcp-server.js` goes through
  a forked child that `kernelClient.ts` looks up as
  `<extensionPath>/dist/kernel-worker.js` — i.e. `out/cad-runtime/dist/`. Copy
  it or the chat sidebar's cad tools die on their first call.
- **Two cad 1.12.0 features are deliberately NOT ported, and must stay that
  way unless the trade-off is revisited.** *SpaceMouse* (the provider's
  `spaceMouseConnect`/`Disconnect` commands and the `spacemouse` motion relay)
  needs `node-hid`, a **second** native N-API module — see the node-pty
  invariant below, which is what makes the release matrix simple. `spaceMouse.ts`
  `require()`s it lazily inside `connect()` and reports a clear "HID layer not
  installed" message, so leaving it out costs nothing else in the submodule; it
  is also why `node-hid` appears in cad's `external` list but nowhere in KKSS's.
  The *Models activity-bar view* (`cad/src/modelsView.ts`) is a VS Code TreeView
  over the workspace folders, which KKSS has no analogue of and whose job the
  home screen and the Open dialog already do; its one parent-side-useful export
  is `ROUTED_EXTENSIONS` (every routed key including the compound `post.msh`),
  if a file watcher ever wants it. `app/main/cadHost.ts`'s header records both.
- **`.scad` shells out; `.csg` does not.** cad 1.12.0 added OpenSCAD as an
  import route: `.csg` (the evaluated form) is parsed and built kernel-side like
  any other B-rep source, but `.scad` is first converted to `.csg` by a
  **user-installed `openscad` binary**, which is why `cad/src/scadService.ts` is
  host-side and `CadHost.readOcctSource` — not the compute worker — is what
  calls it: a `.scad`'s `use`/`include`/`import` resolve relative to the source
  file, and the worker only ever receives marshalled bytes. Every OCCT path in
  `cadHost.ts` goes through `readOcctSource`, so nothing downstream ever sees
  format `"scad"`. The binary is configurable via the `cadOpenscadBinary`
  stateStore key (**Settings ▸ CAD Viewer Defaults ▸ OpenSCAD Binary…**), since
  the shim's `getConfiguration` always resolves to the caller's default;
  `OPENSCAD_BINARY` remains the headless escape hatch for the MCP child.
- **`renderService.ts` must stay OUT of the cad compute worker.** It imports
  playwright, which drags `playwright-core`'s unresolvable `chromium-bidi`
  requires into the bundle. `render_snapshot` is an MCP-only tool and the chat's
  cad server has its own kernel worker for it, so KKSS's worker deliberately
  omits that module — the flat namespace-spread map in
  `app/main/cadCompute.worker.ts` throws on a duplicate export name, so anything
  added there is checked at startup rather than silently shadowed.
- **Compound extensions are resolved by longest suffix, not by the last dot.**
  Both submodules moved to this (mesh 3.6.0, cad 1.5.1) because `case.post.msh`
  (GiD postprocess), `case.msh` (Gmsh) and `case.post` (permas) are three
  different formats sharing a last dot. `app/main/router.ts` therefore uses
  mesh's `meshExtname`, never `path.extname`. Note two formats route to **CAD**
  mode outright because post mode cannot read them: `.foam` (mesh writes an
  OpenFOAM case but cannot read one back) and `.msh2`.
- **Tabs: one `WebContentsView` + one `CadHost`/`MeshHost` instance per open
  document, per mode.** Opening a document into a tab disposes only *that
  tab's* session (`CadHost.dispose()`/`MeshHost.dispose()`) and reloads only
  *that tab's* view — it never touches any other open tab, in either mode.
  `app/main/windows.ts`'s `MainWindow` owns the tab registry
  (`openTab`/`closeTab`/`setActiveTab`, `Record<Mode, Tab[]>` +
  `Record<Mode, activeTabId>`) via the exact terminal/chat lazy-create +
  `setVisible()` precedent, just N-of-a-kind instead of one singleton per
  mode — only the focused tab of the active mode screen is ever visible or
  bounded; a hidden tab keeps its camera/edit-history/scroll state untouched
  and never reloads on a tab switch. The tab strip itself is plain DOM
  painted inside the `shell` WebContentsView (no view of its own);
  `app/main/windows.ts`'s `TAB_STRIP_HEIGHT` is reserved in `layout()` only
  while a mode screen (which actually has tabs) is active. `app/main/index.ts`
  is the tab orchestrator: `createTab(mode)` builds the view + Host together
  (never split across two owners mid-construction), `cadHosts`/`meshHosts`
  are `Map<tabId, Host>`, and `activeCadHost()`/`activeMeshHost()` resolve
  "whichever tab is currently focused" for every caller that used to hold a
  singular `cadHost`/`meshHost` reference (the native menu, the terminal's
  cwd provider, the chat context suffix). **Two pieces of state are
  genuinely shared across every tab, not per-tab:** `app/main/cadBRepCache.ts`
  keys its worker-held B-rep cache entries by a `sessionId` each `CadHost`
  is constructed with (a stable per-tab id from `windows.ts`), and mesh's
  `FlowgraphController` (forks one shared child process) is constructed once
  in `index.ts` and injected into every `MeshHost` — it was already built
  ref-counted for exactly this multi-panel scenario, so it needed no
  rework. mesh 3.8.0's **`RunManager`** is the third such shared object and
  follows the identical rule (its own header says so): a solve outlives the tab
  that started it, so `index.ts` constructs one, calls `restore()` to re-adopt
  `<stem>.kratosrun.json` sidecars, injects it into every `MeshHost`, and
  disposes it on `will-quit`. It is also the only thing needing
  `context.workspaceState`, which is why `createMeshExtensionContext()` supplies
  two mementos. mesh 3.15.0's **`RecentMeshStore`** is the fourth, and the
  reasoning is subtler: it is backed *only* by `globalState` (= the app-wide
  `stateStore`), so per-tab instances would share the underlying list yet each
  keep their own `EventEmitter` and fire redundant `setContext` calls — one
  instance is the correct reading, not merely the cheaper one. Both providers
  now require it (`new MdpaEditorProvider(context, flowgraph, runs, recents)`,
  `new VtkEditorProvider(context, recents)`) and `record()` on every resolve.
  It no longer drives any UI: **File ▸ Open Recent** and the home
  screen both read KKSS's own app-wide `services/recentFiles.ts` (see the
  recents invariant below), rebuilt from `onDidChange` because an Electron menu
  is static once built.
  `cad 1.5.0`'s **linked cameras** are the mirror image: the extension keeps
  the flag and session list on its single provider, so KKSS keeps them in a
  module-level `liveHosts` registry in `cadHost.ts` instead. **Open (Ctrl+O) replaces the focused tab's document**, matching
  pre-tabs muscle memory exactly; **File ▸ New CAD/Mesh Tab** (or the tab
  strip's `+`) is the explicit way to open a second document instead. Closing
  a tab has no dirty-prompt — cad/mesh have no app-level "unsaved changes"
  concept (sidecars autosave on a debounce), so this is a plain dispose, same
  as replacing a tab's document always has been. Entering a mode screen
  (`setScreen`) guarantees it has at least one tab, creating a blank one if
  the user closed every tab of that mode, so the viewer is never left
  literally empty. `.stl/.obj/.ply` are viewable in both modes — the active
  mode wins (`app/main/router.ts`). CAD-Preview 1.2 also claims
  `.mdpa/.vtk/.vtu/.med/.cgns/.exo/.e/.xdmf` via meshio++, but those keep
  routing to **mesh** mode (`routeFile(...)?.strategy === "meshio"`), which
  reads them natively; CAD's geometry-only importer stays reachable from its
  own Open dialog. cad 1.12.0's `.csg`/`.scad` are plain `occt`-strategy
  formats, so they route to **cad** with no `router.ts` change at all. **Pre →
  post is one-way synced:** a mesh exported from
  CAD/pre that post mode can display (`.mdpa`, `.vtk`, …) auto-opens in a
  **new** mesh tab (`CadHost.onMeshExported` → `createTab("mesh")` +
  `openPath(...)` in `app/main/index.ts`, gated by `modeForFile` so
  shared/CAD-only outputs never jump) — deliberately never replacing whatever
  the user currently has focused in mesh mode. Post → pre is deliberately not
  synced. The text editor screen is **not** part of this tab model — it stays
  single-document with its own dirty-guard-on-close, unaffected.
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
- **Docker web deployment streams the unmodified desktop app.** `docker/`
  (Dockerfile + `entrypoint.sh`) + root `docker-compose.yml` (build) /
  `docker-compose.ghcr.yml` (pull) run the app headless (Xvfb + openbox +
  x11vnc + noVNC on port 6080) — no app-code fork. Invariants:
  - **The image is multi-stage and the runtime stage carries only
    `release/linux-unpacked` + the X/VNC stack.** The builder runs
    `npm run dist:dir`, so `electron-builder.yml`'s `files` rules stay the one
    source of truth for what the app needs at runtime — never hand-copy `out/`
    into the runtime stage as a second, drifting list. Nothing Node-, npm- or
    source-shaped may reach it (CI asserts `npm` is absent).
  - It runs as the **non-root `kkss` user (uid 1000)**; settings live at
    `/home/kkss/.config/kkss`. The packaged app stays root-owned so the runtime
    user cannot modify its own binaries.
  - The entrypoint's Electron flag set **must stay in sync with
    `tools/smoke.e2e.mjs`/`tools/e2eShared.mjs`** (the CI-proven headless
    config), must launch with `env -u ELECTRON_RUN_AS_NODE`, and launches the
    **packaged binary** (`$KKSS_BIN`), not `node_modules/.bin/electron`. It
    supervises every process it starts (`wait -n` over tracked PIDs) and
    forwards SIGTERM, so one dead child takes the container down rather than
    leaving it "up" serving nothing. `xdpyinfo` (from `x11-utils`) is what the
    readiness poll and healthcheck depend on — keep the package.
  - The build context requires initialized submodules; `docker/*.sh` must stay
    LF (`.gitattributes` enforces this — the scripts run inside the Linux
    container). There is deliberately **one** `.dockerignore`: a
    `docker/Dockerfile.dockerignore` would silently override it.
  - `.github/workflows/docker.yml` lints, builds, boot-checks and scans the
    image per architecture on its own native runner (amd64 + arm64 — QEMU is
    impractical and `--platform=$BUILDPLATFORM` is wrong for a packaged
    Electron binary). On `v*.*.*` tags each arch pushes **by digest** and a
    `manifest` job merges them into one multi-arch tag on **GHCR**
    (`ghcr.io/loumalouomega/kkss`, built-in `GITHUB_TOKEN`) and **Docker Hub**
    (`vmataix/kkss`, `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets).
    User docs live in `doc/guide/web-deployment.md`.
- **One instance, and one queue for "open this path".** `app/main/index.ts`
  takes `app.requestSingleInstanceLock()` at module load; the loser prints a
  diagnostic and quits, and its argv reaches the winner via `second-instance`
  (focus the window, then `openFile`). This is a data-integrity invariant, not
  a nicety: two instances share one `userData/state.json`, and since the store
  rewrites it whole, the loser's first write would discard everything the
  winner changed — including the encrypted API key and MCP bearer token.
  macOS `open-file` fires **before** `app.whenReady()`, so it is queued in
  `pendingOpen` and flushed at the end of the ready block through the *same*
  path the CLI argument uses — never add a second deferred-open mechanism. A
  forwarded relative path resolves against the *other* process's
  `workingDirectory`, which is why `fileArgFrom()` takes a cwd. The
  count-based argv slice is deliberate (`electron out/main.js` must not open
  `out/main.js` as a document). `KKSS_ALLOW_MULTIPLE_INSTANCES=1` opts out and
  **`tools/e2eShared.mjs` sets it** — the harness relaunches repeatedly and
  SIGKILLs the tree between runs, so a leftover lock would make every later
  launch quit on startup; that also makes lock acquisition the one startup
  path e2e never covers.
- **`state.json` is written atomically, and never with a bare `writeFile`.**
  `app/main/services/jsonStore.ts` (the Electron-free half of `stateStore.ts`,
  split out to be testable — same shape as `chat/secretCodec.ts` under
  `chat/secrets.ts`) writes a sibling temp file, fsyncs it, and renames it over
  the target behind a single-writer chain — now via the shared
  **`services/atomicWrite.ts`** helper, which also backs cadHost's eight sidecar
  writers and keys its own chain by **resolved path**. That per-path chain is
  not optional once a temp name is involved: two overlapping writes would share
  `<file>.<pid>.tmp` and the second `rename` would fail with ENOENT, and two
  such overlaps exist (`flushSidecars()` clears the six debounce timers but
  cannot cancel one that has *already fired*, and `cad-preview-macros.json` is
  a per-*folder* library two tabs in one directory both write). The sync variant
  skips the fsync and the Windows rename retry on purpose — it runs on the quit
  path — and uses a **distinct temp name** (`.sync.tmp`): it bypasses the chain,
  so a shared name would let an async write that is mid-`open()` end up holding a
  handle to the file the sync write has just renamed into place, and its stale
  snapshot would land in `state.json` after all. `services/sidecarSuffixes.ts` is the single owner of the sidecar names,
  imported by `cadHost.ts` and the cloud layer so the two cannot drift. Both properties are load-bearing:
  the safeStorage-encrypted LLM key and the meta server's bearer token live in
  that same file, so a torn or interleaved write loses every setting *and* both
  credentials, and the store's silent corrupt-file fallback then boots the app
  looking factory-fresh. A still-queued write absorbs later mutations (the many
  fire-and-forget `void stateStore.update(...)` callers depend on that
  coalescing). `will-quit` cannot await, so it calls `flushSync()` **first**;
  an async write in flight can only resume after that returns and re-checks
  `stopped` before its own rename, so it can never overwrite the final state.
  `JsonStore` is instantiated **per file** — `state.json` plus one per chat
  conversation and one for their index — so each file owns its own chain.
- **Cloud documents are staged locally, and the staging path is the only path
  the rest of the app ever sees.** `services/cloud/` downloads a remote file into
  `<userData>/cloud-cache/<provider>/<opaque-id>/<original filename>` and hands
  *that* path to `openFile()`, so routing (`router.ts`'s longest-suffix rule),
  `allowRoot()`, both hosts' `fs` calls and the submodules' own MCP servers keep
  working unmodified — nothing below the staging layer knows a file is remote.
  It had to be this shape: every consumer of an opened path assumes a real file
  on disk, and the zero-modification rule forbids teaching the submodules'
  `node:fs` calls a provider API. The filename is preserved byte-for-byte
  (routing is extension-driven, so `case.post.msh` must survive) and **one
  directory holds exactly one document plus its sidecars**, which is what makes
  cad's `${modelPath}.parts.json` siblings work with no cadHost change and makes
  "every other non-artifact file here is a sidecar" safe rather than a guess.
  `allowRoot()` is still called per-document on that directory by
  `CadHost.openPath` — **never** on `cloud-cache/` itself, which would make every
  cached document from every account fetchable by any webview. Write-back is
  **watcher-driven, not host-driven**: `mesh/src/meshExport.ts`'s `saveMesh()`
  overwrites `ctx.fsPath` with a bare `fs.promises.writeFile` inside the
  submodule and never reports the path back, so a save can be *observed* but
  never *intercepted* — hence one chokidar watch per staging directory (the bare
  `"*"` pattern added to `services/watcher.ts`), coalesced on a 3 s debounce that
  swallows cadHost's 500 ms one. Its `depth: 0` is a real limit: XDMF's sibling
  `.h5` is uploaded, OpenFOAM's nested `constant/polyMesh/` tree deliberately is
  not. Conflicts are detected by stored remote revision — Drive
  `headRevisionId`, Dropbox `rev`, Graph **`cTag`, never `eTag`** (which also
  moves on metadata-only edits and would manufacture a conflict copy every time
  OneDrive touched the file) — with the wire-level precondition carried
  separately, since Graph's `if-match` accepts only `eTag`; a missing baseline
  counts as a conflict, because a spurious copy is tidy-up and a clobbered
  remote edit is lost work. On conflict the local file is untouched and uploaded
  beside the remote one, named with `meshExtname`'s longest-suffix split so
  `case.post.msh` stays routable, after which the remote's revision is adopted as
  the new baseline or every tick would conflict forever.
  `cad-preview-macros.json` is deliberately **not** synced: per-*folder* library,
  per-*file* cache, so uploading it would let two models from one remote folder
  overwrite each other's macros. `before-quit` gets one flag-guarded
  `preventDefault()` to drain in-flight uploads (10 s cap) because `will-quit`
  cannot await an HTTPS upload; anything still pending stays `dirty: true` in the
  manifest and is reported on the next launch. Recents carrying a `cloud` ref are
  **exempt from the existence prune** and re-download on click; **session restore
  deliberately does not re-download**, since it is synchronous and never stats by
  design — an evicted path falls into the existing "files could not be found"
  toast, and eviction's `keep` set (open tabs + `sessionPaths()`) makes that
  rare. OAuth is **bring-your-own client** — the user pastes their own client ID
  (+ secret where the provider issues one; a Google "Desktop app" secret is
  explicitly not confidential) — with PKCE + `state` over a one-shot 127.0.0.1
  loopback redirect built on `metaServer.ts`'s listen/error/Host-check handling;
  tokens go through `chat/secrets.ts`. **No KKSS-owned client id is ever baked
  in.** Zero new dependencies: all three providers are plain REST over
  `net.fetch`, `node:crypto`, `node:http`, `node:stream` and the already-shipped
  `chokidar`. Both Drive and Graph take a **simple-upload path below ~4 MB**
  (Drive `uploadType=media`/`multipart`, Graph `PUT .../content`): a sidecar is a
  couple of KB, so a resumable session would be three round trips for nothing —
  and neither provider can finalise a *zero-byte* resumable session at all, so
  this is a correctness path, not just an optimisation.
- **Every `WebContentsView` is created through `wireView()`** (`windows.ts`),
  which owns both zoom re-assertion on `did-finish-load` and renderer-crash
  reporting — adding a view without it silently opts that view out of both.
  windows.ts only *reports* (`MainWindowHooks.onViewCrash`); the recovery
  policy lives in `index.ts`, which owns the host maps. Recovery is a reload,
  plus replaying a mode tab's file through `openPath()` — never both for a tab,
  since `openPath` already reloads and `MainWindow.reloadView` would race it.
  It leans entirely on the ready-handshakes that already exist (`shellReady`,
  `editorReady`, `termReady` reusing the live pty, the chat's main-side
  transcript, a provider's `ready`), which is why it needs nothing from the
  submodules. (The chat's transcript is now on disk too, so a crash mid-turn
  costs at most the debounce window.) It is bounded per view inside a time window so a reproducible
  crash cannot loop, honors the per-tab rule (recover one tab, never a whole
  mode), and **`unresponsive` is deliberately not wired to it** — that fires on
  any long synchronous parse, exactly what both viewers do on a large mesh, so
  reloading on it would destroy a working session mid-load.
- **The project folder is a default, never a fence.** `services/projectRoot.ts`
  seeds the terminal's cwd, file-dialog start folders, the chat context suffix
  and the shim's `workspaceFolders` — and refuses nothing. It is deliberately
  **not** wired to `protocol.ts`'s `allowRoot`, which stays per-document:
  widening that allow-list to the root would silently make every file under it
  fetchable by a webview, i.e. build a fence out of the thing that was decided
  not to be one. Path scoping for the MCP toolset is a separate, later decision.
  Two levels: `explicit()` (chosen, persisted under `projectRoot`) and
  `effective()` (explicit, else the focused document's directory). **Consumers
  use `effective()`, so with no explicit root behavior is byte-identical to
  before the concept existed**; only `explicit()` is ever *displayed* or given
  to the shim, because an inferred root changes with the focused tab and would
  also bake a developer's absolute path into the committed docs screenshots. A
  stored root that is gone degrades to "none" on read but is never erased (an
  unmounted share must not silently forget the setting), which is why the menu's
  Clear uses `isSet()` rather than `current()`.
- **`workspaceFolders` is populated for an explicit root only, and that is a
  safety decision.** `ptController.discoverExternal()` does not merely *locate*
  `<root>/.kratos/problemtypes` — it **executes** what it finds (sandboxed: a
  `node:vm` context with no `require`/`process`/`fs`, `codeGeneration` off, 2 s
  timeout). Gating on the explicit root means opening a mesh that happens to sit
  beside such a directory never runs it; only a deliberate File ▸ Open Folder…
  does. It must also stay a **getter** on the shim's `workspace` object — the
  old static property was evaluated once at import and could never track a
  changing root — and it reaches the shim through `__configureVscodeShim`'s
  hooks, whose default returns `undefined` rather than throwing like the other
  hooks, since this is a passive read submodule code makes at any time.
- **`services/dialogs.ts` is the one place the dialog default is injected.** A
  `defaultPath ?? projectRoot.effective()` there covers cadHost *and* every mesh
  dialog, because esbuild aliases `vscode` to the shim and the shim funnels
  `defaultUri` through it — so this needs no submodule edit. `??` and not `||`:
  a caller that knows better always wins, which is what keeps mesh's
  document-relative save/export defaults intact. **`services/editor.ts` is the
  one bypass** — it calls Electron's `dialog` directly, parented to the window
  for its dirty-buffer modality, so it applies the same default itself.
- **The terminal picks up a root change on its next shell, never the running
  one.** node-pty has no chdir and the cwd is read once at spawn, so a change
  toasts what actually happened instead of appearing ignored — the same contract
  the neighbouring `terminalShell` setting already states.
- **Recents are recorded at exactly one choke point.** `openFile()` in
  `index.ts`, which is why every user-facing open is routed through it. The
  three `host.openPath()` callers that bypass it — crash replay in
  `recoverView`, `openLatestResults`' new-tab branch, and `onMeshExported` —
  and session restore all deliberately record **nothing**: none is "the user
  opened this file", and recording them would let a crash silently reorder the
  list or a derived artifact outrank the model actually opened. De-duplication
  is by path with the `mode` refreshed, so a format both modes read
  (`.stl`/`.obj`/`.ply`) is one row remembering where it was last opened, not
  two rows one of which reopens in the wrong mode. `services/recentFilesCore.ts`
  reuses `recentKey`/`recentLabel`/`recentDescription` from the submodule's
  vscode-free `mesh/src/recentMeshesCore.ts`, but **not** its
  `recordRecent`/`parseRecentList`, which construct a bare `{path, openedAt}`
  and would drop `mode`. mesh's own `RecentMeshStore` still runs (both providers
  take it as a constructor arg) but drives no UI.
- **The mesh extension's `globalState` is unprefixed, so its keys are reserved
  app-wide.** `mesh/meshHost.ts` maps `globalState` straight onto `stateStore`
  with no namespace (only `workspaceState` gets a `workspace.` prefix), so
  `recentMeshes`, `sceneTheme` and every other key the submodule writes share
  one flat space with KKSS's own — and a mesh bump can claim a new one. **Check
  a new key against the submodule tree before using it**; `recentFiles`,
  `session` and `restoreSession` were chosen that way.
- **Session restore is opt-out, prunes first, and never records.** Gated by
  `KKSS_E2E` (the e2e harnesses launch the real app, so a restore would perturb
  every case and screenshot), `KKSS_NO_RESTORE=1`, and **Settings ▸ Restore Last
  Session**; the gate covers restoring only — recording and saving stay live, or
  the docs' home-screen shot would have an empty recents list. It persists each
  mode's files plus the focused **path** (tab ids are a per-process counter; an
  index shifts when pruning drops an earlier file) and degrades a stored
  `"editor"` screen to `"home"` at capture time, since that buffer is
  `EditorService`-owned and unpersisted. Missing paths are pruned **before**
  anything opens: both hosts' `openPath()` is synchronous and never stats the
  file, so a vanished path becomes a ghost tab whose error only ever appears as
  an in-pane banner. Restore opens with `openPath()` (append, mode already
  known, no recording) and closes the blank starter tab. `saveSession()` must
  run **before** `stateStore.flushSync()` in `will-quit` — that call sets the
  store `stopped`, after which queued writes return early. A launch-time file
  wins, taking the screen and its own tab so it never overwrites a restored
  document, and it still flows through the single deferred-open mechanism.
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
- **Chat transcripts are durable, per conversation, and a turn is bound to the
  one it started in.** `<userData>/chats/` holds one `<id>.json` per
  conversation plus an `index.json` of the sidebar's history rows; each file is
  its own `JsonStore` (atomic write, own writer chain, `flushSync()` from
  `will-quit` via `ChatService.flushSync()`), and only the active conversation
  is resident — `TranscriptStore.close()` flushes and drops the rest.
  `transcriptStoreCore.ts` is the pure half (versioned blobs, repair-on-parse,
  title derivation, caps), `transcriptStore.ts` the fs glue — the
  `sessionCore.ts`/`session.ts` split. `CHAT_STORE_VERSION` is ignored wholesale
  on mismatch and an index row whose file is gone (or unreadable) is pruned at
  read time; there is deliberately **no transaction across the two files**.
  Entries are written on append boundaries with a 1 s debounce — never per
  stream delta, since a tool result is `RESULT_CHARS` = 50 000 chars — plus
  undebounced on each user message and at the end of a turn; `flushSync()`
  **lands** a still-pending debounced save rather than cancelling it. **Stored entries
  keep the full tool-result text; `toWire()`/`PREVIEW_CHARS` in `transcript.ts`
  stays the single truncation point**, so a persisted transcript never becomes a
  second one. The binding rule is the correctness core: `run()` captures the
  active conversation once, every append targets that object, and every message
  is gated on it still being on screen — switching or deleting the *active*
  conversation aborts the turn and awaits its unwind first (recorded as an
  appended `stopped` assistant entry carrying the streamed partial, **never** a
  flag set on the previous entry, which would mislabel a finished turn), while
  deleting a *background* one leaves the running turn alone. An untouched
  conversation is never written or listed, so **New** archives at no cost.
- **Tool calls are gated by a KKSS-side policy table, and the gate must always
  settle.** `services/chat/toolPolicy.ts` is a pure module mapping the **full
  namespaced** tool name to `read`/`write`; unlisted ⇒ `unknown` ⇒ ask. It is
  deliberately **not** derived from MCP `annotations` — the SDK's own type
  declarations say a client must never make tool-use decisions from a server's
  annotations, and no cad/mesh tool declares any anyway — nor from name or
  description heuristics (`mesh__problemtype_list` reads like a listing and
  actually *executes* workspace problemtypes). Read ⇒ auto, write/unknown ⇒
  prompt inline in the transcript. **Settings ▸ LLM Assistant ▸ Tool Approval**
  (`llmToolApproval`, default `askOnWrite`; `never` is confirmed once by
  dialog). Three rules are load-bearing: **(1)** `awaitApproval`'s promise
  resolves `"deny"` on `signal.abort` and in `flushSync()` — `settleTurn()`
  *awaits* the turn and five paths reach it (Stop / New chat /
  selectConversation / deleteConversation-on-active / `will-quit`), so a promise
  that could hang deadlocks every one of them; **(2)** a denial still appends a
  `toolResult` (`ok:false`), because `transcript.ts` drops a `toolCall` with no
  matching result — a silent denial makes the model re-emit the same call and
  burn an iteration; **(3)** a *pending* approval is **never persisted** — it
  rides `ChatToWebview`'s `state.pendingApproval` and is replayed on
  `chatReady`, so a renderer reload resumes a blocked turn instead of stranding
  it, while a hard crash cannot replay dead buttons. The *decision* persists as
  an optional `approval` field on the `toolCall` entry, needing **no
  `CHAT_STORE_VERSION` bump** (a bump discards every stored conversation; an
  optional field degrades in both directions). "Always allow in this
  conversation" lives in a service-level `Map<conversationId, Set<string>>`,
  **not** on `LiveConversation` — `store.close()` drops that object on every
  conversation switch, so a grant there would silently expire. **Path scoping is
  out of scope** (classification only), and **the HTTP meta server
  (`metaServer/buildServer.ts`'s `callToolRaw`) is deliberately un-gated** —
  bearer token only, since an external client has no user to prompt. Every
  submodule or `KRATOS_MCP_VERSION` bump must re-check the table:
  `unclassifiedTools()` logs the names a bump added, and
  `test/chatToolPolicy.test.ts` pins the exact 71-name key set.
- **A dry run is a check for the human, and is the one chat message that
  deliberately does NOT settle the gate.** `dryRunTool` re-issues the blocked
  call with `toolPolicy.ts`'s `DRY_RUN_PARAM` key forced true (`dryRunArgs()` is
  the single decision point — it also declines a tool with no row, unparseable
  or non-object args, and a call the model already marked `dryRun: true`, and
  that same null check is what decides whether the button is offered at all).
  Three properties make it safe next to the "must always settle" rule above:
  it never touches `awaitApproval`'s promise, so all five `settleTurn()` paths
  are unchanged; `run()` **never awaits it**, so it cannot delay an abort; and
  it **never calls `append()`**, so the model is never handed a result for a
  call that did not happen — which is what removes the semantics problem the
  roadmap item was blocked on, and why no `contextSuffix()` or system-prompt
  change was needed. Its result is gated twice, because the handler runs outside
  `run()` and has neither value in scope: the turn's `convo` and `signal` are
  carried on the `pendingApproval` record and re-read on completion, so a Stop,
  a conversation switch or a delete drops the report instead of painting it into
  whatever is on screen. `awaitApproval`'s `finish()` nulls that record, which is
  also what makes an in-flight dry run stale — one line covering Deny, Allow (a
  late report would otherwise race the real call's own writes), abort and
  `flushSync()`. Re-entrancy is guarded on **main**, not by disabling the button:
  a `state` replay rebuilds the prompt with a fresh enabled one. The report is
  worded narrowly on purpose — cad gates its OCCT replay on the same flag it
  gates its writes on, so it says which ops parse and are legal, never what the
  geometry would become. Hence **Validate (dry run)**, not "Preview".
- **Tool-result images are session-only, and never ride a `ChatWireEntry`.**
  `mcpManager.extractImages()` forwards `{type:"image"}` blocks for display;
  `flattenContent()` is deliberately untouched, so the model keeps seeing its
  `[image content]` placeholder and the two views cannot drift (a routing test
  pins the pairing). That is also why they are not stored:
  `transcriptStoreCore.ts` holds "the full tool-result text **the model was
  given**", and the model is not given the bytes — so `ChatEntry`, `parseEntry`
  and `CHAT_STORE_VERSION` are all unchanged, and `<id>.json` never carries
  megabytes of base64 through the whole-file atomic rewrite. They travel as their
  own `toolImages` message, sent after the entry and replayed after `state`,
  because `sendState()` fires on far more than a reload (`chatReady`, an empty
  New chat, re-selecting the active conversation, rename, every switch) and
  `webContents.send` structured-clones synchronously on the main thread. The
  cache is one `Map<callId, ChatImage[]>` for the **active conversation only** —
  not keyed by conversation, since `sendState()` only ever replays the active one
  — cleared in `switchTo()`, which makes `IMAGE_BUDGET_BYTES` the global bound by
  construction. The per-image byte cap is small because it bounds the *transfer*,
  not the decoded bitmap (a 2 MB PNG can be 20000² pixels); the renderer creating
  its `<img>` lazily on the chip's `toggle`, and `live` on the wire so a replay
  never force-opens a chip, are the other half of that bound. SVG is excluded
  from the mime allow-list and `dataBase64` is shape-validated: it is
  interpolated into a `data:` URL by a page with no `'unsafe-inline'`.
- **Token accounting is measured, priced from a reviewed table, and never
  transmitted.** `TurnResult.usage` is optional and **absent** when a provider
  reports nothing — "no data" and "cost nothing" must stay distinguishable.
  `TurnUsage.input` means *uncached* input on both providers, which takes work
  on each: Anthropic bills `cache_read_input_tokens`/`cache_creation_input_tokens`
  **in addition to** `input_tokens`, so the context figure is the sum of all
  three; OpenAI counts cached tokens *inside* `prompt_tokens`, so
  `parseUsageChunk` subtracts them back out. That chunk arrives with an **empty
  `choices` array**, which is why it is parsed *before* the `delta` guard that
  skips choice-less chunks — and it is only sent at all because the request now
  carries `stream_options: {include_usage: true}`, which a stricter gateway may
  reject, hence the retry-without-it (the same shape as Anthropic's conservative
  retry). `services/chat/modelInfo.ts` is a deliberate table in the
  `toolPolicy.ts` mould: **an unknown model resolves to `null` and the sidebar
  shows token counts with no cost and no context percentage**, which is the
  normal case for the OpenAI-compatible provider and is the honest answer rather
  than a gap to fill by guessing. Cache rates are stored per row, not derived
  from input (Fable 5.1 reads at a flat $0.25/MTok, and a pricing rule with one
  exception acquires more). Cumulative usage is an **optional field on
  `StoredConversation`** — the `approval` precedent again, so **no
  `CHAT_STORE_VERSION` bump**, which would discard every stored conversation;
  it is persisted rather than session-only because a lifetime cost that reset on
  restart is worse than none. `lastInput` is *replaced* per turn, not summed: it
  answers "how full is the window", a different question from what the
  conversation has cost. This readout is **not** the telemetry the roadmap rules
  out — it is computed main-side and shown only to the user whose key paid for it.
- **The Anthropic request carries one prompt-cache breakpoint, and that is what
  the byte-stable system prompt was always for.** `cache_control` sits on the
  `system` block; the render order is `tools` → `system` → `messages`, so that
  single breakpoint also covers the whole MCP toolset — which is where the value
  is, since every tool schema is re-sent on each of up to `MAX_ITERATIONS`
  iterations. **Changing `SYSTEM_PROMPT`, or moving volatile context into it
  instead of onto the newest user message via `contextSuffix()`, now has a
  measurable cost** rather than a theoretical one; `cache_read_input_tokens`
  reading zero across repeated turns means a silent invalidator. The conservative
  retry drops `cache_control` along with `thinking`, so a model old enough to
  reject one degrades the way it already did.
- **`ChatErrorKind` gained `context` and `rateLimit`, and every kind must be
  listed in `transcriptStoreCore.ts`'s `ERROR_KINDS`** — a kind missing there is
  not rejected on read, it is silently rewritten to `"other"`, so the banner
  loses its explanation. A context overflow also **suppresses the Anthropic
  conservative retry**: it is a 400, but a smaller `max_tokens` cannot shorten an
  over-long prompt, so retrying only bought a second round trip and then reported
  the retry's error instead of the real one.
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
- **Interface scale is one global zoom factor, chrome included.**
  `MainWindow.setZoom()` (`app/main/windows.ts`) calls `setZoomFactor` on
  *every* view (shell, home, editor, both modes, terminal, chat), and because
  `setZoomFactor` scales content but not bounds, `layout()` multiplies the
  fixed chrome constants (`SHELL_HEIGHT`/`TERMINAL_HEIGHT`/`CHAT_WIDTH`) by the
  same factor — change one, change the other or the toolbar clips. Electron
  drops a view's zoom to 1 on navigation, so each view re-asserts it on
  `did-finish-load` (mode views reload on file open). Driven by the shell's
  scale picker (`ShellToHost.setZoom`/`ShellToWebview.zoom`) and **View ▸ Zoom
  In/Out/Reset** (`Ctrl +`/`Ctrl -`/`Ctrl+Shift+0` — `Ctrl+0` is Home);
  persisted under the `uiZoom` stateStore key and re-applied via
  `createMainWindow(__dirname, zoom)` on launch. `ZOOM_PRESETS` is the source
  of truth — the shell renderer mirrors the same list to build the dropdown.

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
**Both harnesses launch with an isolated `--user-data-dir`** (`launchApp`'s
`userDataDir`): the home screen renders the recent-files list, so the real
profile would put whoever regenerated the PNGs into a committed image, and a
fresh profile also pins theme/zoom/viewer defaults so the shots are
reproducible. screenshots.mjs shares **one** temp profile across its four
sessions *in order* — that is what makes the home shot deterministic, since the
first three sessions are what populate its recents list.

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
