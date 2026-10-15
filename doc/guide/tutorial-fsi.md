# Partitioned flow over an elastic slab

**Fluid-structure interaction.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Model two touching boxes sharing the y = 0 face: a 2.0 × 0.6 × 0.1 m fluid channel over an end-supported 2.0 × 0.05 × 0.1 m structure slab. Name the upper volume `Fluid` and the lower volume `Structure`; name the fluid faces x = 0 `Inlet` and x = 2000 mm `Outlet`, the top, front and back faces `Walls`, the shared y = 0 face `Interface` (marked as the coupling surface on both sides), and the structure end faces x = 0 and x = 2000 mm `Fixed` (the slab bends between its supports; the underside stays free). Use a 3D first-order tetrahedral mesh, uniform global size 100 mm, and export to metres. Assign the Newtonian fluid (density 1000 kg/m³, dynamic viscosity 0.6 Pa·s, inlet 0.1 m/s +X, outlet 0 Pa, slip walls) and the elastic slab (density 1000 kg/m³, E = 500 MPa, ν = 0.3); fix `Fixed` and hold the outer fluid boundaries with ALE mesh displacement.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Use the **Box** sketch operation twice: a 2000 × 600 × 100 mm fluid channel (center **(1000, 300, 50) mm**) over a 2000 × 50 × 100 mm structure slab (center **(1000, −25, 50) mm**), end-supported. The boxes touch at the y = 0 face; the export fragments the touching volumes so the shared face meshes once.
2. Under **Parts**, name the upper volume `Fluid` and the lower volume `Structure`. Name the fluid faces x = 0 `Inlet` and x = 2000 mm `Outlet`; name the top (y = 600 mm), front and back faces `Walls`; name the shared y = 0 face `Interface` once — it is marked as the coupling surface on both sides — and the structure's end faces x = 0 and x = 2000 mm `Fixed`. Use **Solid** selection for the bodies and **Surf** selection for boundaries.
3. Under **FE Mesh**, choose Gmsh, 3D, first order tetrahedra, global size min/max **100/100 mm** (uniform: the shared interface face must mesh identically from both volumes, so no grading). Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`. One mesh holds both bodies; Generate slices it into fluid and structure meshes.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Fluid-Structure Interaction** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 2.0 × 0.6 × 0.1 m fluid over end-supported 2.0 × 0.05 × 0.1 m slab; shared y = 0 face; 561 nodes (392 fluid + 169 structure) |
| Problemtype values and physics | Partitioned Dirichlet-Neumann; monolithic Bossak fluid and dynamic non-linear Bossak structure; Δt 0.05 s; end 0.15 s; 3 steps; relaxation/Aitken; ALE structural-similarity mesh motion |
| Solver/output | partitioned Dirichlet-Neumann FSI; 3 steps of Δt 0.05 s; per-participant VTK (`VELOCITY`, `PRESSURE`, `MESH_DISPLACEMENT` fluid; `DISPLACEMENT`, `REACTION` structure) plus `kkss-convergence-v2.jsonl` coupling history |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **FSIApplication plus FluidDynamicsApplication, StructuralMechanicsApplication, MappingApplication and MeshMovingApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, both materials files and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. Two VTK tabs open, one per participant. In each, click **Field**, select `VELOCITY` (fluid) or `DISPLACEMENT` (structure), and use the timeline to choose the final step. The values below came from the verified final frame.

## Plot interface motion and wall pressure

1. Extract [`fsi.zip`](/examples/tutorials/fsi.zip), open `vtk_output/Structure_0_1.vtk`, and click **Plots → Load recipe**. Select `plots/interface-displacement-history.json`. Keep the complete directory: recipe paths are relative, and the history source walks the three `Structure_0_*.vtk` frames.
2. The curve tracks interface node **89** at approximately **(1.05, 0, 0.05) m** — mid-span on the coupling face, where the slab travels furthest. The recipe converts SI metres to millimetres: Y reads **−0.996**, **−2.274** then **−1.670 mm**, all downward, away from the channel. The exported CSV keeps both the original metres and the converted millimetres.
3. For the wall load, open `vtk_output/FluidModelPart_0_1.vtk` and load `plots/pressure-history.json`. The same mid-span point is fluid node **121**: pressure reads **573**, **1706** then **1275 Pa** over the three steps — an impulsive-start transient consistent with the slab's downward push.
4. The x axis is reconstructed from the saved step labels at 0.05 s per step, giving **0.05, 0.10 and 0.15 s**. Three disk samples are all the coupled run saved: read the startup transient, not a periodic regime. The same frames back the check above.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

Three steps of 0.05 s bend the slab away from the channel: the mid-interface node moves 0.996, 2.274 then 1.670 mm down (peak final-frame displacement 1.676 mm), driven by the wall-pressure transient at the probe node (573 Pa at the first frame, 1275 Pa at the last). The inlet holds its 0.1 m/s profile exactly (error 0) and the outlet its 0 Pa (error 0); the outlet is not quiescent (0.14 m/s mean axial speed) because an incompressible solve pushes the inflow straight through. The ALE mass balance — outlet flux against inlet flux plus the sweeping slab — closes to 6.8 % of the delivered volume, and the partitioned Dirichlet-Neumann coupling converged every step in 6, 7 and 6 interface iterations. Acceptance limits: inlet velocity error ≤ 1e-6 m/s, outlet pressure error ≤ 1e-6 Pa, mass-balance error ≤ 0.35 of the delivered volume, peak structure displacement in [1e-7, 0.02] m, and at least one coupling iteration per step.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 561 nodes and 1436 cells. The run wrote 3 output frame(s) through t = 0.15 s. [Download this runnable case](/examples/tutorials/fsi.zip); the folder contains the CAD source, sketch SVG, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-fsi-geometry.png)

![Problemtype setup](/screenshots/tutorial-fsi-setup.png)

![Fluid velocity viewed in KKSS](/screenshots/tutorial-fsi-results.png)

![Structure displacement viewed in KKSS](/screenshots/tutorial-fsi-structure.png)

![Fluid velocity over the coupled steps](/screenshots/tutorial-fsi-velocity.gif)

![Interface displacement over the coupled steps](/screenshots/tutorial-fsi-displacement.gif)
