# Turbulent flow around an obstacle

**Turbulent Flow (RANS).** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Create the same 2.0 × 0.6 m planar XY channel, but draw the obstacle with 16 straight edges: a 23.4 mm-chord 16-gon sagging 1.1 mm from the r = 60 mm circle at (500, 300) mm. The wall-adjacent mesh row follows the boundary edges, so 32 edges would pin it near 12 mm, below the wall-function range — 16 edges put the first row near 25 mm. Build one face with the inner loop as a hole exactly as in the laminar case (the shipped [SVG sketch recipe](/examples/tutorials/rans/obstacle-channel.svg) draws the 60 mm circle as a guide) and name the same Parts (`Domain`, `Inlet`, `Outlet`, `Walls`, `Obstacle`). Use a 2D first-order mesh, global min/max sizes 25/70 mm, and grade around Obstacle from 25 mm at its wall to 60 mm at 350 mm distance (25 mm through the first 25 mm). Export to metres. Set the RANS 2D air material to density 1.204 kg/m³ and dynamic viscosity 1.825e-5 Pa·s; with inlet speed 1 m/s this gives Reynolds number 7917 based on the 120 mm obstacle diameter. Run the monolithic k-epsilon formulation with the logarithmic wall function on the obstacle and time scheme **Bossak** — published with the case, and the BDF2 path of the formulation segfaults the tier4 runtime’s Kratos 10.4.3 at the first solution step.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Draw the channel boundary with the **Polyline** sketch operation: the 2000 × 600 mm outer loop, then the obstacle as a 16-edge loop (straight segments between angles 0°, 22.5°, …, 337.5° on the r = 60 mm circle at (500, 300) mm). The 16-gon sags 1.1 mm from the true circle; fewer, longer boundary edges are what lift the wall-adjacent mesh row into the wall-function range.
2. Select all 20 edges and choose **GEOMETRY → 2D → Surface → Build** to form one flat face with the inner loop as a hole. Under **Parts**, name the face `Domain`; name x = 0 `Inlet`, x = 2000 mm `Outlet`, the y edges `Walls`, and the inner 16 edges `Obstacle`. The shipped [SVG sketch recipe](/examples/tutorials/rans/obstacle-channel.svg) draws the 60 mm circle the polygon approximates.
3. Under **FE Mesh**, choose Gmsh, 2D, first order, global size min/max **25/70 mm**. In the `Obstacle` Part's **Grade** controls set size at wall **25 mm**, size far **60 mm**, distance near **25 mm**, and distance far **350 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`. This is a planar XY face mesh with a hole, not the surface mesh of a solid.
5. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Turbulent Flow (RANS)** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 2.0 × 0.6 m XY; face Domain; edge parts Inlet, Outlet, Walls; 16-edge hole Obstacle; 654 nodes; 1202 triangles |
| Problemtype values and physics | Monolithic k-epsilon with log wall function (Bossak); Δt 0.1 s; end 5 s; 51 frames; inlet 1 m/s +X; outlet 0 Pa; slip walls; air ρ 1.204 kg/m³; μ 1.825e-5 Pa·s; Re 7917 |
| Solver/output | monolithic RANS k-epsilon with log wall function (Bossak); Δt 0.1 s; end 5 s; 51 frames; VTK `VELOCITY`, `PRESSURE`, `TURBULENT_KINETIC_ENERGY`, dissipation, `TURBULENT_VISCOSITY` |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **RANSApplication and LinearSolversApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose the final step. The values below came from the verified final frame.

## Scientific plots

Build plots from your own run in the app: open a result, choose **Plots → New recipe**, and see [scientific plots](scientific-plots) for the builder, units and CSV export.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

In the final frame (t = 5 s) the inlet and outlet fluxes are 0.60000002 and 0.60002297 m²/s per metre of depth (imbalance 2.3 × 10⁻⁵ m²/s). The obstacle-adjacent row reconstructs a mean y+ of 32.8 (range 18.9–40.9, four of six shoulder stations in 30–300), inside the logarithmic wall-function range — neither Y_PLUS nor RANS_Y_PLUS reaches the nodal VTK (both live on the conditions), so the check derives u_tau from the wall-normal velocity gradient instead. Turbulent kinetic energy peaks at 3.36 m²/s² with a bounded 5.3% undershoot, and the eddy viscosity stays non-negative. The drag monitor averages 0.1276 N/m over the last ten steps (Cd 1.77 on the 120 mm diameter); the streamwise momentum balance predicts 0.1426 N/m (11.7% relative error). The near wake bottoms at −0.330 m/s against the 1 m/s inlet (deficit 1.33 m/s), and pressure spans 1.42 Pa with the outlet at 0 Pa. The acceptance limits are a mean wall y+ in [30, 300], k undershoot ≤ 10%, drag Cd in [1.5, 4.5] with momentum error ≤ 15%, wake deficit ≥ 0.025 m/s, pressure range ≥ 0.05 Pa, and flux imbalance ≤ 0.001 m²/s.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 654 nodes and 1202 cells. The run wrote 51 output frame(s) through t = 5 s. [Download this runnable case](/examples/tutorials/rans.zip); the folder contains the CAD source, generation setup and generated case, with SHA-256 provenance and the solver verification record. Run the case to reproduce its VTK timeline locally. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-rans-geometry.png)

![Problemtype setup](/screenshots/tutorial-rans-setup.png)

![Velocity around the obstacle in KKSS](/screenshots/tutorial-rans-results.png)
