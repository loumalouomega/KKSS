# Partitioned flow past a flexible wall (Mok benchmark)

**Fluid-structure interaction.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Model the Mok benchmark (Mok 2001, Valdés 2007; the Kratos `fsi_mok` validation case) as two planar XY faces in CAD millimetres: a 1.75 × 0.5 m convergent channel with the flexible wall’s slot cut out of its bottom, and the wall itself (500..505 × 0..250 mm, clamped at its base). Draw the channel boundary counterclockwise — base, up and over the slot, down the convergent ramp (28 stations sampled from the benchmark’s own boundary, each within 0.01 mm of it), the flat bottom at y = 300 mm, the outlet riser, the slip top and the inlet side — close it, add the wall’s 5 mm bottom line, and build the fluid face from the loop and the wall face from the bottom line plus the three slot edges. Name the faces `Fluid` and `Structure`; name x = 0 `Inlet`, x = 1750 mm `Outlet`, the base, ramp and flat bottom `Walls`, the y = 500 mm top `Slip`, the wall base `Fixed`, and the three slot edges `Interface` once — marked as the coupling surface on both sides, so one shared Part serves both solvers. Use a 2D first-order mesh, global min/max sizes 2/40 mm, 1.5 mm on the wall, grading the fluid from 2 mm at the interface to 30 mm far away, and export to metres. Assign the Newtonian 2D fluid (density 956 kg/m³, dynamic viscosity 0.145 Pa·s), the plane-stress wall (density 1500 kg/m³, E = 2.3 MPa, ν = 0.45, unit thickness), fix `Fixed`, and hold every outer fluid boundary with ALE mesh displacement so only the wall interface moves. The inlet is two-phase: the ramp parabola `0.1214·(1−cos(0.1·π·t))·y·(1−y)` until t = 10 s, then the steady `0.2428·y·(1−y)` to the end.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Draw the channel boundary with the **Polyline** sketch operation, counterclockwise: base from **(0, 0)** to **(500, 0) mm**, up the wall slot to **(500, 250)** and **(505, 250) mm**, down to **(505, 0) mm**, along the convergent ramp through the 28 stations (x = 505…1350 mm, y = 0…300 mm) to **(1350, 300) mm**, the flat bottom to **(1750, 300) mm**, up the outlet to **(1750, 500) mm**, across the top to **(0, 500) mm**, and close down the inlet side. Add the wall's bottom **Line** from **(500, 0)** to **(505, 0) mm**, then build the fluid face from the closed loop and the wall face from the bottom line plus the three slot edges.
2. Under **Parts**, name the fluid face `Fluid` and the wall face `Structure` (mesh size **1.5 mm**). Name x = 0 `Inlet`, x = 1750 mm `Outlet`, the base, ramp and flat bottom `Walls`, the top `Slip`, the wall base `Fixed`, and the three slot edges `Interface` once — marked as the coupling surface on both sides — with fluid grading from **2 mm** at the wall to **30 mm** far away. Use **Surf** selection for the faces and **Line** selection for boundaries.
3. Under **FE Mesh**, choose Gmsh, 2D, first order, global size min/max **2/40 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`. One mesh holds both faces; Generate slices it into fluid and structure meshes. The export fragments the touching faces so the shared slot edges mesh once — the conformal path that keeps every interface condition attached to elements on both sides.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Fluid-Structure Interaction** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 1.75 × 0.5 m convergent channel; fluid face with wall slot; wall 5 × 250 mm clamped at its base; 5116 fluid nodes / 9795 triangles, 516 structure nodes / 774 triangles |
| Problemtype values and physics | MVQN partitioned FSI; monolithic Bossak VMS fluid; dynamic non-linear Bossak total-Lagrangian structure; Δt 0.05 s; end 25 s; 500 steps; two-phase parabolic inlet (ramp to 10 s, steady after); outlet 0 Pa; no-slip base/ramp/bottom; slip top; ALE outer boundary; ρ 956 kg/m³; μ 0.145 Pa·s; E 2.3 MPa; ν 0.45 |
| Solver/output | MVQN partitioned FSI; 500 steps of Δt 0.05 s; per-participant VTK every 10 steps (`VELOCITY`, `PRESSURE`, `MESH_DISPLACEMENT` fluid; `DISPLACEMENT`, `REACTION` structure) plus `kkss-convergence-v2.jsonl` coupling history |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **FSIApplication plus FluidDynamicsApplication, StructuralMechanicsApplication, MappingApplication and MeshMovingApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, both materials files and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. Two VTK tabs open, one per participant. In each, click **Field**, select `VELOCITY` (fluid) or `DISPLACEMENT` (structure), and use the timeline to choose the final step. The values below came from the verified final frame.

## Plot the wall-tip history against the benchmark

1. Extract [`fsi.zip`](/examples/tutorials/fsi.zip), open `vtk_output/Structure_0_10.vtk`, and click **Plots → Load recipe**. Select `plots/tip-displacement-history.json`. Keep the complete directory: recipe paths are relative, and the history source walks all fifty `Structure_0_*.vtk` frames.
2. The curve tracks point A, the wall tip at approximately **(0.5, 0.25, 0) m** (recipe node **2**). The recipe converts SI metres to millimetres: the tip rises to **77.93 mm at 8.5 s** and settles to **58.05 mm at 25 s**, against the published **83 mm at about 9.5 s** and **62 mm at 25 s**. The exported CSV keeps both the original metres and the converted millimetres.
3. For the wall load, open `vtk_output/FluidModelPart_0_10.vtk` and load `plots/pressure-history.json`: pressure just upstream of the wall, rising with the ramp and steady after t = 10 s.
4. The x axis is reconstructed from the saved step labels at 0.05 s per step with every 10th step saved, giving **0.5, 1.0, …, 25.0 s**. Fifty disk samples cover the ramp, the peak and the settled oscillation: read the benchmark comparison, not a periodic regime.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

The 25 s run bends the wall downstream and lets it settle: point A, the wall tip at (0.500, 0.250) m, reaches 7.793 cm at t = 8.5 s against the published 8.3 cm at about 9.5 s (error 5.1 mm), and settles to 5.805 cm at t = 25 s against the published 6.2 cm (error 3.9 mm). The final frame holds the steady inlet parabola exactly (error 2.6 × 10⁻⁹ m/s) and the 0 Pa outlet (error 0); the ALE area balance — net inlet/outlet flux against the moving-domain area change — closes to 0.15 % of the delivered area, and the MVQN coupling converged all 500 steps (mean 4.1 interface iterations, at most 10, none unconverged). Acceptance limits: inlet profile error ≤ 1e-6 m/s, outlet pressure error ≤ 1e-6 Pa, area-balance error ≤ 0.02 of the delivered area, tip peak within 20 mm of 8.3 cm, tip final within 15 mm of 6.2 cm. The case runs Δt = 0.05 s: at Δt = 0.1 s the structure Newton stops converging at t ≈ 4 s on this Kratos build (the upstream Kratos-7.0 files diverge here too, at t ≈ 6.7 s). In **Field**, open the final fluid frame for `VELOCITY`; open the final structure frame, enable **Deformed** on `DISPLACEMENT` at **Warp scale** 1× — the centimetre bend needs no exaggeration — and press `5` for the front view.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 5632 nodes and 10569 cells. The run wrote 50 output frame(s) through t = 25 s. [Download this runnable case](/examples/tutorials/fsi.zip); the folder contains the CAD source, sketch SVG, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-fsi-geometry.png)

![Problemtype setup](/screenshots/tutorial-fsi-setup.png)

![Fluid velocity viewed in KKSS](/screenshots/tutorial-fsi-results.png)

![Structure displacement viewed in KKSS](/screenshots/tutorial-fsi-structure.png)

![Fluid velocity over the coupled steps](/screenshots/tutorial-fsi-velocity.gif)

![Interface displacement over the coupled steps](/screenshots/tutorial-fsi-displacement.gif)
