# Uniform potential flow

**Potential flow.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Create the same 4 × 1 m planar XY rectangle and 0.2 m mesh. Name its face Domain and all four edges Boundary. Assign Domain as the fluid region and Boundary as the far field. Set incompressible formulation, angle of attack 0 rad, Mach infinity 0.03, and sound speed 340 m/s. No material assignment is needed.

1. In CAD mode, select the **Rectangle** sketch operation (or open the supplied block fixture for the solid cases). Enter the stated dimensions in CAD millimetres. For a planar face use center **(2000, 500, 0) mm**, normal **(0, 0, 1)** and up **(1, 0, 0)**.
2. Under **Parts**, name the face and edges exactly as shown. Use the entity tree and selection highlights to identify edges; on the supplied block use the listed face ids.
3. Under **FE Mesh**, use Gmsh, dimension 2D, first order, size min/max **200 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Potential flow** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 4 × 1 m XY; face Domain; outer edges Boundary |
| Problemtype values and physics | Incompressible; angle 0 rad; Mach 0.03; sound speed 340 m/s; output `VELOCITY_POTENTIAL` |
| Solver/output | built-in solver and its documented VTK fields |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **CompressiblePotentialFlowApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose the final step. The values below came from the verified final frame.

## Scientific plots

Build plots from your own run in the app: open a result, choose **Plots → New recipe**, and see [scientific plots](scientific-plots) for the builder, units and CSV export.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

The imposed free-stream speed is 10.2 m/s. The maximum elementwise error in the gradient of `VELOCITY_POTENTIAL` compared with [10.2, 0] m/s is 0.000033 m/s.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 150 nodes and 248 cells. The run wrote 1 output frame(s) through t = 1 s. [Download this runnable case](/examples/tutorials/potential-flow.zip); the folder contains the CAD source, generation setup and generated case, with SHA-256 provenance and the solver verification record. Run the case to reproduce its VTK timeline locally. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-potential-flow-geometry.png)

![Problemtype setup](/screenshots/tutorial-potential-flow-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-potential-flow-results.png)
