# Contributing to KKSS

## Prerequisites

- Node.js ≥ 18 (CI uses 20)
- git with submodule support
- Linux headless testing: `xvfb` (`sudo apt-get install xvfb`)

## Setup & build

```bash
git clone --recurse-submodules https://github.com/loumalouomega/KKSS.git
cd KKSS
npm ci                      # app tooling
npm run submodules:install  # npm ci in cad/ and mesh/
npm run build               # submodule bundles → app bundles → HTML gen → theme guard
```

| Script | What it does |
| --- | --- |
| `npm run build` | Full build (submodules + app) |
| `npm run build:app` | App only — use when nothing changed under `cad/`/`mesh/` |
| `npm run watch` | Rebuild app bundles on change |
| `npm start` | Full build + launch |
| `npm run start:fast` | App build + launch |
| `npm run typecheck` | `tsc --noEmit` over `app/`, `test/`, and everything they import |
| `npm test` | vitest glue tests in `test/` |
| `npm run smoke` | Headless end-to-end smoke test (`xvfb-run -a npm run smoke` on Linux) |
| `npm run dist` | Package installers into `release/` |
| `npm run build:icons` | Regenerate the TikZ icons (`icons/` — needs `pdflatex` + `pdftocairo`) |
| `npm run docs:screenshots` | Regenerate doc screenshots from the live app (headless: `env -u ELECTRON_RUN_AS_NODE xvfb-run -a …`) |

esbuild owns all emitted code; `tsc` is type-check only — the same convention
as both submodules.

## Project layout

```
app/main/        Electron main process (hosts, services, protocol, menu)
app/preload/     contextBridge preloads (the acquireVsCodeApi bridge)
app/renderer/    shell toolbar, picker, theme vars, view shim
icons/           TikZ icon sources → shellIcons.ts + the app icon (see icons/README.md)
tools/           build-time generators + guards + smoke test + screenshot capture
test/            vitest glue tests
doc/             VitePress documentation site (own npm package)
cad/, mesh/      git submodules — NEVER edited by app code
```

Doc/UI changes: follow `CLAUDE.md`'s "Keep docs in sync" section — doc drift
is part of the change, not a follow-up, and UI changes require re-running
`npm run docs:screenshots`.

Two invariants to preserve when changing the app:

1. **Zero submodule modifications.** The app consumes the submodules' built
   bundles and imports their vscode-free modules. The mesh providers run
   verbatim behind `app/main/vscodeShim.ts`; if a submodule update starts
   using a `vscode` API the shim lacks, extend the shim — don't patch the
   submodule.
2. **Heavy WASM stays off the UI thread.** OCCT/Gmsh run in
   `cadCompute.worker.ts`; MMG runs in the mesh submodule's own worker pair
   (`out/mmgWorker.js` must stay next to `out/main.js`, and the OCCT/Gmsh
   binaries under `out/cad-runtime/dist/` — both paths are contracts of the
   unmodified submodule code).

## Updating the submodules

```bash
git submodule update --remote cad     # or mesh, or both
npm run build                         # re-runs tools/check-theme-vars.mjs
npm run typecheck                     # protocol drift fails here
npm test
xvfb-run -a npm run smoke             # both modes end-to-end
git add cad mesh
git commit -m "Bump submodules"
```

If a change **inside** a submodule is unavoidable, do not commit to its
default branch: create a dedicated branch in the submodule (e.g.
`application-downstream`), commit there, and point the KKSS gitlink at it.

## Manual verification checklist

Headless CI covers the protocol handshakes (open STL/STEP/MDPA/VTK, geometry/
tree/model/vtkGroup/vtkFrame). Before a release, verify interactively:

- **CAD**: open `cad/examples/STP/bull.stp` — orbit/zoom, assign a part,
  apply an edit, `Ctrl+S` (sidecars written, CAD file untouched), Export to
  STL and reopen it, FE Mesh ▸ Generate, Export ▸ MDPA.
- **Mesh**: open `mesh/example/MDPA/double_arch.mdpa` — outline toggles,
  quality panel, an op + undo/redo, MMG remesh **and its Cancel**, Save As,
  screenshot. Open `mesh/example/VTK/Main_0_6.vtk` — timeline plays; copy a
  new step file into the directory and watch the timeline extend.
- **Chrome**: mode toggle preserves both views' state; `Ctrl+1`/`Ctrl+2`;
  menu File actions hit the active mode; `.stl` opens in the active mode.
- **Packaged app** (`npm run dist`): repeat one CAD and one mesh open from
  the installed layout — this catches WASM/worker path regressions.

## Releasing

1. Bump `version` in `package.json`, commit.
2. `git tag v<version> && git push origin master --tags`.
3. The release workflow builds Win/macOS/Linux installers and attaches them
   to a GitHub Release (hyphenated tags become prereleases).

The docs site deploys automatically on pushes to `master` touching `doc/`
(GitHub Pages source must be set to "GitHub Actions" once, in the repo
settings).
