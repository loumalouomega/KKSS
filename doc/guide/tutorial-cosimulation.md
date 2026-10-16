# Weak CoSimulation flow over an elastic slab

**Partitioned coupling.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Model two touching boxes sharing the y = 0 face: a 2.0 × 0.6 × 0.1 m fluid channel over an end-supported 2.0 × 0.05 × 0.1 m structure slab. Name the upper volume `Fluid` and the lower volume `Structure`; name the fluid faces x = 0 `Inlet` and x = 2000 mm `Outlet`, the top, front and back faces `Walls`, the shared y = 0 face `Interface` (marked as the coupling surface on both sides), and the structure end faces x = 0 and x = 2000 mm `Fixed`. Mesh both volumes with uniform 100 mm tetrahedra and export to metres. Assign the Newtonian fluid (density 1000 kg/m³, dynamic viscosity 0.6 Pa·s, inlet 0.1 m/s +X, outlet 0 Pa, slip walls) and the elastic slab (density 1000 kg/m³, E = 500 MPa, ν = 0.3); fix `Fixed` and hold the outer fluid boundaries with ALE mesh displacement. Select **Generic Coupling (CoSimulation)**: weak coupling (one data exchange per step, no convergence criterion), average-value predictor, nearest-element mapper, ALE mesh motion on. Strong coupling is the same case with **Coupling** set to strong (which then iterates to the relative-norm criterion with the MVQN accelerator).

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Use the **Box** sketch operation twice: a 2000 × 600 × 100 mm fluid channel (center **(1000, 300, 50) mm**) over a 2000 × 50 × 100 mm structure slab (center **(1000, −25, 50) mm**), end-supported. The boxes touch at the y = 0 face; the export fragments the touching volumes so the shared face meshes once.
2. Under **Parts**, name the upper volume `Fluid` and the lower volume `Structure`. Name the fluid faces x = 0 `Inlet` and x = 2000 mm `Outlet`; name the top (y = 600 mm), front and back faces `Walls`; name the shared y = 0 face `Interface` once — it is marked as the coupling surface on both sides — and the structure's end faces x = 0 and x = 2000 mm `Fixed`. Use **Solid** selection for the bodies and **Surf** selection for boundaries.
3. Under **FE Mesh**, choose Gmsh, 3D, first order tetrahedra, global size min/max **100/100 mm** (uniform: the shared interface face must mesh identically from both volumes, so no grading). Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`. One mesh holds both bodies; Generate slices it into fluid and structure meshes.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Generic Coupling (CoSimulation)** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 2.0 × 0.6 × 0.1 m fluid over end-supported 2.0 × 0.05 × 0.1 m slab; shared y = 0 face; 561 nodes (392 fluid + 169 structure) |
| Problemtype values and physics | Weak gauss-seidel coupling; monolithic Bossak fluid and dynamic non-linear Bossak structure; Δt 0.05 s; end 0.15 s; 3 steps; ALE structural-similarity mesh motion |
| Solver/output | weak partitioned CoSimulation; 3 steps of Δt 0.05 s; per-participant VTK plus `kkss-convergence-v2.jsonl` coupling history |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **CoSimulationApplication plus FluidDynamicsApplication, StructuralMechanicsApplication, MappingApplication and MeshMovingApplication** |

Click **Generate case files**. This writes `ProjectParametersCoSim.json`, `ProjectParametersCFD.json`, `ProjectParametersCSM.json`, both materials files and `MainKratosCoSim.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Set the interpreter through **Settings → Simulation → kratos.pythonPath**, then use the Home screen's **Check environment** action to confirm the required application is available. Click **Run case**; the embedded terminal shows solver progress and diagnostics. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. Two VTK tabs open, one per participant. In each, click **Field**, select `VELOCITY` (fluid) or `DISPLACEMENT` (structure), and use the timeline to choose the final step. The values below came from the verified final frame.

## Plot the single-exchange oscillation

1. Extract [`cosim.zip`](/examples/tutorials/cosim.zip), open `vtk_output/Structure_0_1.vtk`, and click **Plots → Load recipe**; select `plots/interface-displacement-history.json`. Keep the complete directory so relative paths resolve.
2. Interface node **89** at approximately **(1.05, 0, 0.05) m** reads **−1.904**, **−0.417** then **+1.543 mm**: the slab drops on the first exchange, springs back and overshoots its rest position. The [partitioned FSI run](tutorial-fsi), which sub-iterates every step to convergence, stays below zero instead.
3. For the wall load, open `vtk_output/FluidModelPart_0_1.vtk` and load `plots/pressure-history.json`: fluid node **121** reads **2869 Pa**, essentially zero (**−0.05 Pa**), then **−1581 Pa** — the load reverses as the slab crosses back through its rest position.
4. The x axis is reconstructed from the saved step labels at 0.05 s per step — **0.05, 0.10 and 0.15 s**. Three samples show the weak-coupling signature; they are not a period estimate.

## Post-run checks and batch

Before generating, the Problemtype sidebar preflights the setup as structured error/warning/info findings (`mesh__case_validate`); a clean report means the case generates. Stopping a run uses **File ▸ Stop Kratos Run**: a cooperative stop file the generated case watches between steps first (graceful Finalize on every platform), then SIGINT → SIGTERM → SIGKILL, reporting which rung worked. Finished runs carry a saved convergence history (`mesh__case_convergence` reads `kkss-convergence-v2.jsonl` with a conservative verdict; older archives report `status:"none"` as unavailable, not as failure) and named post-run monitors over their saved frames (`mesh__case_monitors` list/set/remove/evaluate; older archives list empty until set). Queued edits save/load as JSON recipes, and named presets from `.kratos/recipes/` (plus **Settings ▸ Kratos ▸ Batch Recipe Folders**) feed both the viewer batch and `mesh__mesh_batch_transform` (`dryRun` plans without writing; `<outputDir>/kkss-batch.json` records per-file reports). **Advanced ▸ Link previews…** ties two open meshes/runs so camera, field, range, clip and physical time follow each other.

## Verified result

One weak data exchange per step gives the same case a leapfrog oscillation: the mid-interface node swings −1.904, −0.417 then +1.543 mm, against a wall pressure of 2869 Pa at the first frame and −1581 Pa at the last (peak final-frame displacement 1.555 mm). The inlet profile (error 0) and the 0 Pa outlet (error 0) still hold, and the ALE mass balance closes to 19.6 % of the delivered volume — looser than the strongly coupled run, which sub-iterates the interface to convergence. The coupling log carries one iteration per step and no convergence criterion, by design: weak coupling exchanges the interface data once and does not iterate. Acceptance limits: inlet velocity error ≤ 1e-6 m/s, outlet pressure error ≤ 1e-6 Pa, mass-balance error ≤ 0.35 of the delivered volume, peak structure displacement in [1e-7, 0.02] m, and at least one coupling iteration per step. In **Field**, press `5` for the front view, enable **Deformed** on `DISPLACEMENT` and set **Warp scale** 200× to show the millimetre bend (display only).

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 561 nodes and 1436 cells. The run wrote 3 output frame(s) through t = 0.15 s. [Download this runnable case](/examples/tutorials/cosim.zip); the folder contains the CAD source, sketch SVG, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-cosim-geometry.png)

![Problemtype setup](/screenshots/tutorial-cosim-setup.png)

![Fluid velocity viewed in KKSS](/screenshots/tutorial-cosim-results.png)

![Structure displacement viewed in KKSS](/screenshots/tutorial-cosim-structure.png)

![Fluid velocity over the coupled steps](/screenshots/tutorial-cosim-velocity.gif)

![Interface displacement over the coupled steps](/screenshots/tutorial-cosim-displacement.gif)
