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
  (`app/main/router.ts`).

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
is copied verbatim from mesh so the family stays visually consistent). The
**app icon** is `icons/tikz-app/kkss.tex` (the colored "split cube": blue CAD
half, orange mesh half) → `icons/app/icon{,-256,-1024}.png`, consumed by
`electron-builder.yml` and copied to `out/icon.png` for the Linux window icon.
Regenerate with `npm run build:icons`; commit sources + regenerated artifacts
together.

## License

KKSS is **GPL-3.0** because it distributes the GPL-2.0-or-later CAD-Preview
engine (whose WASM statically links Gmsh + OpenCASCADE) together with the
MIT-licensed mesh engine. Before adding any dependency that ships in the
packaged app, check GPL compatibility first (same rule as cad's CLAUDE.md).
