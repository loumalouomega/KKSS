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

After the solve completes, click **Open results**. In the VTK tab, click **Field** and select `VELOCITY` to see the wake; select `PRESSURE` to inspect pressure around the obstacle. Navigate to the last saved frame. The timeline labels filename **steps**, not seconds; the archive has 51 steps for a configured end time of 5 s (see below).

## Plot pressure evolution and the wake

1. Extract [fluid.zip](/examples/tutorials/fluid.zip), open `vtk_output/FluidModelPart_0_1.vtk`, and click **Plots → Load recipe**. Select `plots/pressure-history.json`. Keep the complete directory so relative paths resolve.
2. The chart overlays upstream **node 21**, at approximately **(0.44, 0.30, 0) m**, and downstream **node 5**, at **(0.56, 0.30, 0) m**. These IDs belong to the published VTK mesh. For a regenerated mesh use Inspect and choose new points, not matching IDs.
3. Each curve has **51 disk samples**. Upstream pressure starts at **2697.7852 Pa**, then **−1258.8506 Pa**, before approaching **9.2801962 Pa**; downstream ends at **−4.189086 Pa**. Zoom into later steps to inspect settling, retaining early overshoot in the full CSV. These numerical startup results are not a convergence certificate or validated transient benchmark. At **Re = 20**, this case does not demonstrate periodic vortex shedding.
4. The recipe supplies Pa from the SI setup and reconstructs time as `STEP × 0.1 s`, giving **0.1…5.1 s**. The configured end time is **5 s**, but the archive includes step 51. No sample is silently removed and no initial frame invented. Adaptive runs need actual timestamps. `plots/verification.json` records the mapping and hashes.
5. Open `FluidModelPart_0_51.vtk`, explicitly scrub to the last frame, and load `plots/wake-profile.json`. It samples `VELOCITY X` at **80 positions** from **(0.565, 0.30, 0)** to **(0.85, 0.30, 0) m**. The final interpolated minimum is approximately **−0.00469437 m/s**, different from the node-only minimum below. **Follow timeline** updates the fixed spatial line as the owning preview steps; **Fix frame** retains it for comparison.
6. Export **CSV + metadata**, **PNG / SVG**, or **Save recipe**. The archive includes CSV and provenance companions; **File → Scientific Plot Builder…** can load the same recipes.

![Pressure histories with the mesh in the real KKSS app](/screenshots/tutorial-fluid-pressure-history.png)

![Axial wake profile alongside its owning result](/screenshots/tutorial-fluid-wake-profile.png)

**Boundary loads:** these VTK files contain volume cells and nodal fields, not the MDPA's named boundary Conditions. Do not request an `Obstacle` pressure force from them or interpret an unweighted nodal mean as boundary pressure. Results that genuinely retain Conditions and coverage support boundary means and pressure forces/moments with explicit normal/offset/thickness conventions. See [scientific plots](scientific-plots#regions-and-boundary-quantities).

## Verified result

The baseline run used Python 3.12.14, Kratos 10.4.3, two OpenMP threads, 945 nodes, 1766 elements and 51 result frames with a configured end time of 5 s. The wake sample behind the obstacle reached **−0.00475046 m/s** in the axial direction despite the +0.1 m/s inlet, showing a small reverse-flow region. Velocity on all 32 sampled obstacle boundary nodes was zero. Pressure ranged from **−7.23421 to 9.28020 Pa**, with the outlet fixed to 0 Pa. Inlet and outlet fluxes were **0.0600000020** and **0.0600000018 m²/s per metre of depth**, a difference of **2.40 × 10⁻¹⁰ m²/s**.

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
