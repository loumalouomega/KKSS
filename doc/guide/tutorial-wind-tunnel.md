# Sphere in a virtual wind tunnel (RANS k-omega SST)

**Virtual wind tunnel.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Plan, generate and run


Model a 0.8 m sphere in CAD millimetres: the Edits panel **Sphere** operation, center (0, 0, 0), radius 400 mm. Export the skin as STL (File ▸ Export… to `sphere.stl`). Plan first: `mesh__wind_tunnel_plan` with the body in metres, flow 10 m/s with the k-omega SST model and y+ target 150. The plan reports the measured body, the tunnel extents, the flat-plate boundary layer (first-cell height for y+ 150), sizes and a tetrahedra/memory/time estimate with ordered steps — tune sizes until the estimate fits the machine. Then `mesh__wind_tunnel_generate` with an output folder, a stem and `generateCase: true` builds the graded tunnel mesh, carves and snaps the body, checks the mesh and writes the mesh, the placed body, the recipe (`tunnel.kratosvwt.json`), the case state and the solver files. This tutorial’s plan used a coarse lattice (surface 0.4 m, far 2.5 m, wake 0.5 m): a steady RANS run stops when it converges, and a coarse mesh is both fast per step and dissipative enough to settle.


1. Export the sphere skin as STL (File ▸ Export… to `sphere.stl`). The wizard measures whatever closed surface the file carries, so check the plan’s body table (size ~0.8 m, closed, no problems) before generating.

2. In the chat (or MCP), call `mesh__wind_tunnel_plan` with the body path in metres, flow 10 m/s with the k-omega SST model and y+ target 150. Read the tunnel extents, the flat-plate boundary layer (first-cell height for y+ 150), sizes and the tetrahedra/memory/time estimate with its ordered steps. Tune `surfaceSize`, `farSize` and the wake box until the estimate fits the machine; a plan with errors cannot run.

3. Call `mesh__wind_tunnel_generate` with an output folder, a stem and `generateCase: true`. It builds the graded tunnel mesh, carves and snaps the body, fits the wall layer, checks the mesh and writes the mesh, the placed body, the recipe (`tunnel.kratosvwt.json` with parameters and report) and the case state plus solver files.

4. Point **Settings → Simulation → kratos.pythonPath** at a Python that imports Kratos Multiphysics with the **RANSApplication** and **LinearSolversApplication**, then **Run case**. The run is steady: up to 300 pseudo-time steps, stopping earlier when the solver converges.


## Set up, generate and run


| Setting | Value |

|---|---|

| Geometry and SubModelParts | D = 0.8 m sphere (5434-triangle skin, closed, no problems); tunnel x −1.60…2.39 m, y ±1.59 m, z ±2.40 m; face parts Inlet, Outlet, Floor, Ceiling, SideLow, SideHigh; wall part Body; 3.2% blockage; 14840 nodes; 82804 tetrahedra |

| Problemtype values and physics | Steady RANS k-omega SST with log wall function (up to 300 pseudo-steps); 10 m/s air; planned first-layer y+ 150; force, coefficient, pressure-coefficient and y+ monitors on the body |

| Solver/output | Steady RANS k-omega SST with log wall function; up to 300 pseudo-steps; VTK `VELOCITY`, `PRESSURE`, turbulence fields and pressure coefficient every 25 steps; force, coefficient, pressure-coefficient and y+ monitors on the body |

| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics with **RANSApplication and LinearSolversApplication** |


The recipe (`tunnel.kratosvwt.json`) carries the plan, the build report and the case notes, so a finished tunnel stays reproducible without rerunning the wizard. The values below came from the verified final frame.


## Scientific plots

Build plots from your own run in the app: open a result, choose **Plots → New recipe**, and see [scientific plots](scientific-plots) for the builder, units and CSV export.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

The steady run completed all 300 pseudo-steps without meeting the convergence tolerance — the wake keeps shedding, so the force monitors breathe: drag averages 6.77 N over the last ten steps (final step 6.15 N; Cd 0.224 on the 0.502 m² frontal area, recorded as informational: there is no published benchmark at this Reynolds number). The solver wrote RANS_Y_PLUS on no nodal field (it lives on the conditions, as in every RANS case here), so the measured y+ is reconstructed from the wall-normal velocity gradient at 1616 shoulder stations: mean 52.0 against the planned 110.1 (ratio 0.47), with a 90.1% share in 30–300. Neither Y_PLUS nor RANS_Y_PLUS reaches the nodal VTK; the reconstruction reads low against the flat-plate plan basis (a sphere boundary layer is not a flat plate), so the acceptance is order-of-magnitude agreement that would catch a wrong layer. Inlet/outlet fluxes are −153.52 and 154.07 m³/s (imbalance 0.36%). Acceptance limits: flux imbalance ≤ 5% of the inflow, measured-to-planned y+ in [0.4, 2.5], drag finite and positive.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 14840 nodes and 82804 cells. The run wrote 12 output frame(s) through t = 300 s. [Download this runnable case](/examples/tutorials/wind-tunnel.zip); the folder contains the authored body STL, the placed body, the recipe, the case state and the generated case, with SHA-256 provenance and the solver verification record. Run the case to reproduce its VTK timeline locally. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-wind-tunnel-geometry.png)


