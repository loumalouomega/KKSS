# Architecture & Building

## The shim architecture

KKSS reuses the two VS Code extensions **without modifying them**. Both are
already split into a browser-side webview bundle (whose only VS Code
touchpoint is `acquireVsCodeApi()`), vscode-free compute/parser modules, and a
thin vscode-coupled glue layer. KKSS replaces only the glue:

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

A fourth, full-window `WebContentsView` — the **home screen**
(`app/renderer/home/`) — is stacked on top and shown on launch (and via the
toolbar's Home button, `Ctrl+0`, or **View ▸ Home**). It covers the shell and
both mode views; entering a mode hides it. Screens are tracked as
`Screen = "home" | Mode` in `app/main/ipc.ts` and switched with
`MainWindow.setScreen()` (`app/main/windows.ts`) — mode views are only ever
`setVisible()`-toggled, so their state survives trips through the home
screen. The home menu's buttons are config-driven: add an entry to
`app/renderer/home/homeConfig.ts`, a `HomeAction` case in `app/main/ipc.ts`,
and its handler in `app/main/index.ts` (`home:toHost`/`home:toWebview`
channels via `app/preload/homePreload.ts`, same contextBridge pattern as the
shell).

### About dialog & updates

**Help ▸ About KKSS…** (and the home screen's Help button) opens a frameless
singleton window (`app/main/services/about.ts`, same pattern as the modal
picker) backed by `app/renderer/about/` over `about:init` / `about:toHost` /
`about:toWebview` (`app/preload/aboutPreload.ts`). It shows the version
(`app.getVersion()`), the author (injected from `package.json` by an esbuild
`define`), and an update check.

Update flow (`app/main/services/updates.ts`):

- **Availability** — the GitHub REST API (`releases/latest`) + a `semver`
  compare; works in dev runs too. Offline / rate-limited / bad tags degrade
  to a "Couldn't check for updates" line with Retry — never a crash.
- **Delivery** — `electron-updater` (GitHub provider), only where the app can
  self-replace: the Windows NSIS install and the Linux AppImage. `.deb`
  installs and the (unsigned) macOS builds get an "Open releases page" button
  instead, as does any runtime updater failure.
- Both `semver` and `electron-updater` are devDependencies bundled into
  `out/main.js` by esbuild — the package still ships no `node_modules`.

The feed plumbing electron-updater needs: the `publish:` block in
`electron-builder.yml` makes electron-builder emit `latest*.yml` into
`release/` and embed `resources/app-update.yml` in each package (even with
`--publish never`), and `.github/workflows/release.yml` uploads
`release/latest*.yml` + `release/*.blockmap` so they land on the GitHub
Release next to the installers. Remove either half and in-app updates stop
finding releases.

## Embedded terminal (node-pty + xterm.js)

The Terminal toolbar button / ``Ctrl+` `` toggles a bottom panel
`WebContentsView` (lazily created in `app/main/windows.ts`; `layout()`
shrinks the mode views by `TERMINAL_HEIGHT` while it's shown). The renderer
(`app/renderer/terminal/`, `@xterm/xterm` + fit addon) talks to
`app/main/services/terminal.ts` over `term:toHost` / `term:toWebview`
(`app/preload/terminalPreload.ts`): one node-pty session shared by both
modes, spawned on first show in the current file's directory — PowerShell on
Windows, `$SHELL` elsewhere, overridable via **Settings ▸ Terminal Shell**
(`stateStore` key `terminalShell`) — kept alive while hidden, killed on quit;
the renderer offers an Enter-to-restart when the shell exits.

**node-pty is the app's only native module**, and the only `node_modules`
entry that ships in the package (see the `files` rules in
`electron-builder.yml`; `asar: false` means the `.node` binaries load
directly). It is N-API, so **no Electron-ABI rebuild step exists or is
needed** — Windows/macOS use the prebuilt binaries shipped in the npm
package, Linux compiles once during `npm ci` (GitHub runners and typical dev
boxes have the toolchain). Two consequences to keep in mind:

- `package.json`'s `allowScripts` must keep the `node-pty@…` entry — without
  it the install scripts are skipped and the binaries never materialize.
- The release workflow builds on **one runner per OS/arch**
  (`ubuntu-24.04-arm`, `windows-11-arm` for the arm64 targets): Linux needs
  a native compile and Windows assembles arch-specific ConPTY binaries at
  install time, so cross-arch packaging from a single runner is no longer
  possible.

**CSP note:** xterm.js injects `<style>` elements at runtime, so
`app/renderer/terminal/index.html` allows `'unsafe-inline'` styles — this
page only; every other page keeps the strict `style-src kkss:`.

## Text editor (CodeMirror 6)

The `editor` screen (`Screen = "home" | "editor" | Mode`) is a
`WebContentsView` with body bounds — the shell toolbar stays visible and the
terminal panel shares space with it. `app/renderer/editor/` bundles
CodeMirror 6 (`codemirror` basic setup + `@codemirror/lang-json`/`lang-python`
+ one-dark theme); all fs work lives in `app/main/services/editor.ts` behind
`editor:toHost` / `editor:toWebview` (`app/preload/editorPreload.ts`) — the
renderer never touches the filesystem. File ▸ Save / Save As route to the
editor when it's the active screen (`main.screen()`), and the in-page
CodeMirror keymap binds `Mod-s` for the focused case. Dirty handling: the
buffer survives screen switches (views are only hidden), so prompts fire only
on the destructive paths — window close (Save / Don't Save / Cancel) and
opening another file over unsaved changes. Like the terminal page, the editor
page allows `'unsafe-inline'` styles (CodeMirror injects `<style>` at
runtime).

## Settings menu

The **Settings** native menu (`app/main/menu.ts`) holds app-level
preferences persisted in `app/main/services/stateStore.ts`: **Color Theme**
(`sceneTheme` — the same key the mesh viewer's own theme toggle persists;
served to the mode views via their synchronous `initialState`, so it applies
when a view next loads a file) and **Terminal Shell** (`terminalShell`).
Viewer-level actions are deliberately absent from the menu bar — the
submodules' own toolbars provide them.

Key pieces (all under `app/`):

- **`app/preload/viewPreload.ts` + `app/renderer/view/shim.ts`** — the entire
  VS Code compatibility layer: `acquireVsCodeApi().postMessage` → IPC, and
  inbound IPC → a normal window `message` event.
- **`app/main/vscodeShim.ts`** — a minimal `vscode` module (dialogs, messages,
  file watcher, progress, `openWith`) that esbuild aliases in place of the
  real API, letting `mesh/src/{mdpaEditorProvider,vtkEditorProvider,
  meshExport,opHistory}.ts` run verbatim.
- **`app/main/cadHost.ts`** — a 1:1 port of `cad/src/provider.ts` (the cad
  provider imports OCCT directly, which must live in a worker here, so the
  cad side is ported rather than shimmed).
- **`kkss://` and `kkss-file://`** schemes — replacements for
  `asWebviewUri`/`localResourceRoots` (app assets and allow-listed user
  files respectively).
- **`tools/gen-webview-html.mjs`** — builds each mode's HTML page from the
  submodules' own markup modules (`viewerDom.ts`, `webviewChrome.ts`) at build
  time, so the DOM always matches what the extensions expect.
- **`app/renderer/theme/vscode-vars.css`** — the `--vscode-*` theme variables
  VS Code normally injects; `tools/check-theme-vars.mjs` fails the build if a
  submodule update uses one that is missing.

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

Screenshots are **generated, not hand-captured** — the same philosophy as the
cad submodule's `scripts/screenshots/` pipeline, but even more end-to-end:
`tools/screenshots.mjs` launches the real Electron app (Playwright-Electron)
on real example files from the submodules and captures the live windows at 2x
pixel density.

```bash
npm run build                          # once, so out/ is complete
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run docs:screenshots   # headless Linux
```

PNGs land in `doc/public/screenshots/` (committed, kebab-case) and the two
README heroes are refreshed in `images/`. Any change to the shell toolbar,
the generated webview pages, or visible viewer behavior means re-running this
— don't hand-edit the PNGs.

## Icons

`icons/` holds TikZ-drawn icon sources, mirroring the submodules' pipeline
(`pdflatex` + `pdftocairo` required — see `icons/README.md`):

- `tikz-ui/*.tex` → `svg-ui/*.svg` → the generated (and committed)
  `app/renderer/shell/shellIcons.ts` — monochrome `currentColor` shell
  toolbar icons, tinted by the surrounding element's color.
- `tikz-app/kkss.tex` → `icons/app/icon{,-256,-1024}.png` — the colored
  "split cube" application icon consumed by `electron-builder.yml` and the
  Linux window icon (`out/icon.png`).

Regenerate everything with `npm run build:icons` and commit the sources
together with the regenerated artifacts.

## Updating the submodules

Upstream improvements are inherited by bumping the submodule pointer:

```bash
git submodule update --remote cad    # or mesh
npm run build                        # rebuilds the bundle + re-runs check-theme-vars
npm test && npm run smoke            # protocol drift shows up here
git add cad && git commit -m "Bump cad submodule"
```

The typecheck imports the extensions' protocol types and the build re-greps
their stylesheets, so a breaking protocol or theming change fails loudly
rather than silently misbehaving.

If a change **inside** a submodule is ever unavoidable, commit it to a
dedicated branch in that submodule (e.g. `application-downstream`) and point
the KKSS gitlink there — never to the submodule's default branch.

## Releasing

Tag and push: `git tag v0.2.0 && git push --tags`. The release workflow
builds Windows/macOS/Linux installers and attaches them to a GitHub Release;
tags containing a hyphen (`v0.2.0-rc1`) are marked as prereleases.
