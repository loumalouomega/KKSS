# Uniform potential flow

**Potential flow.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Create the same 4 × 1 m planar XY rectangle and 0.2 m mesh. Name its face Domain and all four edges Boundary. Assign Domain as the fluid region and Boundary as the far field. Set incompressible formulation, angle of attack 0 rad, Mach infinity 0.03, and sound speed 340 m/s. No material assignment is needed.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Under **Edits → GEOMETRY → 2D**, click **Rectangle**. Set center **(2000, 500, 0) mm**, normal **(0, 0, 1)**, up **(1, 0, 0)**, width **4000 mm** and height **1000 mm**, then click **Apply**. The flat face appears under **Sketches**.
2. Under **Parts**, assign the sketch face to `Domain` and all four boundary edges to `Boundary`. Use **Surf** selection for the face and **Line** selection for the edges.
3. Under **FE Mesh**, use Gmsh, dimension 2D, first order, size min/max **200 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Potential flow** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 4 × 1 m XY; face Domain; outer edges Boundary |
| Problemtype values and physics | Incompressible; angle 0 rad; Mach 0.03; sound speed 340 m/s; output `VELOCITY_POTENTIAL` |
| Solver/output | 2D `potential_flow`; maximum 10 iterations; final VTK frame at t = 1 s with `VELOCITY_POTENTIAL` and `AUXILIARY_VELOCITY_POTENTIAL` |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **CompressiblePotentialFlowApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Click **Run case**; the embedded terminal shows solver output. The run record and log are saved alongside the case. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose a step. The values below came from the verified final frame.

## Verified result

The imposed free-stream speed is 10.2 m/s. The maximum elementwise error in the gradient of `VELOCITY_POTENTIAL` compared with [10.2, 0] m/s is 0.000033 m/s.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 150 nodes and 248 cells. The run wrote 1 output frame(s) through t = 1 s. [Download this runnable case](/examples/tutorials/potential-flow.zip); the folder contains the CAD source, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-potential-flow-geometry.png)

![Problemtype setup](/screenshots/tutorial-potential-flow-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-potential-flow-results.png)
