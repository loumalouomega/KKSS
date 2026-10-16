# Still-water basin

**Shallow water.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Create the 4 × 1 m planar XY rectangle (never mesh a solid skin for this 2D case). Name its face Domain and all four edges Boundary. Use a 0.2 m mesh; material Manning coefficient 0.01. Set a flat topography `z(x,y) = 0`, initialize `HEIGHT = 1 m`, and apply slip to Boundary.

1. In CAD mode, select the **Rectangle** sketch operation (or open the supplied block fixture for the solid cases). Enter the stated dimensions in CAD millimetres. For a planar face use center **(2000, 500, 0) mm**, normal **(0, 0, 1)** and up **(1, 0, 0)**.
2. Under **Parts**, name the face and edges exactly as shown. Use the entity tree and selection highlights to identify edges; on the supplied block use the listed face ids.
3. Under **FE Mesh**, use Gmsh, dimension 2D, first order, size min/max **200 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Shallow water** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 4 × 1 m XY; face Domain; outer edges Boundary |
| Problemtype values and physics | Δt 0.015625 s; end 0.125 s; flat topography; initial height 1 m; gravity 9.81 m/s²; Manning 0.01 |
| Solver/output | built-in solver and its documented VTK fields |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **ShallowWaterApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose the final step. The values below came from the verified final frame.

## Plot water depth over time

Extract [shallow-water.zip](/examples/tutorials/shallow-water.zip), open a VTK result, and choose **Plots → Load recipe → plots/depth-history.json**. It selects the published node nearest **(2, 0.5, 0) m** and plots all **eight `HEIGHT` samples**, remaining at **1 m**. The exact result ID/coordinates are recorded in `plots/verification.json`; remeshing requires a new point selection.

The recipe explicitly reconstructs **0.015625…0.125 s** from the fixed-step setup and supplies metres from the case convention. Add more points with **Add points from mesh** to compare basin locations, and export **CSV + metadata** or **PNG / SVG**. These nearly flat curves demonstrate the still-water case, not a propagating wave. A nodal sum/mean of height is not water volume: the **4 m³** check below uses element areas. The archive includes CSV and provenance; see [scientific plots](scientific-plots).

![Eight-frame still-water depth history in KKSS](/screenshots/tutorial-shallow-water-depth-plot.png)

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

At t = 0.125 s, the basin retains 1 m depth. Momentum is below 3 × 10⁻¹⁵ m²/s, and the computed water volume is 4.000000 m³ (error below 10⁻¹⁵ m³).

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 150 nodes and 248 cells. The run wrote 8 output frame(s) through t = 0.125 s. [Download this runnable case](/examples/tutorials/shallow-water.zip); the folder contains the CAD source, sketch SVG, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-shallow-water-geometry.png)

![Problemtype setup](/screenshots/tutorial-shallow-water-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-shallow-water-results.png)
