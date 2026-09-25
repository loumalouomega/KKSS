# Geometry to results

These five tutorials join the CAD and mesh guides into one complete Kratos workflow: make or import geometry, preserve named regions in an MDPA mesh, configure a built-in Problemtype, run a solver and inspect its VTK fields. Each worked case was run with Kratos 10.4.3 and is downloadable with its solver-produced results and provenance.

| Physics | Worked case | Check |
|---|---|---|
| Structural mechanics | [Cantilever](tutorial-structural) | Deformed shape, free-end displacement and von Mises stress |
| Fluid dynamics | [Slip-wall channel](tutorial-fluid) | Uniform velocity and balanced inlet/outlet flux |
| Convection-diffusion | [Stationary heat conduction](tutorial-thermal) | Linear 300–400 K profile |
| Potential flow | [Uniform flow](tutorial-potential-flow) | Potential gradient equals free-stream velocity |
| Shallow water | [Still-water basin](tutorial-shallow-water) | Depth, momentum and volume conservation |

Start from [CAD mode](cad-mode) and [mesh mode](mesh-mode) if you need a tour of either viewer. For a ready-made MDPA-only case that skips geometry, see [Worked Kratos Cases](tutorial-kratos-examples). For a prompted walkthrough using the chat tools, see [Using the AI assistant](tutorial-ai-simulation).

## One workflow for every case

1. Create or open geometry in Pre-Processing; make named Parts for bodies and boundaries.
2. Generate a first-order Gmsh mesh and export **MDPA Elements**. Use metres for the planar examples; for the supplied millimetre STEP model choose the export-unit conversion stated in its tutorial.
3. Open the MDPA in Post-Processing, choose a built-in Problemtype, assign each condition and material to its named SubModelPart, and select VTK output. The transient cases write every step; the stationary cases write their final solution.
4. Set `kratos.pythonPath` to a local Python that imports Kratos and the relevant application, then use the Home screen's **Check environment** action. Set `kratos.extraEnv` to `{"OMP_NUM_THREADS":"2"}` for these short solves. KKSS does not bundle Kratos; if the probe or Run reports a missing module, choose an environment with that Kratos application installed. **Generate case files**, check `ProjectParameters.json`, then **Run case** in the embedded terminal.
5. **Open results**, choose a field from the Field panel, and inspect its range and time steps. A successful process exit alone does not establish numerical correctness; each worked case includes a separate physical check.

For the full input deck, VTK timeline and SHA-256 file manifest, [download all five cases](/examples/tutorials/tutorial-cases.zip) or download one case from its page. They are tutorial checks with documented tolerances, not formal solver certification.
