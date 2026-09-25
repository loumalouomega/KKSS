# Still-water basin

**Shallow water.** This walkthrough starts from geometry and ends with a solver-produced field. Lengths, time, mass and temperature use SI after CAD mesh export unless the table says mm. Follow the steps with the built-in example or download the complete case.

## Create the model and mesh

Create the 4 × 1 m planar XY rectangle (never mesh a solid skin for this 2D case). Name its face Domain and all four edges Boundary. Use a 0.2 m mesh; material Manning coefficient 0.01. Set a flat topography `z(x,y) = 0`, initialize `HEIGHT = 1 m`, and apply slip to Boundary.

1. Open `cad/examples/BREP/blank.brep` in CAD mode. Under **Edits → GEOMETRY → 2D**, click **Rectangle**. Set center **(2000, 500, 0) mm**, normal **(0, 0, 1)**, up **(1, 0, 0)**, width **4000 mm** and height **1000 mm**, then click **Apply**. The flat XY face appears under **Sketches**; this is a planar mesh, not a solid skin.
2. Under **Parts**, assign the sketch face to `Domain` and all four boundary edges to `Boundary`. Use **Surf** selection for the face and **Line** selection for the edges.
3. Under **FE Mesh**, use Gmsh, dimension 2D, first order, size min/max **200 mm**. Choose **MDPA Elements**, export units **m**, and export as `mesh.mdpa`.
4. Open the exported file in Post-Processing. The Problemtype section is populated from the mesh’s named SubModelParts. Select **Shallow water** and enter the case setup below.

## Set up, generate and run

| Setting | Value |
|---|---|
| Geometry and SubModelParts | 4 × 1 m XY; face Domain; outer edges Boundary |
| Problemtype values and physics | Δt 0.015625 s; end 0.125 s; flat topography; initial height 1 m; gravity 9.81 m/s²; Manning 0.01 |
| Solver/output | `stabilized_shallow_water_solver`; residual-viscosity shock capturing (factor 0.5); VTK every step with `HEIGHT`, `MOMENTUM` and `VELOCITY`; 8 frames |
| Python | Point **Settings → Simulation → kratos.pythonPath** at a Python environment that imports Kratos Multiphysics and **ShallowWaterApplication** |

Click **Generate case files**. This writes `ProjectParameters.json`, the materials file (when used), and `MainKratos.py` beside the mesh. Inspect generation warnings under the Problemtype panel. Click **Run case**; the embedded terminal shows solver output. The run record and log are saved alongside the case. A failed import usually means the selected Python environment lacks the named Kratos application.

When the run finishes, click **Open results**. In the VTK tab, click **Field**, select the listed field, and use the timeline to choose a step. The values below came from the verified final frame.

## Verified result

At t = 0.125 s, the basin retains 1 m depth. Momentum is below 3 × 10⁻¹⁵ m²/s, and the computed water volume is 4.000000 m³ (error below 10⁻¹⁵ m³).

Verification used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 150 nodes and 248 cells. The run wrote 8 output frame(s) through t = 0.125 s. [Download this runnable case](/examples/tutorials/shallow-water.zip); the folder contains the CAD source, edit/parts/mesh sidecars, generated case, VTK output and SHA-256 provenance. Downloaded cases are starting points: rerunning overwrites their generated outputs.

![CAD geometry and named parts](/screenshots/tutorial-shallow-water-geometry.png)

![Problemtype setup](/screenshots/tutorial-shallow-water-setup.png)

![Solver result viewed in KKSS](/screenshots/tutorial-shallow-water-results.png)
