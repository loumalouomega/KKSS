# Cantilever eigenmodes

**Structural mechanics.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Use the same 3 × 4 × 5 mm `block.stp`, scaled sixfold along X to the 18 mm cantilever. Name `solid-0` Solid and `face-3` Support (the −X end); no load — a free vibration has none. Mesh with 0.8 mm tetrahedra and export to metres. Assign the linear-elastic 3D material (density 7850 kg/m³, E = 210 GPa, ν = 0.3).

1. In CAD mode, open the supplied block fixture `cad/examples/STP/block.stp` (3 × 4 × 5 mm). Choose the **Scale** edit operation on `solid-0`, center (0, 0, 0), factors [6, 1, 1]: the 18 mm cantilever.
2. Under **Parts**, name `solid-0` `Solid` and the −X end face `face-3` `Support`. No boundaries beyond the clamp: a free vibration has no load.
3. Under **FE Mesh**, choose Gmsh, 3D, first order tetrahedra, global size min/max **0.8/0.8 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Structural mechanics** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 18 × 4 × 5 mm (0.018 × 0.004 × 0.005 m); block.stp scaled by [6,1,1]; body Solid; Support face-3; 1048 nodes; 3896 tetrahedra |
| Problemtype values and physics | solverType eigen_value; Spectra shift-invert; 3 modes; tolerance 1e-6; clamped Support; steel ρ 7850 kg/m³, E 210 GPa, ν 0.3 |
| Solver/output | eigen_value with Spectra shift-invert; 3 modes printed to the solver log; no VTK timeline |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **StructuralMechanicsApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

There is no results timeline to open: eigenvalue runs print the EIGENVALUE_VECTOR to the solver log and write mode shapes beside the case. The frequencies below come from that vector.

## Scientific plots

See [scientific plots](scientific-plots) for downloadable case recipes.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

The eigensolver prints EIGENVALUE_VECTOR to the solver log — 4.51935e9, 6.49962e9 and 7.96731e10 — i.e. frequencies 10699.37, 12831.11 and 44923.75 Hz. The first two are the lateral and vertical bending modes: Euler–Bernoulli on the 18 × 4 × 5 mm beam predicts 10313.87 Hz laterally and 12892.34 Hz vertically, so the measured errors are 3.7% and 0.5%, within the 10% tolerance the 6:1 solid-mesh aspect ratio earns. The third mode is recorded, not checked.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 1048 nodes and 3896 cells. The run wrote no VTK timeline; verification.json records the three frequencies against Euler-Bernoulli. [Download this runnable case](/examples/tutorials/eigen.zip); the folder contains the CAD source, edit/parts/mesh sidecars, generated case and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-eigen-geometry.png)

![Problemtype setup](/screenshots/tutorial-eigen-setup.png)


