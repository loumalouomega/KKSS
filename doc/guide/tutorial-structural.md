# Structural cantilever

**Structural mechanics.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

The shipped [`block.stp`](/guide/cad-mode) is 3 × 4 × 5 mm. Scale it sixfold along X to make an 18 mm long cantilever. Fix `face-3` (the −X end) and apply positive 100 kPa pressure on `face-1` (the −Z broad face). The model uses E = 210 GPa, ν = 0.3 and a 0.8 mm tetrahedral mesh; density is unused in this static example.

1. In CAD mode, select the **Rectangle** sketch operation (or open the supplied block fixture for the solid cases). Enter the stated dimensions in CAD millimetres. For a planar face use center **(2000, 500, 0) mm**, normal **(0, 0, 1)** and up **(1, 0, 0)**.
2. Under **Parts**, name the face and edges exactly as shown. Use the entity tree and selection highlights to identify edges; on the supplied block use the listed face ids.
3. Under **FE Mesh**, use Gmsh, dimension 3D, first order, size min/max **0.8 mm**. Choose **MDPA Elements**, export units **m (convert from CAD mm)**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Structural mechanics** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 18 × 4 × 5 mm (0.018 × 0.004 × 0.005 m); block.stp scaled by [6,1,1]; body Solid; Support face-3; Load face-1 |
| Problemtype values and physics | analysisType non_linear; end time 1 s; Δt 0.125 s; 8 frames; 210 GPa; ν 0.3; pressure 100 kPa |
| Solver/output | non-linear static mechanics; 8 frames; VTK `DISPLACEMENT` and `VON_MISES_STRESS` |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **StructuralMechanicsApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose the final step. The values below came from the verified final frame.

## Plot displacement and reactions

Extract [structural.zip](/examples/tutorials/structural.zip), open a result in `vtk_output/`, and choose **Plots → Load recipe → plots/displacement-history.json**. It selects the published result node with the largest absolute Z displacement and overlays its eight disk samples, explicitly converting m to mm. The saved final value is **+0.000589148 mm**: the pressure sign and face-normal convention in this archive produce positive Z displacement and negative Z support reactions. Selected ID/coordinates and input hashes are recorded in `plots/verification.json`; choose a new tip node after remeshing rather than reusing that ID.

Load `plots/reaction-history.json` for the **signed whole-mesh sum of supplied nodal `REACTION Z`**, approximately **−7.2000323 N** in the final output. This is not a sum of magnitudes, a traction integral, or an inferred support region. To restrict a reaction curve to `Support`, the loaded result must actually retain that part's nodal membership. The ordinary VTK output here does not carry the input MDPA's named parts.

The X axis is **static-analysis pseudo-time**, reconstructed from the fixed 0.125 s steps, not a transient vibration response. A constant applied load makes the nearly unchanged later displacement/reaction samples expected. **CSV + metadata** and **PNG / SVG** export the analysis; full-resolution CSV and provenance already accompany both recipes. See [scientific plots](scientific-plots) for multi-point and regional workflows.

![Solver-derived cantilever displacement history in KKSS](/screenshots/tutorial-structural-displacement-plot.png)

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

DISPLACEMENT z is +0.000589 mm at the free corner; the Euler–Bernoulli reference magnitude is 0.000600 mm. The maximum relative displacement error is 1.79%, within the 25% coarse-mesh tutorial tolerance. In **Field**, click **TOP** on the orientation cube (or press `3`) to see the X–Z bending plane, enable **Deformed**, set **Deform by** to `DISPLACEMENT`, and use **Warp scale** 1000× to make the sub-micron deflection visible; this scale changes only the display. Select `VON_MISES_STRESS` to inspect the stress field.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 1048 nodes and 3896 cells. The run wrote 8 output frame(s) through t = 1 s. [Download this runnable case](/examples/tutorials/structural.zip); the folder contains the CAD source, sketch SVG, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-structural-geometry.png)

![Problemtype setup](/screenshots/tutorial-structural-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-structural-results.png)

![Displacement field on the deformed cantilever at 1000× warp scale](/screenshots/tutorial-structural-deformed.png)

![Von Mises stress field on the deformed cantilever](/screenshots/tutorial-structural-stress.png)
