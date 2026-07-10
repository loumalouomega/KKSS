# Architecture & Building

## The shim architecture

KKSS reuses the two VS Code extensions **without modifying them**. Both are
already split into a browser-side webview bundle (whose only VS Code
touchpoint is `acquireVsCodeApi()`), vscode-free compute/parser modules, and a
thin vscode-coupled glue layer. KKSS replaces only the glue:

```
┌────────────────────────── BaseWindow ──────────────────────────┐
│ shell toolbar (mode toggle · Open · title · toasts)            │
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
