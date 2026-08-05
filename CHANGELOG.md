# Changelog

All notable changes to KKSS are documented in this file. Dates are UTC and
match the GitHub release timestamps. See the
[GitHub Releases](https://github.com/loumalouomega/KKSS/releases) page for
full auto-generated compare links.

## [1.3.0] - 2026-08-05

- feat: **both modes now support several open documents at once**, each in
  its own tab. A new tab strip sits below the toolbar in Pre- and
  Post-Processing, with a **+** button and **File ▸ New CAD/Mesh Tab** to
  open a second document alongside the first — each tab keeps its own
  camera, edit history, and (in Post-Processing) its own Flowgraph session,
  fully independent of every other open tab. Close a tab with its **✕** or
  `Ctrl+W`; closing needs no confirmation, since neither viewer has an
  app-level "unsaved changes" concept (both autosave their sidecars).
  `Ctrl+O` keeps its existing behavior — it replaces the focused tab's
  document — so opening a *second* one is always an explicit action
- feat: a mesh exported from a Pre-Processing tab now opens in a **new**
  Post-Processing tab instead of replacing whatever the user currently has
  focused there
- chore: the AI chat sidebar's context now lists every open document per
  mode, marking which one is currently focused, instead of only the single
  file each mode used to have open

## [1.2.3] - 2026-08-04

- fix: **the multi-arch Docker image should now actually publish.** Both
  architectures have been building, booting and pushing cleanly since 1.2.2;
  what failed was the final step that merges them into one tag. The two
  registries were declared as two separate image exporters, and because each
  push carries its own provenance attestation naming that registry, the two
  manifest indexes hash differently — so the single digest the build reports
  was only ever valid in the second registry, and merging it into the first
  failed with "not found". Both registry names now ride on one exporter, which
  produces one digest valid in both

## [1.2.2] - 2026-08-04

- chore: **the Docker image still is not published for linux/arm64.** Its boot
  check fails on the native ARM runner while the same image, cross-packaged and
  run under emulation, starts cleanly — app process alive, X display up, window
  created, healthcheck green — so the cause is environmental rather than the
  arm64 artifact. The check used to dump the container's logs only *after* its
  assertions, so a failure reported nothing but `exit code 1`; it now always
  reports the container's state (including whether it was OOM-killed) and its
  last 100 log lines, and gives up as soon as the container exits rather than
  polling a dead container for two minutes. linux/amd64 builds, boots and
  scans cleanly

## [1.2.1] - 2026-08-04

- fix: **the 1.2.0 Docker image never reached the registries.** Its workflow
  referenced a `aquasecurity/trivy-action` version that does not exist, so both
  architecture jobs died during setup before building anything, and the
  Dockerfile tripped the new hadolint step (a pipe in a `RUN` without
  `pipefail`). The pipe is gone — GNU `find`'s `-print -quit` replaces
  `… | head -1` — and the scanner is pinned to a real release. The 1.2.0
  desktop installers were unaffected and published normally
- chore: the Dockerfile is now clean under hadolint at its strictest level:
  the `HEALTHCHECK` uses exec form, and `USER` is numeric (`1000:1000`) so a
  runtime that enforces non-root without reading `/etc/passwd` — Kubernetes'
  `runAsNonRoot`, for one — can still resolve it

## [1.2.0] - 2026-08-04

- feat: **the Docker image shrinks from 5.54 GB to 1.99 GB** (−64%, measured on
  linux/amd64). The Dockerfile is now multi-stage: one stage builds and
  packages the app with the project's own electron-builder config, and the
  final image carries only that packaged output plus the X/VNC stack — no npm,
  no source tree, and none of the ~730 MB of `cad/` + `mesh/` build-only
  dependencies
- feat: **images for linux/arm64 as well as linux/amd64**, published to
  **GHCR** (`ghcr.io/loumalouomega/kkss`) alongside Docker Hub. Each
  architecture builds on its own native runner and the two are merged into one
  multi-arch tag
- feat: **`docker-compose.ghcr.yml`** runs the published image with no
  checkout, no submodules and no build; both compose files now take
  `KKSS_PORT`, `KKSS_WORKSPACE` (a host path *or* a named volume) and
  `KKSS_TAG`, and `npm run docker:up:ghcr` / `docker:down` / `docker:logs`
  wrap them
- feat: the container **runs as the unprivileged `kkss` user** (uid 1000)
  instead of root, and the packaged app is root-owned and read-only to it.
  **Breaking:** settings moved from `/root/.config/kkss` to
  `/home/kkss/.config/kkss` — see the web-deployment guide for the one-command
  volume migration
- fix: the entrypoint now supervises every process it starts. Previously it
  waited only on Electron, so a dead Xvfb, x11vnc or websockify left the
  container "up" while serving nothing; it also forwards SIGTERM to its
  children, so `docker stop` returns promptly instead of waiting out the
  10-second SIGKILL timeout
- fix: install `x11-utils`. The entrypoint polls `xdpyinfo` to wait for the
  virtual display, but nothing provided it, so that readiness check was a
  silent no-op
- chore: the image's healthcheck now asserts the X display and the app process
  as well as the noVNC port; CI adds hadolint plus a Trivy scan, and checks the
  container is unprivileged and free of a leaked build toolchain

## [1.1.0] - 2026-08-04

- feat: bump the CAD submodule to 1.2.6 (from 1.0.5) and the mesh submodule to
  3.0.0 (from 2.8.3), bringing to **Pre-Processing** mode:
  - **Save / Load Preprocess…** — bundle a CAD file and its sidecars into one
    `.zip` and restore it later, now reachable from the native File menu. The
    archive carries a per-entry SHA-256 and a reader-version gate, and the
    reader rejects tampered entries, zip bombs and path-traversal names rather
    than half-restoring; KKSS also refuses to restore an archive to a
    destination whose extension doesn't match its source format
  - **Persistence that survives a reopen**: pinned measurements
    (`<model>.annotations.json`) and the camera / display mode / projection /
    clip plane (`<model>.view.json`), plus a real XCAF assembly structure in
    the Components tree and external-change reconciliation for the source and
    every sidecar
  - **Configurable B-rep tessellation** (Draft / Standard / Fine) and a cached
    parse: an interactive edit now replays against a cached base shape instead
    of re-reading the file — measured at ~14× faster on the bundled STEP
    fixture (1511 ms → 104 ms)
  - **Smooth-edge classification**, so patch seams can be hidden
  - **A new import route**: `.vtk`/`.vtu`/`.med`/`.cgns`/`.exo`/`.xdmf`/`.mdpa`
    open in CAD mode as boundary surfaces through meshio++, with named regions
    turned into Parts and any scalar point/cell field usable to colour the
    model. Opening one normally still lands in Post-Processing, which reads
    them natively — use Pre-Processing's own Open… dialog (or drag-and-drop)
    for the geometry-only import
  - **Unit conversion on export** (mm/cm/m/in/ft), for the model Export command
    and the FE Mesh panel alike — a real geometric scale, with STEP/IGES header
    units written to match — plus **MED, CGNS and XDMF** mesh targets Gmsh's
    own writers cannot produce
  - **Measurement, mass properties and markup**: distance/length/angle/radius
    with an ⟟ Exact button that recomputes against the true OCCT geometry,
    volume/area/centre-of-mass/inertia for the model or one entity, and a
    freehand/line/arrow/rectangle/circle annotation layer baked into
    screenshots
  - **Toolbar dropdowns and display modes**: Fit/Tree/FE Mesh plus View ▾ /
    Select ▾ / Measure ▾ / Markup ▾, five whole-model render modes, a capped
    clipping plane, exploded view, per-part isolate/hide with a tree filter,
    and an orthographic/perspective toggle
  - **Mesh quality statistics** with the worst elements highlighted through the
    model, hex-dominant meshing, and best-effort **entity-id rebinding** so a
    Part survives a topology-changing edit elsewhere in the model
  - **Screenshot to PNG** (`Ctrl+Alt+P`, shared with post mode)
- feat: and to **Post-Processing** mode:
  - **A unified interface** with the CAD viewer, built on a shared design-token
    layer: solid pill buttons, a distinct sidebar column, one dropdown recipe,
    a redesigned nav card and orientation cube, and one floating-panel chrome
  - **Inspect**: click any node/element/condition to read its id, block,
    SubModelPart membership and every field value at it, with a Measure
    sub-mode between two nodes
  - **Threshold** field mode, a component selector, lockable colour ranges, log
    scale, discrete bands, 12 colormaps and an in-scene scalar bar; per-layer
    opacity; **Lighting…** and **Camera Bookmarks…**; and an oblique **Free**
    clip normal
  - **meshio++ 9.9.0**: `.med` becomes a writable format, and SubModelParts now
    survive an export to MED (families), Abaqus (`*NSET`/`*ELSET`) and — block
    names — Exodus; CGNS and Exodus keep field data they used to drop
- feat: the native File menu gains **Save Problem…** (`Ctrl+Alt+S`), **Load
  Problem…** (`Ctrl+Alt+O`) and **Screenshot…** (`Ctrl+Alt+P`) — the mesh
  viewer's own in-view File menu moved into a menu bar that KKSS hides in
  favour of the native one, so those entries live here now
- feat: **Settings ▸ CAD Viewer Defaults** — up axis, default mesh-size preset,
  B-rep tessellation quality, and grid/axes on open, seeding each newly opened
  CAD document
- feat: the AI chat sidebar's system prompt describes CAD-Preview's 23 tools
  (from 13) — mass properties, inspect/measure/measure_exact, interference
  checks, model comparison, render snapshots, standard-part search, parametric
  scripts — and the mesh server's MED writer and time-step support
- fix: `check-theme-vars` now scans mesh's `design-system.css` and additionally
  guards `--ds-*` token closure, so the layer `style.css` depends on can't go
  missing silently
- chore: patch every open Dependabot advisory in both lockfiles (`undici`,
  `ip-address`, `fast-uri`, `postcss`, `hono`, `tar`, `brace-expansion`) — all
  dev/build-time except `fast-uri`, which ships bundled via the MCP SDK

## [1.0.8] - 2026-07-28

- feat: bump the mesh submodule to 2.8.3 (from 2.2.0) and the CAD submodule to
  1.0.5, bringing to Post-Processing mode:
  - **10 new mesh operations**, in six collapsible sidebar subcategories:
    smoothing (Taubin/Laplacian), RCM/Morton/Hilbert renumbering,
    space-filling-curve partitioning, uniform refinement, quadratic → linear,
    simplexify, box/plane crop, a safe formula field calculator with
    nodal ↔ elemental averaging, and mesh merging with an optional
    coincident-node weld — all undoable, saveable as recipes, and reachable
    from the `mesh_transform` MCP tool
  - **SPHERE / particle meshes**: one-node elements render as real sphere
    glyphs scaled in model space, with a suggested radius for the usual
    radius-less DEM/peridynamics file and an undoable **Set element radius**
    operation that creates or scales the field
  - **Face normals** for spotting inverted elements, and **Export skin…** —
    the boundary of a mesh's volume cells as a standalone surface mesh (also
    the new `mesh_extract_skin` MCP tool)
  - **Expression-driven remesh sizing**: MMG's new `size = ƒ(h)` mode sets each
    node's target size from a formula over the nodal size, the whole-mesh size
    statistics and the coordinates, with per-SubModelPart overrides
  - **New formats** via meshio++ 9.3.0 (from 6.6.1): Exodus II `.e`/`.exo`/
    `.ex2` (read + write, with the time steps stored *inside* the file driving
    the timeline), CGNS, MOAB `.h5m`, `.hmf`, and read-only Salome `.med` — 39
    read / ~35 write formats in total. Named groups (Gmsh physical groups,
    Abaqus sets, Exodus element blocks / node sets / side sets) now arrive as
    SubModelParts
  - **Toolbar cleanup**: Mesh Size moved into a new **Advanced** menu alongside
    Spheres…, Face normals and Export skin…
- feat: the vscode shim now implements `window.showQuickPick` (routed to the
  app's own modal picker), which is what the new Export skin… flow uses to
  choose its output format
- feat: the AI chat sidebar's system prompt describes the new formats,
  operations and Exodus time-step selection, so the assistant can use them
- fix: define the `--vscode-inputValidation-error{Border,Foreground}` theme
  variables the mesh viewer's expression-validation styling needs
- security: pin `fast-uri` ≥ 3.1.4 (GHSA-v2hh-gcrm-f6hx, host confusion via a
  literal backslash authority delimiter) and `@hono/node-server` ≥ 2.0.5
  (GHSA-frvp-7c67-39w9, `serve-static` path traversal on Windows via an encoded
  backslash) through npm `overrides`. Both arrive via
  `@modelcontextprotocol/sdk`, whose own ranges still admit the vulnerable
  versions, and both are bundled into `out/main.js` — so they shipped in the app

## [1.0.7] - 2026-07-18

- feat: show a "What's New" dialog automatically when the app is launched
  after a version upgrade, listing the CHANGELOG.md entries since the last
  version you ran; reopen the full history any time from **Help ▸ What's
  New…**

## [1.0.6] - 2026-07-18

- feat: bump the mesh submodule to meshio++ 6.6.1, adding read support for
  EnSight Gold (`.case`/`.geo`) and Triangle (`.poly`) meshes and export to
  the write-only SVG/TikZ figure formats (a new "Figures" export menu group)
- docs: format counts and lists updated across README.md, doc/, CLAUDE.md,
  and the AI chat sidebar's system prompt to reflect the 32 read / 29 write
  meshio++ formats

## [1.0.5] - 2026-07-18

- ci: publish the streamed-desktop Docker image to Docker Hub as
  [`vmataix/kkss`](https://hub.docker.com/r/vmataix/kkss) (`X.Y.Z` +
  `latest`, linux/amd64) on release tags, gated on the boot healthcheck (#22)
- docs: the web-deployment guide and README now lead with the prebuilt-image
  quickstart (`docker run vmataix/kkss:latest`)

## [1.0.4] - 2026-07-18

- feat: run KKSS in the browser via Docker — the unmodified desktop app runs
  headless (Xvfb + SwiftShader) and is streamed with x11vnc + noVNC on port
  6080 (`docker/Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`,
  `npm run docker:build` / `docker:up`); single-user/demo scope
- ci: add a Docker workflow that builds the image and boot-checks it (noVNC
  answering + Electron process alive)
- docs: new web-deployment guide (`doc/guide/web-deployment.md`) covering
  quickstart, volumes, environment variables, and security caveats

## [1.0.3] - 2026-07-18

- ci: fix the smoke test's CAD case spuriously failing Playwright's own
  `electron.launch()` timeout — it was hardcoded to 60s, shorter than the
  case's own 90s deadline, so the heavier OCCT+WebGL boot could never use
  its full budget

## [1.0.2] - 2026-07-17

- ci: make the smoke test robust to the headless-GPU render crash

## [1.0.1] - 2026-07-17

- Version bump only; no functional changes since 1.0.0.

## [1.0.0] - 2026-07-17

- Sync cad/mesh submodules (v1.0.3 / v2.1.0) and add an interface-scale
  control (zoom presets, `Ctrl +`/`Ctrl -`/`Ctrl+Shift+0`) (#21)
- ci: force software WebGL (ANGLE+SwiftShader) for the smoke test and retry
  mesh smoke cases

## [0.9.1] - 2026-07-16

- chore: add Dependabot configuration and apply its first batch of dependency
  bumps (GitHub Actions, `@xterm/xterm`, `@xterm/addon-fit`, `chokidar`,
  TypeScript, `@types/node`) (#7-#17)

## [0.9.0] - 2026-07-16

- feat: add support for 25+ extended mesh formats via meshio++ integration
  (#18)
- chore: sync cad/mesh submodule references

## [0.8.0] - 2026-07-16

- chore: bump dependencies for the 0.8.0 release
- Add Ko-fi username for funding support

## [0.7.0] - 2026-07-14

- feat: introduce `McpHub` for shared MCP server management, and add an
  optional HTTP meta MCP server for external LLM clients
- feat: add OS glyphs for the download page; refactor and clarify
  documentation

## [0.6.0] - 2026-07-14

- feat: integrate the Flowgraph node-editor problemtype (#6)
- chore: relicense the project from GPL to AGPL-3.0-only (required by the
  AGPL-3.0 Flowgraph dependency)
- docs: add the end-to-end verification skill for the KKSS Electron app

## [0.5.0] - 2026-07-13

- feat: implement one-way sync of mesh exports from CAD/pre mode into post
  mode (#5)
- feat: add a `gmsh-wasm` alias for the CJS build to support top-level await
  in the ESM entry point

## [0.4.0] - 2026-07-13

- Add tests for chat services and update dependencies (#4)

## [0.3.3] - 2026-07-12

- fix: use system `fpm` for arm64 `.deb` packaging

## [0.3.2] - 2026-07-12

- fix: disable hard-link copying in the package installers step

## [0.3.1] - 2026-07-12

- feat: clean the release directory before packaging installers

## [0.3.0] - 2026-07-12

- feat: add an embedded terminal using node-pty and xterm.js, with a hide
  option
- feat: add a text editor with CodeMirror integration, and "open current file
  in text editor" support
- feat: add a config-driven home screen menu
- feat: add VS Code tasks for building and installing KKSS locally on Windows
- docs: enhance documentation, update icons, add logo and license/copyright
  information (#3)

## [0.2.0] - 2026-07-10

- feat: enhance the release workflow and documentation for multi-architecture
  support

## [0.1.0] - 2026-07-10

- Initial public release: CAD-Preview and VSCode-MDPA-Preview embedded as git
  submodules, icon assets, and base build scripts

[1.3.0]: https://github.com/loumalouomega/KKSS/compare/v1.2.3...v1.3.0
[1.2.3]: https://github.com/loumalouomega/KKSS/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/loumalouomega/KKSS/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/loumalouomega/KKSS/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/loumalouomega/KKSS/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/loumalouomega/KKSS/compare/v1.0.8...v1.1.0
[1.0.8]: https://github.com/loumalouomega/KKSS/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/loumalouomega/KKSS/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/loumalouomega/KKSS/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/loumalouomega/KKSS/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/loumalouomega/KKSS/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/loumalouomega/KKSS/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/loumalouomega/KKSS/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/loumalouomega/KKSS/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/loumalouomega/KKSS/compare/v0.9.1...v1.0.0
[0.9.1]: https://github.com/loumalouomega/KKSS/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/loumalouomega/KKSS/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/loumalouomega/KKSS/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/loumalouomega/KKSS/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/loumalouomega/KKSS/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/loumalouomega/KKSS/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/loumalouomega/KKSS/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/loumalouomega/KKSS/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/loumalouomega/KKSS/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/loumalouomega/KKSS/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/loumalouomega/KKSS/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/loumalouomega/KKSS/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/loumalouomega/KKSS/commits/v0.1.0
