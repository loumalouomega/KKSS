# Laminar flow around an obstacle

**Fluid dynamics.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Create a 2.0 × 0.6 m planar XY channel (CAD dimensions 2000 × 600 mm) with a 32-sided circular obstacle of radius 60 mm centered at (500, 300) mm. Import the [SVG sketch recipe](/examples/tutorials/fluid/obstacle-channel.svg), then select its four outer edges and 32 obstacle edges and build one face with the inner loop as a hole. Name the face `Domain`, x = 0 `Inlet`, x = 2000 mm `Outlet`, y = 0 and y = 600 mm `Walls`, and the hole loop `Obstacle`. Use a 2D first-order mesh, global min/max sizes 15/70 mm, and grade around Obstacle from 12 mm at its wall to 60 mm at 350 mm distance (12 mm through the first 25 mm). Export to metres. Set the Newtonian 2D material to density 1000 kg/m³ and dynamic viscosity 0.6 Pa·s; with inlet speed 0.1 m/s this gives Reynolds number 20 based on the 120 mm obstacle diameter. Keep the monolithic formulation on **Classic VMS (legacy)** with time scheme **Bossak** — published with the case, and the BDF2 default of the built-in segfaults the tier4 runtime's Kratos 10.4.3 at the first solution step.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Choose **File → Import SVG…** and open [`obstacle-channel.svg`](/examples/tutorials/fluid/obstacle-channel.svg). The recipe creates a 2000 × 600 mm channel and a 32-segment, 60 mm-radius obstacle centered at (500, 300) mm. Imported world coordinates are x = 0…2000 mm and y = 0…600 mm.
2. Switch to **Line** selection and select both loops. Choose **GEOMETRY → 2D → Surface → Build** to form one flat face with the inner loop as a hole. Confirm the preview shows one face with an opening.
3. Under **Parts**, name the face `Domain`; name x = 0 `Inlet`, x = 2000 mm `Outlet`, the y edges `Walls`, and the inner 32 edges `Obstacle`. Use **Surf** selection for the face and **Line** selection for boundaries.
4. Under **FE Mesh**, choose Gmsh, 2D, first order, global size min/max **15/70 mm**. In the `Obstacle` Part's **Grade** controls set size at wall **12 mm**, size far **60 mm**, distance near **25 mm**, and distance far **350 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`. This is a planar XY face mesh with a hole, not the surface mesh of a solid.
5. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Fluid dynamics** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 2.0 × 0.6 m XY; face Domain; edge parts Inlet, Outlet, Walls; 32-edge hole Obstacle; 945 nodes; 1766 triangles |
| Problemtype values and physics | Δt 0.1 s; end 5 s; 51 saved solver steps; no initial frame; monolithic classic-VMS (Bossak) element; inlet 0.1 m/s +X; outlet 0 Pa; slip walls; no-slip obstacle; ρ 1000 kg/m³; μ 0.6 Pa·s; Re 20 |
| Solver/output | 2D monolithic classic VMS (Bossak); maximum 20 iterations; VTK each 0.1 s step with `VELOCITY` and `PRESSURE` |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **FluidDynamicsApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose the final step. The values below came from the verified final frame.

## Scientific plots

Build plots from your own run in the app: open a result, choose **Plots → New recipe**, and see [scientific plots](scientific-plots) for the builder, units and CSV export.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

In the final saved frame, the near-wake sample has a minimum axial velocity of −0.00475046 m/s against the +0.1 m/s inlet, and 32 obstacle boundary nodes satisfy no-slip exactly. Pressure ranges from −7.23421 to 9.28020 Pa with the outlet fixed at 0 Pa. Inlet/outlet fluxes are 0.0600000020 and 0.0600000018 m²/s per metre of depth (difference 2.40 × 10⁻¹⁰ m²/s). The acceptance limits are a near-wake velocity deficit ≥ 0.025 m/s, pressure range ≥ 0.05 Pa, no-slip speed ≤ 2 × 10⁻⁵ m/s, and flux imbalance ≤ 0.001 m²/s.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 945 nodes and 1766 cells. The run wrote 51 output frame(s) with configured end time 5 s. [Download this runnable case](/examples/tutorials/fluid.zip); the folder contains the CAD source, generation setup and generated case, with SHA-256 provenance and the solver verification record. Run the case to reproduce its VTK timeline locally. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-fluid-geometry.png)

![Problemtype setup](/screenshots/tutorial-fluid-setup.png)

![Velocity wake behind the obstacle in KKSS](/screenshots/tutorial-fluid-results.png)

![Pressure around the obstacle in KKSS](/screenshots/tutorial-fluid-pressure.png)

![Velocity magnitude from step 1 to 51 on a fixed 0–0.17 m/s scale](/screenshots/tutorial-fluid-velocity.gif)

![Pressure from step 5 to 51 on a fixed ±10 Pa scale](/screenshots/tutorial-fluid-pressure.gif)
