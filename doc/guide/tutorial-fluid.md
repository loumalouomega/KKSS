# Slip-wall channel

**Fluid dynamics.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Create a 4 × 1 m planar XY rectangle (CAD-native dimensions 4000 × 1000 mm). Name its face `Domain`, x = 0 edge `Left`, x = 4 edge `Right`, and the two y edges `Walls`. Use a 200 mm global mesh size (0.2 m after export). Set the Newtonian 2D material to density 1000 kg/m³ and dynamic viscosity 0.001 Pa·s.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Under **Edits → GEOMETRY → 2D**, click **Rectangle**. Set center **(2000, 500, 0) mm**, normal **(0, 0, 1)**, up **(1, 0, 0)**, width **4000 mm** and height **1000 mm**, then click **Apply**. The flat face appears under **Sketches**.
2. Under **Parts**, assign the sketch face to `Domain`; name the x = 0 edge `Left`, the x = 4000 mm edge `Right`, and the two y edges `Walls`. Use **Surf** selection for the face and **Line** selection for the boundary edges.
3. Under **FE Mesh**, use Gmsh, dimension 2D, first order, size min/max **200 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Fluid dynamics** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 4 × 1 m XY; face Domain; edges Left, Right, Walls |
| Problemtype values and physics | Δt 0.1 s; end 2 s; 20 frames; inlet 1 m/s +X; outlet 0 Pa; slip walls; ρ 1000 kg/m³; μ 0.001 Pa·s |
| Solver/output | 2D monolithic VMS; maximum 10 iterations; VTK each step with `VELOCITY` and `PRESSURE`; 20 frames |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **FluidDynamicsApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Click **Run case**; the embedded terminal shows solver output. The run record and log are saved alongside the case. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose a step. The values below came from the verified final frame.

## Verified result

At t = 2 s, the velocity is 1 m/s in +X across the channel. Inlet and outlet fluxes are each 1 m²/s per metre of depth; their measured difference is zero. Outlet pressure is 0 Pa.

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 150 nodes and 248 cells. The run wrote 20 output frame(s) through t = 2 s. [Download this runnable case](/examples/tutorials/fluid.zip); the folder contains the CAD source, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-fluid-geometry.png)

![Problemtype setup](/screenshots/tutorial-fluid-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-fluid-results.png)
