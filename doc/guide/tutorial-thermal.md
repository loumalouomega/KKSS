# Stationary heat conduction

**Convection-diffusion.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Use the 3 × 4 × 5 mm `block.stp` as a solid. Name `solid-0` Domain, `face-3` Cold (−X), and `face-5` Hot (+X). Mesh with 0.8 mm tetrahedra and export to metres. Assign conductivity 1 W/(m·K), density 1000 kg/m³, and specific heat 1000 J/(kg·K). Leave the four lateral faces unassigned; the natural boundary condition is insulated (zero heat flux).

1. Open `cad/examples/STP/block.stp` in CAD mode. It is already the required 3 × 4 × 5 mm body; do not scale it. The downloadable case contains this source geometry and its mesh settings.
2. Under **Parts**, assign the volume `solid-0` to `Domain`, the −X face `face-3` to `Cold`, and the +X face `face-5` to `Hot`. Use **Vol** selection for the body and **Surf** selection for the two end faces.
3. Under **FE Mesh**, use Gmsh, dimension 3D, first order, size min/max **0.8 mm**. Choose **MDPA Elements**, export units **mm → m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Convection-diffusion** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 3 × 4 × 5 mm block; body Domain; ends Cold (300 K) / Hot (400 K) |
| Problemtype values and physics | Stationary 3D linear Laplacian; end time 1 s; conductivity 1 W/(m·K); density 1000 kg/m³; specific heat 1000 J/(kg·K) |
| Solver/output | `LaplacianElement`; one final VTK frame at t = 1 s with `TEMPERATURE` |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **ConvectionDiffusionApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Click **Run case**; the embedded terminal shows solver output. The run record and log are saved alongside the case. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose a step. The values below came from the verified final frame.

## Verified result

The generated stationary Laplacian solve gives 300 K on the cold end and 400 K on the hot end. The maximum difference from the linear temperature profile is 0.000019 K.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 263 nodes and 814 cells. The run wrote 1 output frame(s) through t = 1 s. [Download this runnable case](/examples/tutorials/thermal.zip); the folder contains the CAD source, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-thermal-geometry.png)

![Problemtype setup](/screenshots/tutorial-thermal-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-thermal-results.png)
