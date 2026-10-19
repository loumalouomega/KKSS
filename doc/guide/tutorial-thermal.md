# Stationary heat conduction

**Convection-diffusion.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Use the 3 × 4 × 5 mm `block.stp` as a solid. Name `solid-0` Domain, `face-3` Cold (−X), and `face-5` Hot (+X). Mesh with 0.8 mm tetrahedra and export to metres. Assign conductivity 1 W/(m·K), density 1000 kg/m³, and specific heat 1000 J/(kg·K).

1. In CAD mode, select the **Rectangle** sketch operation (or open the supplied block fixture for the solid cases). Enter the stated dimensions in CAD millimetres. For a planar face use center **(2000, 500, 0) mm**, normal **(0, 0, 1)** and up **(1, 0, 0)**.
2. Under **Parts**, name the face and edges exactly as shown. Use the entity tree and selection highlights to identify edges; on the supplied block use the listed face ids.
3. Under **FE Mesh**, use Gmsh, dimension 3D, first order, size min/max **0.8 mm**. Choose **MDPA Elements**, export units **mm → m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Convection-diffusion** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 3 × 4 × 5 mm block; body Domain; ends Cold (300 K) / Hot (400 K) |
| Problemtype values and physics | Stationary; time value 1 s; conductivity 1 W/(m·K); density 1000 kg/m³; specific heat 1000 J/(kg·K) |
| Solver/output | built-in solver and its documented VTK fields |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **ConvectionDiffusionApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose the final step. The values below came from the verified final frame.

## Scientific plots

Build plots from your own run in the app: open a result, choose **Plots → New recipe**, and see [scientific plots](scientific-plots) for the builder, units and CSV export.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

The generated stationary Laplacian solve gives 300 K on the cold end and 400 K on the hot end. The maximum difference from the linear temperature profile is 0.000019 K.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 263 nodes and 814 cells. The run wrote 1 output frame(s) through t = 1 s. [Download this runnable case](/examples/tutorials/thermal.zip); the folder contains the CAD source, generation setup and generated case, with SHA-256 provenance and the solver verification record. Run the case to reproduce its VTK timeline locally. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-thermal-geometry.png)

![Problemtype setup](/screenshots/tutorial-thermal-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-thermal-results.png)
