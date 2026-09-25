# Laminar flow around an obstacle

**Fluid dynamics.** This walkthrough starts in CAD and ends with a measured, solver-produced wake. The model is a planar XY channel 2.0 m long and 0.6 m high. A circular obstacle approximation with a 0.12 m diameter sits 0.5 m from the inlet, centered halfway between the walls. Geometry is authored in CAD millimetres; export the face mesh in metres for the SI solver.

## Create the geometry and mesh

1. Open `cad/examples/BREP/blank.brep` in Pre-Processing. Choose **File → Import SVG…** and open the downloadable [obstacle-channel.svg recipe](/examples/tutorials/fluid/obstacle-channel.svg). It creates the outer channel loop and a 32-segment circular inner loop. The file uses SVG's Y-down coordinates; KKSS imports these as a planar face sketch at x = 0…2000 mm and y = 0…600 mm.
2. Switch to **Line** selection and select all 36 edges: the four outer edges and 32 obstacle edges. In **Edits → GEOMETRY → 2D**, choose **Surface → Build**. This creates one planar face with the inner loop cut out. Confirm there is one face and a visible opening before meshing.
3. Under **Parts**, assign the face to `Domain`. Name the x = 0 edge `Inlet`, the x = 2000 mm edge `Outlet`, the two long edges at y = 0 and y = 600 mm `Walls`, and all 32 inner-loop edges `Obstacle`. Use **Surf** selection for the face and **Line** selection for the boundary parts.
4. Under **FE Mesh**, select Gmsh, dimension **2D**, first order, and global size min/max **15/70 mm**. In the `Obstacle` Part's **Grade** controls, set size at wall **12 mm**, size far **60 mm**, distance near **25 mm**, and distance far **350 mm**. Export **MDPA Elements** with units **m** as `mesh.mdpa`. This must be a planar XY face mesh with a hole; do not mesh a solid's surface.

The published mesh has 945 nodes and 1766 triangles. Your counts can differ slightly across Gmsh versions while retaining the same named regions and physical checks.

## Set up, generate and run

Open `mesh.mdpa` in Post-Processing and select **Fluid dynamics** in the Problemtype sidebar. Assign the fluid body to `Domain`, inlet velocity to `Inlet`, outlet pressure to `Outlet`, slip to `Walls`, and no-slip to `Obstacle`. Set the Newtonian 2D material to density **1000 kg/m³** and dynamic viscosity **0.6 Pa·s**. The 0.1 m/s inlet and 0.12 m obstacle diameter give a Reynolds number of **20**.

| Problemtype setting | Value |
|---|---|
| Time step / end time | 0.1 s / 5 s (50 steps) |
| Inlet | 0.1 m/s in +X |
| Outlet | 0 Pa |
| Top and bottom walls | Slip |
| Obstacle | No-slip |
| Fluid material | ρ = 1000 kg/m³; μ = 0.6 Pa·s |
| Solver | 2D monolithic VMS; maximum 20 iterations; echo level 0 |
| Output | VTK each step, fields `VELOCITY` and `PRESSURE` |
| Python | Set **Settings → Simulation → kratos.pythonPath** to a Python that imports Kratos and `FluidDynamicsApplication`; set `kratos.extraEnv` to `{"OMP_NUM_THREADS":"2"}` |

Click **Generate case files**. Check that there are no missing-part warnings and that `ProjectParameters.json` names the `Domain`, `Inlet`, `Outlet`, `Walls`, and `Obstacle` SubModelParts. If **Run case** is disabled, use the Home screen's **Check environment** action and configure `kratos.pythonPath`; a missing `FluidDynamicsApplication` diagnostic means that Python installation lacks the required application. Click **Run case** and watch the embedded terminal for time-step progress or solver errors.

After the solve completes, click **Open results**. In the VTK tab, click **Field** and select `VELOCITY` to see the wake; select `PRESSURE` to inspect pressure around the obstacle. Use the timeline to navigate to the last frame at **t = 5 s**. The field range and timeline correspond to actual solver output.

## Verified result

The baseline run used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 945 nodes, 1766 elements and 51 result frames through t = 5 s. The wake sample behind the obstacle reached **−0.00475046 m/s** in the axial direction despite the +0.1 m/s inlet, showing a small reverse-flow region. Velocity on all 32 sampled obstacle boundary nodes was zero. Pressure ranged from **−7.23421 to 9.28020 Pa**, with the outlet fixed to 0 Pa. Inlet and outlet fluxes were **0.0600000020** and **0.0600000018 m²/s per metre of depth**, a difference of **2.40 × 10⁻¹⁰ m²/s**.

The measured values are the published baseline; acceptance tolerances are separate:

| Check | Measured baseline | Acceptance tolerance |
|---|---:|---:|
| Inlet velocity error | 0 m/s | ≤ 1 × 10⁻⁶ m/s |
| Outlet pressure error | 0 Pa | ≤ 1 × 10⁻⁶ Pa |
| Obstacle no-slip speed | 0 m/s | ≤ 2 × 10⁻⁵ m/s |
| Near-wake velocity deficit from inlet | 0.10475046 m/s | ≥ 0.025 m/s |
| Pressure range | 16.5144072 Pa | ≥ 0.05 Pa |
| Inlet/outlet flux imbalance | 2.40 × 10⁻¹⁰ m²/s | ≤ 0.001 m²/s |

[Download the runnable case](/examples/tutorials/fluid.zip). It contains the CAD source and sidecars, SVG sketch recipe, generated MDPA inputs, VTK result sequence, and SHA-256 provenance. [Download the SVG sketch recipe separately](/examples/tutorials/fluid/obstacle-channel.svg). The other MDPA-only examples in [Worked Kratos Cases](tutorial-kratos-examples) skip the CAD meshing step.

![CAD geometry with the obstacle hole and named boundary parts](/screenshots/tutorial-fluid-geometry.png)

![Fluid Problemtype setup in KKSS](/screenshots/tutorial-fluid-setup.png)

![Velocity wake behind the obstacle in KKSS](/screenshots/tutorial-fluid-results.png)

![Pressure field around the obstacle in KKSS](/screenshots/tutorial-fluid-pressure.png)
