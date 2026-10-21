# Changelog

All notable changes to KKSS are documented in this file. Dates are UTC and
match the GitHub release timestamps. See the
[GitHub Releases](https://github.com/loumalouomega/KKSS/releases) page for
full auto-generated compare links.

## [2.20.1] - 2026-10-21

- fix: **the Hono dependency is patched.** `GHSA-5r4p-p66f-jhc7` — Hono's `serveStatic` decoded the request path a second time, so middleware could be bypassed on static paths — affects every Hono below 4.13.11. The override now requires `^4.13.11` and the lockfile resolves 4.13.13.

## [2.20.0] - 2026-10-21

- fix: **the streamed-desktop image is clean again.** The Trivy scan that gates every branch and release stopped the build on a HIGH finding inside the Caddy binary the image ships: `github.com/klauspost/compress` v1.18.6 (CVE-2026-63209 — integer overflow in the dictionary processing). The pinned Caddy release still requires that vulnerable module, so the Dockerfile's Go module overrides now also require the patched `klauspost/compress` v1.18.7, the same treatment the other pinned modules already get. The Go builder image moves to 1.27.3 as well — the 1.27.2 toolchain carries the crypto/x509 advisory CVE-2026-111943 in every binary it builds, so both the Caddy binary and the web broker are built with the patched 1.27.3.
- fix: **the manual builds with a patched Vite.** The last open Dependabot alert was `vite` ≤ 8.2.3 in the manual's lockfile (GHSA-698v-4r3x-3vcv — `launch-editor` did not escape `%` when passing an argument to `cmd.exe` on Windows, so a crafted filename could run a command). `doc/package.json` overrides `vite` to ≥ 8.2.4 and the lockfile resolves the whole Vite tree to the patched release; `npm audit` in `doc/` is clean.

## [2.19.0] - 2026-10-20

- feat: **OpenSCAD with no install.** `.scad` sources are evaluated by a bundled OpenSCAD WebAssembly build (Manifold backend) inside the compute worker — opening, the Customizer panel, meshing, measuring and exporting a `.scad` file, plus the assistant's `list_scad_parameters`/`convert_scad`, all work with nothing on `PATH` (verified: the WASM output is byte-identical to the installed binary on the minimal fixture, and `convert_scad` answers `supported:true` with no `openscad` binary installed). The user-installed binary stays as the fallback for declined constructs (`import()`/`surface()`, a missing include, over the staging caps). New [OpenSCAD walkthrough](doc/guide/tutorial-openscad.md) with a committed `bracket.scad` example and two app captures; the OpenSCAD Binary setting now configures the fallback only.
- feat: **B-rep saves are recoverable.** STEP/IGES/BREP bakes run inside the same save journal as STL/OBJ/PLY (shared `saveRecovery` module), so an interrupted save is repaired on the next open instead of replaying edits twice; a recovered B-rep save warns that highlights may need re-checking.
- feat: **measured boundary layers, meshio facts, section views.** A 2-D generate reports achieved boundary-layer rows per wall Part (shown on the Part's Layer row, recorded in export manifests); mass properties, measurement and model comparison accept meshio-only sources as marked surface-derived facts; drawing sheets take section views with hatched cut loops. The `splitFace` edit op splits one face into two Part-addressable regions, and `generate_mesh` takes view-driven `sizeField` samples.
- feat: **compare study runs.** Home **Compare runs** renders a facts-only Markdown report for two runs of one study (verdict, identity table, setting diffs, changed/one-sided/unverified outputs) over the shared `compareRuns` core, also exposed as `app__run_compare` (read); incomparable pairs render their problems. OpenFOAM in-place save now covers multi-region cases (per-region rewrite), decomposed cases (native re-partition) and zone files; RANS cases write the wall y+ monitor as condition data on the wall part; the wind-tunnel estimate is refit on measured runs.
- chore: CAD-Preview 3.24.0 → 3.26.0, Mesh-Preview 5.16.0 → 5.17.0, meshio++ 17.8.0 on both sides (additive only, no format-key change).

## [2.18.0] - 2026-10-19

- docs: the tutorial figures are regenerated from the solver output that b9f83b1 stopped shipping. A capture pipeline in `tools/tutorials/` (results provider, screenshot catalog, viewer capture helpers, gallery) produces field and plot shots from the recovered frames and the restored plot recipes (each checked against its published CSV); setup cards, the exported mesh and the case's problemtype setup are captured by `manual.mjs` with no solver run.
- docs: the tutorial pages are rewritten around one skeleton (At a glance, the physical model, the setup, how to read the results, verification, troubleshooting), with a shared guide to reading a result in KKSS. The verification and glance sections are generated from each case's published record by `writeDocs.mjs`, which `test/tutorialDocs.test.ts` checks for currency, image references, alt text, the catalog and links.
- fix: the eigenmode verification reports each relative frequency error as the error (3.7 % and 0.5 %) rather than the frequency.
- docs: the two-fluid dam break is solved, not generation-only. It is a 1 m x 0.8 m water column against the wall of a 4 x 1 m tank, open at the top (an atmospheric outlet at zero pressure), under gravity. The level set is the exact signed distance to the column, set from its geometry, because measuring against the water face put zero on every water node. A one-file alias (`navier_stokes_two_fluid_solver.py`) lets the stock Kratos 10.4.3 serial wrapper start; the published README says how to create it. The record checks the water area (within 0.53 %), the front (1.15 m in 0.5 s), the outlet pressure (exactly zero) and finite fields over 20 frames.
- docs: the eigenmode tutorial solves once. The published case had repeated the identical solve eleven times; its time step is now one second, so the run writes one `EigenResults` file with the same three modes and frequencies.
- docs: the eigenmode figures come from the solver's raw eigenvector records, written as VTK by `tools/tutorials/eigenModes.py`. The viewer's GiD binary reader misreads those records in this build (most nodes come back as zero or another node's value); the reader fix belongs upstream, so the eigenmode page says so.
- docs: every tutorial shows its CAD window after FE Mesh Generate, the wind tunnel adds mid-plane velocity and pressure figures, and `results.mjs` can solve a missing case into a scratch folder (`KKSS_TUTORIAL_SOLVE=1`).
- docs: the two-fluid dam break and the virtual wind tunnel tutorials show their own figures from the app: the two-fluid velocity, DISTANCE and pressure fields with an animation, and the six wind tunnel wizard steps.
- fix: the FSI and CoSimulation verifier keeps the structure displacement minimum (a later assignment erased it), so both records carry the minimum and the maximum.
- fix: the tutorial publish step removes absolute machine paths from the published recipes, records and README files, and keeps the verification input hashes in step with the scrubbed bytes.
- docs: the tutorials are grouped in the sidebar; the RANS, wind-tunnel, two-fluid and eigenmode pages describe the physics, the setup choices and the results that the published records support.

## [2.17.0] - 2026-10-18

- feat: tutorial physics for the new problemtypes, solver-verified end to end where the stock solver allows: **turbulent obstacle flow (RANS k-epsilon)** — the laminar channel with a 16-sided obstacle at 1 m/s in air (Re 7917), log-law wall function (mean wall y+ 32.8, Cd 1.77, drag vs momentum balance 11.7%); **cantilever eigenmodes** — the laminar cantilever's first bending frequencies vs Euler–Bernoulli (3.7%/0.5%, 10% tolerance); **virtual wind tunnel** — the wizard's sphere tunnel as a pipeline case (steady k-omega SST, planned vs solved y+, recorded Cd); and the **two-fluid dam break** as generation-verified with its solver run blocked by the upstream Kratos bug it records (`navier_stokes_two_fluid_solver` doesn't ship; kept out of `tutorial-cases.zip`). New `tutorial-rans`, `tutorial-eigen`, `tutorial-wind-tunnel` and `tutorial-two-fluids` pages (geometry/setup/results captures via the manual flow), eleven rows on the landing page, and the RANS/LinearSolvers wheels in the Kratos lockfile, Dockerfile and license check.
- feat: Tier 0 integration for cad 3.22.0 + mesh 5.15.0: mmgs heal auto-decimate, remesh field adaptation, Manifold boolean kernel staged to all three runtimes (probed live: a headless mesh-hole bake closes at the analytic volume), the Materials table-preview command, and the `wind_tunnel_plan`/`wind_tunnel_generate` chat tools (292 policy rows).
- fix: mesh skin extraction no longer doubles triangles where boundary Conditions meet volume faces (opposite winding, zero-volume soup) — the wind-tunnel body carve and STEP fidelity measurement both depend on the single-covered skin.

## [2.16.0] - 2026-10-17

- feat: the **Help menu** gains the two windows it was missing: **KKSS Manual…**
  opens the full documentation site inside the app (`kkss://docs` — the built
  site staged to `out/docs/` by every build, its ~100 MB of downloadable
  examples left online with their links rewritten to the published site), and
  **License…** shows the repo's AGPL-3.0 license text beside the existing
  What's New and About dialogs (and the Online-documentation and submodule
  links). The manual window is a normal resizable singleton window; internal
  VitePress navigation stays in the window, example/outside links open in the
  OS browser; a dev checkout without `npm run docs:build` gets a one-command
  fallback page instead of an error. Pinned by `test/docsServe.test.ts`
  (path-traversal guard, example-link rewrite, site-base agreement with the
  built dist) and `test/helpMenu.test.ts` (menu order + i18n in en/es).
- fix: the release workflow installs the manual's dependencies (`npm ci --prefix doc`)
  before building the in-app manual. The v2.15.0 tag's release run failed at that
  step and published nothing, so this release is the first published build of the
  2.15.0 code, along with the Help menu above.

## [2.15.0] - 2026-10-17

- feat: **mesh → CAD** (the meshioplusplus 17.2.0/17.3.0 update, embedded at CAD
  Preview 3.20.0 and Mesh Preview 5.14.0). CAD mode's Mesh Health panel gains
  **Fit to CAD…**: a clean closed skin is segmented and each patch replaced with
  an exact analytic face (plane/sphere/cylinder/cone/torus, rolling-ball fillets
  and blends, chamfers, vertex blends, threads) or a freeform B-spline where
  nothing fits — sewn and B-rep-checked by OpenCASCADE and saved as a new AP214
  STEP, with the fit's own report on the status line. The `cad__fit_mesh_to_cad`
  MCP tool runs the same chain with the solid's `.cad.json` B-rep side channel,
  which the new `iga_sample`/`iga_refine`/`iga_evaluate` tools read and refine
  exactly. Mesh mode's `.step` export **auto-fits** the same way (with a
  `<stem>.cad.json` companion and a kernel-defaults/analytic-only/skip-fitting
  ask), optimization runs gain **Export Optimized Geometry as CAD…**, and a
  **mesh → CAD** walkthrough with downloadable example files ships in the docs.
- feat: expanded format surface on meshio++ 17.3.0 (64 readable / 53 writable
  extended formats; 108 packaged associations): STEP/IGES reads and a
  `.step`-with-fitting writer in Post-Processing, glTF/GLB reads, binary Medit
  `.meshb`, libMesh `.xda`/`.xdr` (+ gz/bz2) and Kratos CAD JSON in CAD mode,
  and the new solver-result pair — Marc `.t19`, FEBio `.xplt`, MAPDL `.rst`,
  Tecplot binary `.plt`, Abaqus `.fil`, LS-DYNA `.d3plot` — as both imports and
  FE-mesh export targets. Zstd/lz4-compressed `.vtu` files and bzip2 libMesh
  reads fall back to the full wasm artifact (staged beside the lean one) with a
  stated diagnostic; OpenFOAM exports keep their Nodal fields in time-zero.
- feat: a new [Mesh to CAD walkthrough](doc/guide/tutorial-mesh-to-cad.md) with
  `doc/public/examples/fit-cad/` example files (100,000-triangle sphere →
  one exact spherical face → refined NURBS), generated live through the
  bundled servers and linked from the mode guides; new README/Index feature
  rows, format counts updated across the guides.

## [2.14.0] - 2026-10-16

- feat: the FSI tutorial reproduces the **Mok benchmark** (Mok 2001, Valdés 2007;
  Kratos' `fsi_mok` validation case) through the app's own pipeline — CAD polyline
  channel with a 28-station convergent ramp sampled from the benchmark boundary,
  conformal two-face meshing, partitioned MVQN coupling — instead of the former
  channel-slab model. Wall-tip peak 7.79 cm at 8.5 s (published 8.3 cm at ~9.5 s)
  settling to 5.81 cm at 25 s (published 6.2 cm); inlet profile, outlet pressure
  and ALE area-balance checks all pass. The case runs Δt = 0.05 s (the published
  Δt = 0.1 s diverges the structure solve at t ≈ 4 s on Kratos 10.4.3).
- feat: fluid inlets accept a symbolic **modulus expression** and an activation
  window, so two inlet assignments write a two-phase inlet. Recorded cases
  regenerate byte-identical process blocks.
- feat: planar multi-face models mesh conformally (CAD): the surface fragment
  merges the coincident boundaries the STEP importer duplicates per face, so
  shared interface edges carry one node set and no orphan conditions.
- docs: the CoSimulation tutorial keeps the channel-slab case with a self-contained
  write-up (it no longer defers to the FSI page) and 200× display warp; both
  coupled tutorials gain fresh captures and wall-tip/pressure plot recipes.

- feat: CAD Preview 3.18.0's **Printability panel** (Advanced ▸ Analysis) and its
  `check_printability` tool: an overhang limit and build direction, a bundled process
  (fdm/sla/sls/mjf, each naming its source) and build plate, per-body sampled wall
  thickness, per-direction overhang area, plate contact and a support-volume upper
  bound, the overhang faces coloured in the view, and every rule it cannot measure
  under **Not checked** — facts against the numbers, never a verdict.
- feat: **AMF** (`.amf`, plain XML or the zipped container) joins 3MF and Collada as a
  display-only import: three's `AMFLoader` builds the scene, material and mesh colours
  arrive as native colours (a Part colour still wins) and the file's declared unit
  seeds the Units dropdown. It exports on to STL/OBJ/PLY/glTF/3MF, and every
  host-side triangle operation refuses it by name. Registered as a native file
  association.
- feat: mesh 5.12.0's **Convert Results to Other Formats…** — the File-menu item, the
  Problemtype form's Output ▸ also export as (saved as `output.exportFormats`) and the
  `case_export_results` tool convert a case's `vtk_output/` frames through meshio++
  (an XDMF/PVD packs the series into one file, other formats write one file per step
  under `converted/`), automatically when a run finishes. The quick-pick window gained
  a real multi-select mode for it (Space/click toggles, Enter confirms, Esc cancels).
- feat: mesh 5.12.0's `plot_run_resolve`: explicit ownership resolution for one result
  path — `verified` only through an execution receipt that still verifies, otherwise
  `unverified`/`unresolved` statuses that can never stand in as a run binding.
- feat: CAD Preview 3.18.0's **Copy reference** appends a stored query for faces
  produced by topology-changing edits (so a pasted reference survives renumbering), and
  curve ops take a `coincident: reuse|independent` choice when an endpoint lands on an
  existing point (Collapse shares the vertex). mesh 5.12.0's **Plot distribution** opens
  the Plots pane on a field's histogram (uncovered entities are excluded and reported,
  never counted as 0), **Show on mesh** colours the view by a plot quantity/component,
  and a persistent plot cache with streamed table import keeps large plots quick.
- chore: meshio++ **17.2.0** (mesh's `^16.42.0` → `^17.2.0`; CAD still declares
  `^16.42.0` and resolves the same staged tree, so the skew is back — the bundled
  CAD/mesh MCP runtime tests are the gate). The three new tools are classified
  (`cad__check_printability` and `mesh__plot_run_resolve` read, `mesh__case_export_results`
  write, path-scoped), and the bundled drawing-sheet templates the chat's
  `list_sheet_templates` reads are now staged alongside the starter process limits.

- feat: mesh 5.11.0's **new problemtype families** — four **ROM** reduced-order-model
  trainers (Structural Mechanics, Convection-diffusion, Fluid Dynamics, Potential Flow;
  RomApplication's `RomManager`: POD basis and optional HROM over a sampled parameter
  space) and **Structural Optimization** (OptimizationApplication: mass / strain-energy /
  centroid / discrete-value responses, material, shell-thickness, vertex-morphing shape
  and SIMP topology controls, with gradient, Nesterov, Adam and projection algorithms).
  Documented with worked examples in the new [Kratos Problemtypes](doc/guide/problemtypes.md)
  guide and live captures.
- feat: mesh 5.11.0's **coupling upgrades** — CoSimulation keeps weak coupling and gains
  **strong coupling** (iterated to a residual criterion with MVQN/IQN-ILS/Aitken
  acceleration), several **interface pairs** and optional **ALE mesh motion**; FSI and
  CoSimulation are available as Python-language (`coupled.py`) workspace problemtypes with
  per-step coupling records in the convergence history.
- feat: mesh 5.11.0's required-application preflight: every generated driver checks the
  Kratos applications it needs before running, **Run** asks the configured Python first
  and refuses naming the missing ones, and `case_validate` reports `applications` (with an
  optional import probe) without running anything.
- feat: KKSS's `openLatestResults` hook learned mesh 5.11.0's **`outputFolder`** option, so
  the Optimization progress panel's **Design fields** button opens the per-iteration design
  fields timeline in the folder the case's `optimization_parameters.json` names (instead of
  degrading to a "no results" toast for a `vtk_output/` that an optimization case never
  writes) — the same no-results toast now names the folder it looked at.
- feat: CAD Preview 3.17.0's **FE Mesh quality gate**: the panel grades the last
  generated mesh against caller-supplied meshio++ threshold clauses (scaled Jacobian,
  aspect ratio, skewness, angles…), reporting per-clause violations, fractions, worst
  value and cell — facts against your numbers, never a verdict. The CAD host keeps the
  last generated MSH text per document, as upstream does.
- feat: CAD Preview 3.17.0's per-**Part material density** (g/cm³) driving BOM/solid mass,
  mesh-source `render_snapshot` via meshio++'s software rasterizer, `segment_mesh_surface`
  (patch segmentation with primitive fits), and the **Geometry display mode** with its
  entity-type legend.
- feat: meshio++ 16.42.0 (both submodules — the earlier minor skew is closed): the
  isoparametric `tessellate` mesh operation, a new readable/writable **Kratos CAD JSON**
  `.cad.json` format (now a native file association), and Abaqus `.fil` / MSC Nastran
  `.op2` result-file writers — 61 readable / 49 writable extended formats.
- docs: a new **Kratos Problemtypes** guide documenting the whole catalog with the
  application preflight contract, setup collections (responses/controls/parameters), the
  FSI/CoSimulation pairing rules, and ROM/optimization workflows — with screenshots
  generated from the real app on an upstream example case.

## [2.13.0] - 2026-10-14

- feat: integrate **CAD Preview 3.16.0** and **Mesh Preview 5.10.0**. Pre-Processing
  opens and exports **3MF**, reads **Collada** (import-only, no writer), and gains a
  **clash clearance** (a minimum distance in mm beside the intersection), a
  `unifySameDomain` edit op, snapshot display modes with section clip, `tessellationQuality`
  on hit-testing and model comparison, opt-in **deterministic exports**, an optimistic
  revision guard on MCP sidecar writes, a Hausdorff cross-check on deviation maps, and
  inconsistent-winding reporting in mesh health. Both new formats are **display-only on
  the host** (Three.js loads them in the viewer; the kernel has no triangle parser), so
  every triangle-dependent operation refuses them by name instead of silently misreading
  them, and both are registered as native file associations.
- feat: an **OpenSCAD Customizer panel** in the CAD viewer: it parses a `.scad` source's
  parameters from text alone, validates the entered values against the live source,
  persists them in a new `<model>.scad-params.json` sidecar, and replays them as `-D`
  defines on every later conversion. The sidecar travels in the preprocess archive both
  ways and syncs with the document like every other CAD sidecar. The `.scad` source file
  itself is never written.
- feat: `color()` in an OpenSCAD source becomes real **Parts**, so colour groups are
  addressable for meshing and selection. It only happens when the document has an
  edit-free replay tail and no Parts yet — a user's own grouping always wins.
- feat: a **command line** in the mesh viewer (`/` to focus, `?` for help) runs every
  operation and UI action as text, with the same undo history as clicking, chaining with
  `;`, and an in-place explanation when it rejects an operation.
- feat: **OpenFOAM cases save in place**, writing back into the case rather than the
  0-byte marker — only the files it can own (just `points` for a coordinate change,
  the six polyMesh files for a topology change) and refusing by file name when anything
  else is keyed to the old numbering. Multi-region, decomposed and zone-bearing cases are
  now read as well, and the preview names the files it will write before it does.
- feat: **cancellable mesh reads.** Opening an extended-format file, moving through a
  timeline or probing metadata now runs in a dedicated worker (the **Cancel** button on
  the loading card appears), as do parsing and derived exports.
- feat: five **plot presets** — section comparison, volume total, tensor components,
  heat-flux balance and table relationship — plus a threshold check, a series diff and an
  exterior-boundary option for region operations, all reachable from the new
  `mesh__plot_preset` tool (classified `write`, like its `plot_dataset` twin).
- feat(settings): **Settings ▸ Mesh Viewer ▸ Plot Extraction Cache** keeps a bounded
  on-disk cache of disk-backed plot extractions, so reopening a plot after a restart does
  not reread its files.
- chore: bump meshio++ to **16.41**. mesh now locks a minor ahead of CAD's `^16.31.0`;
  KKSS stages one shared tree that both engines resolve, and the bundled CAD and mesh MCP
  runtime tests are what verify that pairing (both pass).

## [2.12.0] - 2026-10-13

- feat: update **Kratos MCP Server 0.5.0 → 0.9.0** across desktop launch, approval classification, Docker requirements and docs. The server grows 52 → 110 tools (MDPA mesh building/editing, geometry interchange, live `session_*` driving, `results_*` post-processing, `create_cosim/fsi_project` scaffolding), 13 → 19 resources and 5 → 8 prompts; all 58 new tools classified read/write with path-scoped approval where paths are determinate. `run_simulation` gains MPI launch (`mpi_ranks`/`omp_threads`, launcher discovery with a pre-creation MPI probe, process-group cancel, per-rank logs), supplying the upstream half of the MPI runner contract. The `mcp<2` constraint stays: the new server still imports `mcp.server.fastmcp`.

## [2.11.0] - 2026-10-12

- feat: integrate **CAD Preview 3.14.0** and **Mesh Preview 5.5.0**, sharing
  meshio++ 16.32.0. CAD mode gains Draco/meshopt-compressed glTF, OBJ `.mtl`
  materials and PLY vertex colours, `point-N` picked-point curve references, a
  typed command bar with Tab completion, and the STEP assembly tree read
  synchronously (cad 3.14's deferred read crashed the kernel on a post-save
  reload, so it is off until upstream fixes it); post
  mode gains the cancellable analysis/series-scan/oracle/meshio-write worker
  fleet, batch op queues with named `.kratos/recipes/` presets and
  companion-aware manifests, structured case preflight, saved convergence
  history and post-run monitors, linked previews, a flat SubModelPart list,
  and a cooperative stop file ahead of SIGINT → SIGTERM → SIGKILL.
- feat: classify the two new mesh MCP tools for approval
  (`mesh__case_convergence` and `mesh__case_monitors`, both write by the
  conservative `outputPath`/sidecar rule) and describe the cooperative stop,
  preflight, convergence/monitors, batch presets and coupled problemtypes to
  the assistant.
- feat(settings): one line-glyph per category in the Settings page nav menu
  and section headers, with a refreshed `settings.png` captured from the live
  app.
- feat(cloud): **companion files and trees now sync both ways.** A cloud
  `.foam` case downloads its `constant/polyMesh/` mesh with the marker (it used
  to open empty) and uploads changes to it, creating the remote folders through a
  new idempotent `ensureFolder` on Google Drive, Dropbox and OneDrive; XDMF's
  sibling `.h5` — documented as uploaded but never wired up — now travels too.
  Companions follow the document's per-file revision/conflict-copy rule, a failed
  companion download fails the open rather than staging a partial mesh, and an
  upload pass that fails midway no longer re-uploads files that already landed
  against their stale baseline.
- feat(mcp): gate the HTTP meta server with a **Settings ▸ MCP Server ▸ Allowed
  Tools** choice (read-only default for newly enabled servers, read + listed
  writes, or everything; existing configurations keep "everything"), classified
  through the same `toolPolicy.ts` table — refused calls return a clear MCP
  error rather than running un-gated on the bearer token alone.
- feat(chat): add path-scoped **"Always allow writes inside the project folder"**
  approval, keyed on the explicit project root with a fail-closed per-tool table
  of path arguments, and classify the pinned Kratos server's 52 tools into
  read/write rows reviewed against `KRATOS_MCP_VERSION` (a test fails when the
  pin moves without re-review, the same discipline the cad/mesh key set has).
- feat(chat): let the user enter input/output (and optional cache) prices and a
  context window for models the reviewed table doesn't list (`llm.custom*`
  Settings rows, labelled user-supplied in the readout), and put composer
  controls in the sidebar itself: paste/drop image attachments (persisted with
  the conversation, refused up front where the provider cannot take them), an
  in-chat model picker, and a thinking-level/output-budget selector. A
  preconfigured PDF reader MCP server (pinned `pdf-insight-mcp`) backs PDF
  attachments.
- docs: animated timeline GIFs for the fluid tutorial
  (`tools/tutorials/animations.mjs` with a dependency-free encoder, 1.5 MB
  budget per GIF, embedded beside — not instead of — the PNGs); shallow water
  stays a still capture by decision, since every frame is identical.
- feat(windows): offer a **Wait / Reload** choice when a view stays
  unresponsive. `unresponsive` still never triggers an automatic reload (a large
  mesh parse trips it legitimately); a pure `unresponsiveGuard` policy now asks
  after a generous 30 s delay, re-arming with a doubled delay on Wait (cap
  10 min) and reloading only through the click via the crash path's recovery
  replay. A view that recovers, reloads, closes or quits cancels the episode.
- feat(session): **re-download evicted cloud documents on session restore.**
  Restore stays synchronous, but a saved cloud document whose staging copy was
  evicted now keeps its tab as a placeholder (order and focus preserved) and is
  fetched in the background, one download at a time and only into a still-blank
  tab; one "not signed in" notice per provider, and a failure closes just that
  placeholder without blocking the rest.
- feat: add **OpenCode Zen** (pay-as-you-go) and **OpenCode Go** ($10/$40
  subscription) as first-class **Settings ▸ LLM Assistant** providers, sharing
  one OpenCode API key and reusing the OpenAI-compatible `chat/completions`
  path with a `KKSS/<version>` User-Agent and a stable per-conversation
  `x-opencode-session` id. Defaults are `glm-5.3-flash`;
  reviewed `modelInfo.ts` prices cover the Zen/Go ids with identical rates on
  both gateways, and per-model `/responses` and `/messages` endpoints remain a
  roadmap follow-up.
- docs: post-run checks and batch sections in all five physics tutorials,
  AI-walkthrough follow-ups for the new review tools, batch/preflight coverage
  in the worked-cases guide, preflight capture in the tutorial generation
  pipeline, and Draco fixture pointers in the CAD guide.

## [2.10.0] - 2026-10-09

- feat: integrate **CAD Preview 3.13.0** and **Mesh Preview 5.3.0**, sharing
  meshio++ 16.31.0. CAD mode gains persistent presentation layers
  (`<model>.layers.json`: visibility, lock, colour, entity membership) with
  layer-filtered SVG/DXF drawing and sheet exports, MMG remeshing of FE meshes
  into new `.med` files headless and from the Remesh panel, OpenSCAD
  backend/library-folder settings and Customizer parameter tools; post mode
  gains view-only user layers (`<stem>.kratosview.json`) promotable to real
  SubModelParts.
- feat: take cad 3.12.0's meshing behavior (conformal multi-body meshing
  default-on, `optimize` enum, per-Part structured meshing) and mesh 5.2.x's
  plot default (new curves follow the displayed field) through the existing
  imports, with the Remesh panel's Run button wired through the new
  `remeshRequest` host port.
- feat: sync layer structure (names, colours, visibility, lock — never
  membership) bidirectionally between pre and post: on mesh export and when a
  shared `.stl`/`.obj`/`.ply` file is opened or focused, last-writer-wins and
  union-only so repeats converge.
- feat: classify the six new CAD MCP tools for approval (`list_layers` and
  `list_scad_parameters` read; `set_layer`, `assign_layer`, `remesh_mesh` and
  `convert_scad` write) and describe the new capabilities to the assistant.
- fix: resolve open Dependabot security alerts and refresh dev dependencies.
- fix(e2e): the harness file picker clicks the option row, not its inner
  label, fixing cloud and mesh-feature scenario selection.
- fix: give the structural tutorial a physical steel density (7850 kg/m³) now
  that the mesh engine refuses non-positive material densities at generation.
- docs: document layers, layer sync, OpenSCAD settings, MMG remeshing and the
  new assistant tools across the CAD, mesh, development and getting-started
  guides, queue tutorial GIF captures and CoSimulation/FSI examples on the
  roadmap, with refreshed Electron screenshots (plot captures now show the
  result field in the 3D view beside each chart).

[2.20.1]: https://github.com/loumalouomega/KKSS/compare/v2.20.0...v2.20.1
[2.20.0]: https://github.com/loumalouomega/KKSS/compare/v2.19.0...v2.20.0
[2.19.0]: https://github.com/loumalouomega/KKSS/compare/v2.18.0...v2.19.0
[2.18.0]: https://github.com/loumalouomega/KKSS/compare/v2.17.0...v2.18.0
[2.17.0]: https://github.com/loumalouomega/KKSS/compare/v2.16.0...v2.17.0
[2.16.0]: https://github.com/loumalouomega/KKSS/compare/v2.15.0...v2.16.0
[2.15.0]: https://github.com/loumalouomega/KKSS/compare/v2.14.0...v2.15.0
[2.14.0]: https://github.com/loumalouomega/KKSS/compare/v2.13.0...v2.14.0
[2.13.0]: https://github.com/loumalouomega/KKSS/compare/v2.12.0...v2.13.0
[2.12.0]: https://github.com/loumalouomega/KKSS/compare/v2.11.0...v2.12.0
[2.11.0]: https://github.com/loumalouomega/KKSS/compare/v2.10.0...v2.11.0
[2.10.0]: https://github.com/loumalouomega/KKSS/compare/v2.9.0...v2.10.0

## [2.9.0] - 2026-10-05

- feat: integrate Mesh Preview 5.1.0 scientific plotting: mesh-native dockable Plots pane, standalone builder, staged strict-CSP Plotly assets and cancellable worker, recipes and CSV/PNG/SVG provenance exports. Preserve exact owning-result open-beside navigation and classify six plotting MCP tools.
- docs: extend all five FEM tutorials with solver-derived plotting recipes, full-resolution CSV/provenance and refreshed archives; document cylinder pressure startup evolution, explicit fixed-step time reconstruction and boundary/association limits, with real Electron screenshots and acceptance tests.

- feat: integrate Mesh Preview 4.23.0: native multi-file Import Mesh in one undoable operation, grouped export submenus, worker-backed streamlines with progress/partial cancellation and tube styling, all-step flow balance, dimension-aware display units and density-field pressure conversion, and validated Fluid fixed/adaptive time stepping.
- feat: expose graphical export reports in the preview and script-free standalone packed-series reports. Update provenance settings and assistant guidance for native embedding, collection sidecars, measured fidelity and PVD packing.
- fix: stage the streamline worker beside the app bundle, allow packing numbered MDPA series as well as VTK, and correct upstream display-unit scaling for mm/km, mPa·s and dimensionally consistent mm²/s², with numerical and runtime regressions.
- fix: persist the transcript-compaction boundary immediately instead of on the 1s debounce, and harden the switch-away-and-back regression test to poll for both the reloaded conversation and its boundary, fixing the `chatService.test.ts` failure in CI run 37346361599 where `compactedResults` came back `undefined` under disk contention.

## [2.8.0] - 2026-09-30

- feat: add Home-guided, revision-aware simulation workflows: create and manage
  studies, attach geometry and meshes, plan mesh/case/run tasks, resume queued
  work, run bounded parameter sweeps, and compare results. Refinement metadata,
  resource checks and solver convergence evidence feed versioned JSON/HTML run
  reviews; quantity evaluations retain the exact result revision they came from.
- feat: integrate **CAD Preview 3.10.1** and **Kratos MDPA Preview 4.18.0**,
  sharing meshio++ 16.27.0. The app now routes the expanded CAE reader set,
  exposes CAD B-rep health, passage preflight and CAD-to-mesh deviation checks,
  and handles cancelled mesh sweeps as partial results. Mesh mode gains durable
  recording drafts, expanded timeline and resampling support, flow/curvature
  analysis, and export-fidelity reports with configurable provenance.
- feat: surface the updated mesh material presets, export reports and recording
  storage through KKSS settings and host shims. New CAD and mesh MCP tools have
  explicit read/write approval classifications; packaged associations and file
  format guides now cover 60 readable and 46 writable meshio++ formats.
- docs: expand the workflow and mesh guides with study/refinement behavior,
  timeline discovery, recording recovery, provenance, material libraries and
  supported CAE formats.

## [2.7.0] - 2026-09-29

- fix: patch the four open Dependabot advisories, all in transitive
  dependencies the app never imports directly — `ip-address` 10.4.0 → 10.7.2
  (SSRF and trust-boundary bypass: `Address6.isLinkLocal()` recognised
  `fe80::/64` rather than `fe80::/10`, and nothing classified the NAT64
  local-use range `64:ff9b:1::/48`), `undici` 7.29.0 → 7.30.0 and 6.28.0 →
  6.29.0 (DoS via an unhandled error in WebSocket permessage-deflate
  decompression), and `nanoid` 3.3.16 → 3.3.19 in the docs site (custom
  generators could loop indefinitely when `size` is zero). Each is pinned via
  `overrides` at its first patched version, matching the existing
  `fast-uri`/`js-yaml`/`qs`/`hono` entries; the second `undici` copy sits
  under `node-gyp`, so it stays on the 6.x line instead of being dragged
  across a major by the flat one. `npm audit` is now clean at the root and
  in `doc/`.
- test: quit the first app before the mesh scenario relaunches on a shared
  profile. Electron 44.4.4 began persisting Skia's GPU shader cache, so a
  second instance launched against a live app's `--user-data-dir` took the
  GPU process down at startup (exit code 133); the new renderer's first
  `getContext('webgl2')` then returned null and the mesh view stayed dead
  for good. KKSS is single-instance in production, so this only ever affected
  the test, but the relaunch assertion still needs a fresh process to read the
  saved property.
- chore: update Electron to 44.4.5, `@anthropic-ai/sdk` to 0.128.0,
  `@anthropic-ai/claude-agent-sdk` to 0.3.283, `@modelcontextprotocol/sdk` to
  1.30.1, `vitest` to 5.0.2 and `@types/node` to 26.6.3.
- chore: update `actions/upload-artifact` from 4 to 7.

## [2.6.0] - 2026-09-27

- feat: add **Settings ▸ Mesh Viewer ▸ 3D Renderer** (`kratos.preview.renderer`),
  an opt-in experimental VTK-wasm backend for mesh previews, with a matching
  **View ▸ 3D Renderer** quick radio beside the other viewer toggles, enabled
  only in Post-Processing. vtk.js remains the default and its page is unchanged;
  VTK-wasm needs WebAssembly JSPI and WebGL2 and falls back to vtk.js with a
  status line when either is missing. In a build without the runtime the menu
  marks VTK-wasm *unavailable in this build* and refuses it, so the fallback is
  explained before it is picked. Pin it for a shared deployment with
  `KKSS_MESH_RENDERER`.
- feat: read eleven more meshio++ formats — Abaqus `.fil`, ANSYS MAPDL
  `.rst`/`.rth`, LS-DYNA `.d3plot`, MSC Marc `.t19`, MSC Nastran `.op2`/`.h5`
  and FEBio `.xplt` — all read-only and all as filename series, since none of
  them reports its step count from a header. Extended readable formats go from
  42 to 49, and the new suffixes join the packaged file associations.
- fix: settle a CAD mesh save-in-place that another process left in flight
  before the document loads, so a file whose geometry was baked ahead of its
  edit history no longer replays the same edit over geometry that already
  contains it.
- chore: update CAD Preview to 3.7.1 and Kratos MDPA Preview to 4.9.0, and
  unify both engines on meshio++ 16.22.0 — which also corrects node ordering for
  20- and 27-node hexahedra, so Exodus files with those cells now load with the
  right nodes. CAD resolves meshio++ and fTetWild from the staged runtime trees
  KKSS already ships, replacing the two loader shims they needed.

## [2.5.0] - 2026-09-25

- feat: CAD meshing now replays pending model edits from supported source
  meshes in the compute worker, including meshio companions and external glTF
  buffers. Viewer-provided geometry remains authoritative to prevent replaying
  edits twice.
- fix: preserve CAD replay provenance and warnings when edits are partially
  applied or skipped, and keep raw-source fallback diagnostics visible.
- fix: refresh mesh selection counts and action availability after edits,
  undo/redo, reloads and timeline changes while preserving panel input/focus.
- fix: resolve CAD and mesh meshio++ from the shared packaged runtime despite
  independent version pins, and ignore late host callbacks after window close.

## [2.4.0] - 2026-09-25

- feat: integrate Mesh 4.6.0 selection sets, property editing, selection-based
  SubModelParts, entity deletion and undo, and interactive line probes with
  sampling and CSV export.
- feat: add CAD mesh sweep and hole-table workflows, and improve the fluid
  dynamics tutorial with obstacle flow and verification checks.
- feat: make KKSS controls and dialogs available in English and Spanish, with
  keyboard-accessible focus cycling, document tabs and chat approvals.
- chore: update Kratos MCP Server to 0.5.0 across desktop launch, environment
  probes and the bundled Docker runtime.
- chore: license KKSS under **AGPL-3.0-or-later**.

## [2.3.1] - 2026-09-24

- feat: simulation environment reports now expose verified runner capabilities
  independently for manual and MCP execution, including supported thread and
  MPI controls.
- feat: run reviews include versioned preparation provenance and solver-reported
  structural residuals, with verified convergence kept distinct from successful
  process exit or incomplete solver output.

## [2.3.0] - 2026-09-23

- feat: **guided simulation studies** connect environment checks, geometry,
  meshing, case setup, isolated runs and results while preserving portable
  project references and immutable run inputs.
- feat: a **persistent dependency-aware queue** resumes mesh and solve work
  from stable execution receipts, and controlled study variants can be
  previewed, retried and compared without overwriting completed runs.
- feat: **run reviews** export offline HTML and JSON with input provenance,
  mesh statistics, structural convergence evidence and explicitly selected
  scalar quantities; comparisons retain failed and unavailable results.
- feat: CAD and mesh handoffs now carry versioned workflow metadata and
  owner-scoped job receipts. CAD-Preview 3.2.0 and VSCode-MDPA-Preview 4.4.0
  are integrated, with package associations covering their routed formats.

## [2.2.0] - 2026-09-22

- feat: a **Settings page** (`Ctrl+,`) replaces most of the old Settings menu
  with a searchable, VS Code-style editor built on a single settings registry.
  It now surfaces every setting the CAD and mesh extensions expose in VS Code
  — previously only 1 of 11 mesh settings and 5 of 6 CAD settings were
  reachable — including the CAD background colour, the Kratos Python
  interpreter/install path/extra environment/problemtype folders, and the
  Flowgraph split orientation, with zero submodule modifications.
- feat: a full **UI theme** (Follow system / Dark / Light / High contrast
  dark / High contrast light), resolved from Electron's `nativeTheme` and
  applied via VS Code's own webview theme classes, so the CAD viewer's
  existing theme reactivity and the mesh viewer's chrome and "auto" 3D scene
  now follow it live. A new `KKSS_UI_THEME` managed-config variable locks it
  in streamed deployments.
- feat: the configured Kratos install path and extra environment now also
  reach the chat sidebar's Kratos MCP server on (re)start, with a "Restart
  with current environment" action on the Settings page.
- feat: Text Editor and Terminal settings (font size/family, tab size, word
  wrap, line numbers, scrollback, cursor style) apply live.
- fix: the opened document's path shows in the window title.
- fix: x11vnc's encrypted auth file is passed correctly in the streamed-web
  image.
- fix/ci: a round of Docker/CI hardening — patched Caddy and gateway Go
  dependencies for security scans, resolved Caddy module checksums, a
  numeric build-stage root user, and assorted CI tag/lint fixes.

## [2.1.0] - 2026-09-22

- feat: the AI chat gains **Claude and Codex subscription agents** — a new
  `agents/` runtime (environment management + RPC session/tool execution)
  wired into the chat service and transcript store, with menu entries, managed
  configuration support and tests.
- feat: **channel-aware in-app updates** — a persisted stable/prerelease
  channel, full SemVer comparison and clearer error handling — plus macOS
  entitlements for JIT/unsigned executable memory. The download docs now list
  `.rpm` alongside the other Linux packages.
- feat: **native file associations follow the routing tables** —
  `electron-builder.yml` declares every routed CAD/mesh suffix plus the `kkss`
  protocol and Linux MIME entries, guarded by `npm run check:packaging`, with
  external launch (CLI, Finder, second-instance, `kkss://open`) centralized in
  `app/main/launch.ts` and covered by tests. `npm run flatpak:probe` inspects
  Flatpak feasibility without publishing an artifact.
- feat: the streamed-desktop deployment grows a **Go gateway/broker** (login +
  desktop pages, session lifecycle, operator-provisioned managed config) with
  a Kubernetes pod reference, multi-user/TLS/proxy/GPU compose variants, and a
  **Kratos-enabled image variant on prebuilt wheels** with a locked
  requirements file.
- feat: streamed-desktop hardening — Xvfb `-noreset`, single-viewer VNC
  session policy, and entrypoint supervision fixes; the Docker CI image and
  lint checks are restored, with follow-up fixes for PR image tags, the smoke
  test's window-title match, and Go gateway builds (patched dependencies,
  direct module downloads).
- fix: bump `golang.org/x/crypto` and `go-jose` past their patched CVEs (17
  Dependabot alerts), and take the npm minor-and-patch group (Anthropic SDK,
  Electron 44.4.3, `@types/node`, `@types/vscode`, vitest).
- chore: sync the cad/mesh submodule references; roadmap updates (Magnusim
  review, guided simulation workflows, distribution metadata, deployment
  validation).

## [2.0.0] - 2026-09-21

- feat: **a redesigned window, shared by both viewers and the app around them.**
  This is a major version because nearly every control moved or changed look,
  not because of file compatibility — existing models and sidecars open as
  before. **CAD-Preview is updated to 3.0.0** and **VSCode-MDPA-Preview
  (4.0.7 plus its UI redesign) now follows the same design**, so switching
  between Pre- and Post-Processing no longer changes where things are: a
  **document chip** in the menubar (file name, format badge, and a dot with
  `N unsaved edits`), an icon on every sidebar section, a collapsed
  **Advanced** group for the read-only sections, a floating toolbar, a one-row
  **dock** along the bottom (reset/fit/zoom, display mode, clip plane,
  perspective, with the rest behind **⋯**) and a full-width **status bar**.
- feat: the CAD status bar shows which **kernels have loaded** (`OCCT ready ·
  Gmsh ready`), the entity counts, the generated FE mesh and the live cursor
  position in the units you chose. A document that needs no WebAssembly kernel,
  such as a plain STL, honestly reads `Kernels idle`. The Post-Processing
  status bar shows the meshio++ / MMG engine state, model counts, the timeline
  frame and your last Inspect pick.
- feat: the app's own screens use the same design — the toolbar and tab strip,
  home screen, AI chat, Kratos jobs panel, text editor, terminal and dialogs
  share one set of controls, spacing and icons. The **Terminal**, **Chat** and
  **Jobs** buttons now show as pressed while their panel is open, and the chat
  header's history, new-conversation and close controls are icon buttons.
- feat: Post-Processing's dock and dropdown menus are keyboard-navigable (arrow
  keys, `Esc` returns focus to the trigger), and the press-and-hold rotate and
  zoom buttons now respond to `Enter` and `Space`.
- fix: clicking the icon on a Post-Processing toolbar button did nothing; only
  the label responded. The quick-pick dialog's text field was also always
  visible because a content-security rule silently blocked the style that
  hid it.
- docs: an edited STEP, IGES, BREP, STL, OBJ or PLY keeps showing `N unsaved
  edits`. That is accurate: KKSS writes your edits to the `<model>.edits.json`
  sidecar (autosaved) and never into the source file, and **File ▸ Export…**
  is what produces a standalone one. A part's target mesh size is now edited in
  **FE Mesh ▸ Part sizes**, not in the Parts panel; the stored value is
  unchanged.

## [1.12.0] - 2026-09-20

- feat: **CAD-Preview updated to 2.7.0** (from 2.3.0) and **VSCode-MDPA-Preview
  to 4.0.7** (from 3.27.0). Pre-processing gains **saved view bookmarks** (name
  a camera orientation, projection, display mode and clip plane, and restore it
  from the View menu), **reusable meshing presets** (a *Saved presets* section
  in the FE Mesh panel with four bundled starters and a per-folder library the
  assistant shares), profiles that can be **sketched on a named construction
  plane**, **volume and point selection filters** plus **Zoom to selection**,
  per-band **operation-preview colouring**, **Standard Parts thumbnails**,
  **bounded assembly clash checks** (pairs past a budget are reported as
  unchecked, never as clash-free), a **resizable sidebar**, keyboard navigation
  for dropdown menus, and clip caps that follow part visibility. Post-processing
  gains a **Variables** sidebar section — named formulas, distances (to a file, a
  SubModelPart or the mesh's own exterior skin) and **global reductions**
  (min/max/mean/std/…) usable by name in any formula, including the remesh
  sizing formula — a **Boundary-layer remesh preset** that prepares those
  variables for you, remeshing that now **carries data fields** onto the new
  mesh, and header-only in-file **timelines for MED, CGNS and Tecplot** through
  meshio++ 12.0.0.
- fix: a profile authored on a named plane **no longer disappears when its model
  is reopened**. The viewer host resolved plane references only after the first
  tessellation, so the kernel skipped a plane-authored profile that carried no
  placement of its own.
- feat: the AI assistant sees the new tools — `save_mesh_preset`,
  `list_mesh_presets`, `apply_mesh_preset`, `compare_mesh_refinement` (which
  meshes one model at several sizes and compares cost against element quality)
  and `mesh_capabilities` — with the preset writers and the refinement sweep
  behind the usual approval prompt. Its description of which formats report a
  step count before a read is corrected: MED, CGNS and Tecplot now do too.

## [1.11.0] - 2026-09-17

- fix: pre-create `/tmp/.X11-unix` root-owned in the streamed-desktop Docker
  image, removing an intermittent Xvfb startup race that could make the
  container exit before noVNC came up (a non-root Xvfb is refused permission
  to create that directory itself). `v1.10.0`'s release build hit this once
  on the arm64 image and passed on retry — no functional change to the app
  itself.
- docs: expand the roadmap with a Web service tier — login, TLS, session
  lifecycle, operator-provisioned settings, file transfer, cloud accounts
  without a local browser, a Kratos-enabled image variant, GPU rendering, and
  a reference per-user orchestrator for the streamed-desktop Docker image.

## [1.10.0] - 2026-09-17

- feat: **CAD-Preview updated to 2.3.0** (from 1.13.0) and **VSCode-MDPA-Preview
  to 3.27.0** — the interactive CAD viewer gains a **Clash panel** (Part-vs-Part
  interference checks, single pair or all pairs at once), the Parts panel's
  **Copy BOM** button, a **Primitives panel** (recognize a B-rep's solids and
  export or save them as a reusable parametric macro), a **Mesh-operations
  panel** for meshio-imported sources (clean/decimate/smooth/subdivide/refine/
  agglomerate/convert-cells), an **Auto-decimate** opt-in when Mesh Health's
  healability check hits its triangle ceiling, a bundled **starter macro
  library** (three ready-to-run macros shipped with the app, shown read-only
  alongside your own), and **File ▸ Export Drawing Sheet…** (several
  orthographic/iso views on one scaled sheet with a title block). The
  interactive viewer also now correctly respects a model already **baked**
  in place by the assistant's `save_model` tool, instead of risking a
  double-applied edit on reopen.

## [1.9.0] - 2026-09-15

- feat: add a dedicated Kratos Jobs panel with active-job counts, progress,
  logs, cancellation, reconnect recovery, and server-owned background job
  tracking shared with the AI assistant.
- feat: replace the application icon with a tessellated teal kissing-lips mark
  inspired by the Kratos mesh aesthetic.

## [1.8.0] - 2026-09-09

- fix: refresh native menu availability when switching modes, restoring mesh
  actions such as time-series packing after opening a mesh from CAD mode.

- fix: bundle the CAD assistant kernel with KKSS runtime loaders so geometry
  and mesh tools work without the extension's external npm packages.

- feat: show readable Kratos startup errors with app-local uv installation and
  retry controls in chat. Recovery leaves CAD and mesh running; no PATH or
  shell-profile changes are needed.
- fix: constrain the pinned Kratos server to MCP Python 1.x, restoring startup
  after the incompatible MCP Python 2.x release.

- fix: keep the assistant's tool definitions stable throughout each user turn,
  including retries, so MCP servers connecting in the background do not
  invalidate the prompt-cache prefix. Newly ready tools join the next turn.

## [1.7.1] - 2026-09-08

- fix: the Docker image build now runs `apt-get upgrade` before installing
  its runtime libraries, so a rebuilt image picks up Debian security
  point-releases instead of reusing a stale cached apt layer indefinitely.
  `v1.7.0`'s release build failed the vulnerability scan on 6 already-fixed
  HIGH-severity CVEs in `libaom3`/`libssh2-1` for exactly this reason — no
  functional change to the app itself

[2.4.0]: https://github.com/loumalouomega/KKSS/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/loumalouomega/KKSS/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/loumalouomega/KKSS/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/loumalouomega/KKSS/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/loumalouomega/KKSS/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/loumalouomega/KKSS/compare/v1.11.0...v2.0.0
[1.12.0]: https://github.com/loumalouomega/KKSS/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/loumalouomega/KKSS/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/loumalouomega/KKSS/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/loumalouomega/KKSS/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/loumalouomega/KKSS/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/loumalouomega/KKSS/compare/v1.7.0...v1.7.1

## [1.7.0] - 2026-09-08

- feat: **both engines updated** — Pre-Processing to CAD-Preview 1.13.0 (from
  1.12.0) and Post-Processing to VSCode-MDPA-Preview 3.21.0 (from 3.15.1)
- feat: Pre-Processing gains **wrap** — develops a flat sketch face onto a
  cylinder/cone target (true surface development, not projection) as a new
  solid, or fused/cut into the target — and **loft guide rails**, steering a
  loft between two closed sections along an edge instead of a straight blend
- feat: Post-Processing now **reads OpenFOAM cases**, not just writes them —
  opening a `.foam` marker loads its `constant/polyMesh/` tree with named
  boundary SubModelParts recovered from `constant/polyMesh/boundary`, and the
  preview watches that tree so re-running `blockMesh`/`snappyHexMesh` refreshes
  it in place. `.foam` now opens in Post-Processing, not Pre-Processing, since
  post mode can finally read it; in-place save stays refused (the opened file
  is a 0-byte marker, so writing it would collapse every patch name)
- feat: **Refine is now selective** — the whole mesh as before, or just the
  cells a per-cell field marks (defaulting to the error estimator's own output)
  or a SubModelPart; the neighbours of a selected cell get the smallest partial
  split that keeps the mesh conforming, so the refined region has no hanging
  nodes (triangles and tetrahedra only)
- feat: **level-set splitting can keep your mesh's own structure** — Materials
  & base references puts each split cell back into its original block and
  SubModelParts instead of the generic `MMG_Domain_Inside`/`_Outside` pair, and
  can clean up parasitic components below a volume fraction or that don't
  touch a named boundary
- feat: **Pack Time Series Into One File…** (File menu) combines a finished
  run's hundreds of per-step files into a single XDMF time series, streamed
  one step at a time and cancellable; the packed file reopens as the same
  scrubbable timeline
- feat: **mesh edits are unsaved work KKSS now protects** — applying an
  operation marks a mesh tab dirty (a `●` in the tab strip), and closing that
  tab or quitting with one open prompts Save / Don't Save / Cancel, the same
  as the text editor already did. Edits are never auto-saved
- feat: **Undo / Redo Mesh Operation** on `Ctrl+Alt+Z` / `Ctrl+Alt+Shift+Z`
  (not the plain `Ctrl+Z` the sidebar buttons already answered to, which would
  otherwise steal the text editor's own undo)
- feat: a mesh over **Settings ▸ Mesh Viewer Defaults ▸ Large-Mesh Summary
  Threshold…** (default 250 MB) opens as a header summary — counts, blocks,
  field names, regions, time steps — instead of loading in full, with an
  **Open full mesh anyway** button
- feat: the AI assistant gained the **mesh_pack_series** tool (Pack Time
  Series, above), gated the same way as every other tool that writes a file
- fix: a `.foam`'s content watcher, and a GiD ascii `.post.msh`/`.post.res`
  pair's timeline watcher, now actually fire — both patterns fell through the
  file watcher's matcher unmatched

[1.7.0]: https://github.com/loumalouomega/KKSS/compare/v1.6.0...v1.7.0

## [1.6.0] - 2026-09-07

- fix: two flaky-test fixes in the chat service test suite (a real-fs-flush
  race in the "New chat while a tool approval is open" test, and a too-tight
  real-timer budget in the shared test helper that could be outrun under CI
  load) — no functional changes to the app itself

## [1.5.0] - 2026-09-06

- feat: **the assistant asks before it changes anything** — a tool call that
  writes files, starts a solve, or that KKSS has no policy for now appears in
  the chat with its full arguments and **Allow** / **Always allow in this chat**
  / **Deny** buttons, instead of running the moment the model asks for it.
  Read-only tools (inspect, measure, mesh info, render…) still run silently, so
  asking questions is unchanged. A denial is reported back to the assistant, so
  it explains what it wanted rather than retrying. Tune or disable it under
  **Settings ▸ LLM Assistant ▸ Tool Approval**; the default asks before writes.
  Note the **MCP Server** endpoint is not covered — an external client has no
  one to ask, so it stays protected by its bearer token alone
- feat: **open and save files directly from Google Drive, Dropbox and
  OneDrive** — **File ▸ Open from Cloud…** browses a connected account and
  downloads the model (and its sidecars) into a local staging cache, from which
  it behaves exactly like a local document; edits upload back on **File ▸ Save**
  and a few seconds after each autosave. Bring your own OAuth client under
  **Settings ▸ Cloud Accounts** — no KKSS-owned credentials are baked in. A file
  changed on the provider since KKSS last synced is never overwritten: your copy
  is kept and uploaded beside it as a `(conflict …)` copy. Quitting mid-upload
  holds the quit briefly to finish, and anything still unsent is reported on the
  next launch rather than lost
- fix: **CAD sidecars are written atomically** — `.parts.json`, `.edits.json`,
  `.annotations.json`, `.view.json`, `.planes.json`, `.mesh.json`, `.geo` and
  the macro library now use the same temp-file + fsync + rename path
  `state.json` already used, so a desktop sync client (Drive, Dropbox, OneDrive)
  watching your project folder can no longer upload a half-written sidecar or
  raise a spurious "conflicted copy"
- feat: **both engines updated** — Pre-Processing to CAD-Preview 1.12.0 (from
  1.8.0) and Post-Processing to VSCode-MDPA-Preview 3.15.1 (from 3.12.0)
- feat: Pre-Processing can **start from nothing** — **File ▸ New Blank Model…**
  creates an empty `.brep` and opens it, so the Edits panel's whole creation
  vocabulary (primitives, sketch profiles, wireframe modeling, booleans,
  fillets, patterns) works from scratch; it refuses to overwrite an existing
  model rather than leaving its edit history replaying against nothing
- feat: Pre-Processing reads **OpenSCAD** models — `.csg` directly, and `.scad`
  through a user-installed `openscad` binary configurable at **Settings ▸ CAD
  Viewer Defaults ▸ OpenSCAD Binary…**; both are import-only, and anything the
  importer approximates or skips is reported rather than silently dropped
- feat: an edit operand can be **pinned as a query** instead of a positional
  entity id — re-matched geometrically on every replay, so an op keeps naming
  the right face after the op list is spliced. Parts carry the same mechanism
  and are re-resolved when a document opens; a query that no longer derives
  freezes on its cached ids with a warning rather than resolving to the wrong
  entity
- feat: **collapsible sidebar sections** in Pre-Processing — all nine panels
  collapse to their header independently, remembered per document
- feat: new Pre-Processing edit ops — `rib` and `drill`, an `upToFace`
  terminator for extrude, region `pick` on extrude/revolve/sweep, and loft
  `smoothing`
- feat: Post-Processing remeshing gains an **anisotropic** mode (adapts the mesh
  to the curvature of a scalar field via its Hessian), **frozen** EntityBlocks
  and SubModelParts MMG must leave bit-identical, and per-block/per-part
  `hmin`/`hmax`/`hausd` **local size bounds**
- feat: a global **Edges** toggle in Post-Processing's View ▾ menu — faces and
  cell edges share one alpha, so a transparent mesh no longer has to read as a
  wire cage; and **isolated nodes** are now reported and drawn per SubModelPart,
  not only per whole model
- feat: **File ▸ Open Recent** lists the last ten meshes you opened, newest
  first, with Clear Recent; entries that have moved or been deleted drop off by
  themselves
- feat: the AI assistant learned the new surface — `resolve_selector` /
  `synthesize_selector`, the OpenSCAD routes, anisotropic/frozen/local-size
  remeshing, and `mesh_info`'s header-only `metadataOnly` fast path and
  `isolatedNodes` section
- note: SpaceMouse 6DOF input, added upstream in CAD-Preview 1.12.0, is
  deliberately **not** included — it needs a second native module (`node-hid`)
  and `node-pty` is intentionally the only one KKSS ships

## [1.4.0] - 2026-09-03

- feat: **both engines updated** — Pre-Processing to CAD-Preview 1.8.0 (from
  1.2.6) and Post-Processing to VSCode-MDPA-Preview 3.12.0 (from 3.0.0),
  twenty releases of viewer work between them
- feat: Post-Processing gains **split view** (1, 2 or 4 viewports, each with
  its own camera, field settings and clip plane), a **run manager** that
  starts a Kratos solve as a tracked process with a real exit code and live
  progress read from `vtk_output/`, **viewport recording** to WebM or a
  numbered PNG sequence, **beam rendering** (line elements drawn at their real
  cross-section from `Properties` `CROSS_AREA`), a **data table** with CSV and
  XLSX export, **field-value plots over time**, **field integrals**,
  watertightness reporting, an **operation queue**, and multi-point
  **constraints parsed as real entities** that every edit operation now
  maintains instead of dropping
- feat: Pre-Processing gains **split view with linked cameras across tabs**,
  **live operation preview** before Apply, a **macro library** of named
  parameterized scripts, **named construction planes**, **hover-explain** and
  query-based **selection groups**, **mesh repair** (fTetWild) and
  **promote-to-B-rep**, **primitive recognition** and **region fitting**,
  **2D drawing export** (silhouette SVG/DXF and hidden-line-removal technical
  drawings), **SVG/DXF import**, and **tolerance bands** on pinned measurements
- feat: **new native menu entries** for the mesh viewer's hidden File strip —
  *Reload from Disk* (`Ctrl+Alt+R`, which replays applied edits onto the
  re-read file rather than discarding them), *Export Data Table…* and
  *Stop Kratos Run*
- feat: solver runs are now **shared across every Post-Processing tab** and
  outlive the tab that started them; finished results open in a **new** tab
  jumped to the latest complete step
- feat: more importable formats — Pre-Processing reads OpenFOAM `.foam` cases
  and `.msh`/`.msh2`/`.inp`/`.unv`/`.su2`/`.mesh`, and both engines read GiD
  postprocess (`.post.msh`/`.post.res`/`.post.bin`/`.post.h5`) via meshio++
  10.20.2. File routing now resolves **compound extensions by longest suffix**,
  so `case.post.msh` is recognised as GiD rather than as a Gmsh `.msh`
- fix: colour-by-field in Pre-Processing now reports the actual reason a field
  cannot be used instead of guessing between three possible causes
- chore: the AI chat sidebar's tool descriptions cover the new surfaces —
  cad-preview grew from 23 to 44 tools and kratos-mdpa from 15 to 21

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

[1.6.0]: https://github.com/loumalouomega/KKSS/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/loumalouomega/KKSS/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/loumalouomega/KKSS/compare/v1.3.0...v1.4.0
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
