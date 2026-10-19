# Two-fluid dam break (generation-verified)

**Two Fluids.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Draw the 4 × 1 m tank as two touching XY rectangles in CAD millimetres: the water column (center (500, 500) mm, 1000 × 1000 mm) and the air (center (2500, 500) mm, 3000 × 1000 mm), sharing the x = 1000 mm edge. Build one face from each rectangle. Name both faces `Domain`, the water face additionally `Water`, and the six outer edges `Walls`. Use a 2D first-order mesh, global min/max sizes 50/50 mm, and export to metres. After export, compute the signed distance to the `Water` part into the nodal `DISTANCE` field (Variables ▸ Distance to a SubModelPart, or `mesh__mesh_transform` with `sdfDistance part=Water output=DISTANCE`): the interface is its zero, negative is water. Assign water then air on `Domain` (Newtonian 2D: water 1000 kg/m³, 1e-3 Pa·s; air 1.0 kg/m³, 1.8e-5 Pa·s), no-slip `Walls`.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Use the **Rectangle** sketch operation twice: the water column (center **(500, 500) mm**, 1000 × 1000 mm) and the air (center **(2500, 500) mm**, 3000 × 1000 mm), sharing the x = 1000 mm edge. Build one face from each rectangle.
2. Under **Parts**, name both faces `Domain`; name the water face additionally `Water`; name the six outer edges `Walls`. Use **Surf** selection for the faces and **Line** selection for boundaries.
3. Under **FE Mesh**, choose Gmsh, 2D, first order, global size min/max **50/50 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`.
4. After export, compute the interface field: open the mesh in Post-Processing and run **Variables ▸ Distance to a SubModelPart** against `Water` (or `mesh__mesh_transform` with `sdfDistance part=Water output=DISTANCE`). The zero of the nodal `DISTANCE` field is the interface; without it Generate refuses the case.
5. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Two Fluids** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 4 × 1 m XY tank; faces Domain (water face also Water); edge part Walls; 1977 nodes with nodal DISTANCE; water-then-air materials on Domain |
| Problemtype values and physics | Two-fluid level set (from_mdpa); water then air on Domain; no-slip tank; Δt 0.005 s (generation only — solver blocked upstream) |
| Solver/output | two-fluid level set (generation only — the stock serial solver cannot start) |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **FluidDynamicsApplication (generation only — the stock serial solver is blocked upstream)** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Do not click **Run case**: the stock serial solver cannot start (see the blocked note below). Generate only, then inspect the DISTANCE field on the case mesh.

Do not run the case: the stock serial solver cannot start (see the blocked note below). The interface below is the generated one.

## Scientific plots

Build plots from your own run in the app: open a result, choose **Plots → New recipe**, and see [scientific plots](scientific-plots) for the builder, units and CSV export.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

Generation-verified only. The generated mesh carries a nodal DISTANCE field that reads 0 on all 514 water nodes and rises to 3.0 m in the far air, and the materials sit water-then-air on the single Domain part, in solver order. The stock Kratos 10.4.3 serial Two Fluids solver cannot start: it imports `KratosMultiphysics.FluidDynamicsApplication.navier_stokes_two_fluid_solver`, which Kratos does not ship (only the plural module exists) — the reproducible `ModuleNotFoundError` is recorded in solver.log and BLOCKED.txt, and no solver results are published. The MPI path needs Trilinos and is out of scope for the pip runtime.

Generation verified with Python 3.12.14, Kratos 10.4.3, 1977 mesh nodes. No solver output exists; verification.json records the generation checks and the reproducible upstream ModuleNotFoundError. [Download this runnable case](/examples/tutorials/two-fluids.zip); the folder contains the CAD source, edit/parts/mesh sidecars, generated case, the BLOCKED.txt note and SHA-256 provenance.

![CAD geometry and named parts](/screenshots/tutorial-two-fluids-geometry.png)


