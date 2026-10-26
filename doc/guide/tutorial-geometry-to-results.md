# Geometry to results

Eleven tutorials follow one workflow from geometry toward a solver result in KKSS. Each has its own page, a downloadable case and a verification record. All eleven were solved with Kratos 10.4.3 and checked against those tolerances. The dam-break case needs a one-file alias for the stock serial solver wrapper, because that release does not ship the module the wrapper imports; its page says how to create it.
> **In the app:** every case below is built in — use **Help → Examples → (case)** to unpack it into a folder of your choice and open its geometry, no download needed.

## The eleven tutorials

| Result | Physics | Tutorial | Check |
|---|---|---|---|
| ![Displacement of the cantilever on its final frame, viewed from above](/screenshots/tutorial-structural-results.png)<br>*DISPLACEMENT, final frame* | Structural mechanics (static) | [Cantilever](tutorial-structural) | Free-end displacement against beam theory |
| ![CAD geometry of the cantilever with its named Parts](/screenshots/tutorial-eigen-geometry.png)<br>*Cantilever geometry* | Structural mechanics (eigenvalues) | [Cantilever eigenmodes](tutorial-eigen) | Bending frequencies against Euler–Bernoulli theory |
| ![Velocity around the obstacle in the laminar case on the final frame, with its wake](/screenshots/tutorial-fluid-results.png)<br>*VELOCITY, final frame* | Fluid dynamics (laminar) | [Laminar obstacle flow](tutorial-fluid) | No-slip obstacle walls and balanced flux |
| ![Velocity around the obstacle in the turbulent case on the final frame, with its wake](/screenshots/tutorial-rans-results.png)<br>*VELOCITY, final frame* | Fluid dynamics (turbulent, RANS k–ε) | [Turbulent obstacle flow](tutorial-rans) | Wall y⁺ band, turbulence bounds and flux balance |
| ![Temperature of the conduction block, varying linearly from 300 K to 400 K](/screenshots/tutorial-thermal-results.png)<br>*TEMPERATURE, final frame* | Convection–diffusion (stationary conduction) | [Stationary heat conduction](tutorial-thermal) | Linear temperature profile |
| ![Velocity potential over the rectangular domain, varying linearly across it](/screenshots/tutorial-potential-flow-results.png)<br>*VELOCITY_POTENTIAL, final frame* | Potential flow | [Uniform flow](tutorial-potential-flow) | Potential gradient equal to the free-stream velocity |
| ![HEIGHT of the still-water basin on its final frame](/screenshots/tutorial-shallow-water-results.png)<br>*HEIGHT, final frame* | Shallow water | [Still-water basin](tutorial-shallow-water) | Depth, momentum and volume conservation |
| ![Fluid velocity on the final frame of the FSI benchmark](/screenshots/tutorial-fsi-results.png)<br>*Fluid VELOCITY, final frame* | Fluid–structure interaction | [Mok benchmark wall](tutorial-fsi) | Wall-tip motion against the published benchmark |
| ![Fluid velocity on the final frame of the coupled channel-slab case](/screenshots/tutorial-cosim-results.png)<br>*Fluid VELOCITY, final frame* | Partitioned coupling (weak CoSimulation) | [Channel-slab coupling](tutorial-cosimulation) | Interface motion and mass balance |
| ![CAD geometry of the sphere in the virtual wind tunnel](/screenshots/tutorial-wind-tunnel-geometry.png)<br>*The 0.8 m sphere in CAD, the body the tunnel is built around* | External flow around a sphere (RANS, k–ω SST) | [Sphere in a wind tunnel](tutorial-wind-tunnel) | Planned against solved wall y⁺, flux balance |
| ![CAD geometry of the dam-break tank with its named Parts](/screenshots/tutorial-two-fluids-geometry.png)<br>*Tank geometry* | Two-fluid level set (dam break) | [Dam break](tutorial-two-fluids) | Free-surface collapse: the DISTANCE interface, water area and front, outlet pressure |

## Example results

Three fields and a plot from the tutorials, drawn in Post-Processing. The [reading guide](tutorial-reading-results) explains the controls behind them.

![Pressure around the circular obstacle in the turbulent case on the final frame, front view](/screenshots/tutorial-rans-pressure.png)

*PRESSURE on the final frame, colour range −0.61 to 0.82. Red marks high pressure on the upstream face; blue marks low pressure at the sides and in the wake.*

![Pressure around the obstacle in the laminar case on the final frame, front view](/screenshots/tutorial-fluid-pressure.png)

*PRESSURE on the final frame. Red marks the high-pressure zone upstream of the obstacle; blue marks the low-pressure zone beside and behind it.*

![Von Mises stress on the deformed cantilever at a warp scale of 1000 times](/screenshots/tutorial-structural-stress.png)

*VON_MISES_STRESS on the deformed cantilever. The warp scale is 1000×, and it changes only the picture.*

![Plot pane with a flat water-depth history for one node of the still-water basin](/screenshots/tutorial-shallow-water-depth-history.png)

*Depth at one node over the saved steps. The line stays flat, as still water should.*

## Start from CAD mode

Start in Pre-Processing if you need to make the geometry, using the [CAD mode](cad-mode) guide, and mesh and set up the case in Post-Processing, using the [mesh mode](mesh-mode) guide. For a worked case that starts from an MDPA file, with no geometry, see [Worked Kratos Cases](tutorial-kratos-examples). To drive the same steps through the chat assistant, see [AI Simulation Walkthrough](tutorial-ai-simulation). Once a result is open, the [reading guide](tutorial-reading-results) explains the Field panel, the timeline, clipping, plots and convergence records.

## One workflow for every case

1. Create or open the geometry in Pre-Processing, and name the Parts for the bodies and boundaries.
2. Generate a first-order Gmsh mesh and export **MDPA Elements**. Use metres for the planar examples; for the millimetre STEP model, choose the export-unit conversion its tutorial states.
3. Open the MDPA in Post-Processing, choose a built-in Problemtype, assign each condition and material to its named SubModelPart, and select VTK output.
4. Install Kratos Multiphysics 10.4.3, with the applications the case names, in a Python environment, then point **Settings ▸ Kratos ▸ Python Interpreter** at it. The Kratos packages come from that environment, because KKSS does not bundle Kratos. **Check environment** on the Home screen confirms that the required application is available.
5. Click **Generate case files** and check the input it writes (`ProjectParameters.json`, or `ProjectParametersCoSim.json` for the coupled CoSimulation case) and its warnings. Then click **Run case**, which runs `MainKratos.py` in the embedded terminal.
6. Click **Open results**, choose a field in the Field panel, and check its range and time steps. A successful process exit does not establish numerical correctness: each case has its own check on its page, and the [reading guide](tutorial-reading-results) explains the controls.

Download all eleven solver-verified cases from [tutorial-cases.zip](/examples/tutorials/tutorial-cases.zip), or one case from its page. Downloaded cases are starting points, and rerunning one overwrites its generated outputs. These are tutorial checks with documented tolerances, not formal solver certification.
