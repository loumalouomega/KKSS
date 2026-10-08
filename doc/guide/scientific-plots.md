# Scientific plots and FEM analysis

Mesh Preview 5.1 brings a **Plots** workspace into KKSS. Plot point histories, compare quantities, sample spatial profiles and analyze named regions without writing a plotting script. Extraction and numerical analysis run off the main thread; the chart does not sample pixels from the viewport.

## Open a plot

- In Post-Processing, click **Plots**, or **Advanced → Plot builder…**. The pane belongs to that mesh tab. **Dock below / Dock beside**, the keyboard-resizable separator, and **Hide / Plots** adjust the split without discarding curves. Plots and Flowgraph share the auxiliary space.
- Use **Inspect → Plot** beside a field, **Plot over time**, or **Add points from mesh** to overlay histories. Choose quantity and scalar/component/magnitude explicitly.
- **Analyze / plot this SubModelPart** in Layers opens regional controls. Node IDs and element/condition IDs remain separate associations.
- **File → Scientific Plot Builder…** opens a separate workspace, available even without a mesh. Use **Add source → Browse… → Inspect source** for CSV/TSV, or **Load recipe** for a tutorial recipe.

![Standalone scientific plot builder showing two actual CFD pressure histories](/screenshots/scientific-plot-builder.png)

Both workspaces use the same upstream controller. Chart styling does not change source files or dirty mesh geometry.

## Worked examples

Download and **extract the complete case archive** before loading a recipe. Keep `plots/` beside `vtk_output/`: paths are relative to the recipe, not the active mesh. A JSON downloaded alone does not include its result files. Open a VTK result, click **Plots → Load recipe**, and select the JSON; the standalone builder can load it too.

| Case | Recipe inside its archive | What to inspect |
| --- | --- | --- |
| [Cylinder/obstacle flow](tutorial-fluid#plot-pressure-evolution-and-the-wake) | `plots/pressure-history.json`, `plots/wake-profile.json` | Two pressure histories, startup overshoot and a timeline-following wake profile |
| [Structural cantilever](tutorial-structural#plot-displacement-and-reactions) | `plots/displacement-history.json`, `plots/reaction-history.json` | Tip displacement and signed nodal reaction sum over static steps |
| [Stationary conduction](tutorial-thermal#plot-the-temperature-profile) | `plots/temperature-profile.json` | Temperature versus distance, not a fabricated transient |
| [Potential flow](tutorial-potential-flow#plot-potential-versus-distance) | `plots/potential-profile.json` | Potential versus distance and the uniform-flow slope |
| [Still-water basin](tutorial-shallow-water#plot-water-depth-over-time) | `plots/depth-history.json` | A deliberately flat depth history |

Each `plots/` directory includes full-resolution CSV, a `.csv.kratosplot.json` provenance companion and `verification.json` with selected node coordinates, input SHA-256 hashes, unit conventions and time reconstruction. These supplement—not replace—the solver verification. Regenerate with `npm run tutorials:plots` after building; no solver rerun is required.

## Time, units and correspondence

**A filename step is not a timestamp.** Histories show step labels unless the reader supplies time or you enter one **Physical times** value per frame and a **Time unit**. For the fixed-step Kratos tutorials, recipes explicitly reconstruct `start_time + STEP × time_step` from case settings and the Kratos VTK step suffix. These are not recorded solver timestamps. Adaptive-step results require actual saved times.

The cylinder archive has **51 steps** despite a configured end time of **5 s**. Its explicit mapping is **0.1…5.1 s**, with no invented initial frame. This discrepancy is disclosed in exports and the tutorial. A settling chart is not proof of solver convergence.

Legacy VTK outputs here do not record field/coordinate units. Recipes explicitly supply tutorial SI field units using **Convert** transformations; displacement additionally multiplies metres by 1000 for mm. Original export columns retain `unknown` units. Probe distance labels state metres from the case setup, while extraction metadata retains unknown coordinate units. Changing a label alone never converts numbers.

Histories read disk values, not replayed geometry edits. Current mesh/region/probe sources can use the owning preview's edited model. Missing fields, absent entities and uncovered samples remain gaps, not zeros. Topology changes do not establish correspondence between different meshes or runs.

## Regions and boundary quantities

Choose **Target: SubModelPart / whole mesh**, field/association, **Current frame / Over time**, and operation. Current-frame quantities use bars; histories use lines. Simple controls refuse mixed domains rather than silently changing existing curves.

| Operation | Physical meaning |
| --- | --- |
| Minimum / maximum / entity mean | Unique members; mean is **unweighted**, not a volume/area mean |
| Sum / support reactions | Sum supplied force components with their signs; vector components sum before magnitude |
| Boundary mean / scalar integral | Measure-weighted values over **Conditions**, with an explicitly selected Nodal or Conditional scalar field |
| Pressure force / moment | Integrate `−(p − pressureOffset)n`; choose outward/winding normals, offset and, for moments, origin |
| Flow / heat flux | Integrate a supplied vector dotted with the chosen normal; temperature alone does not supply heat flux |

Boundary operations require actual Conditions and field coverage. Node-only parts and volume-only VTK results are insufficient. KKSS does not infer exterior facets or transfer input MDPA regions by matching result IDs. Outward normals need exactly one adjacent element; excluded facets and uncovered measure are disclosed. XY line boundaries give **per-unit-depth** loads unless a positive thickness in coordinate units is supplied. Known kinematic-pressure fields additionally need explicit density for physical pressure loads.

## Spatial profiles that follow the timeline

Use **Inspect → Probe line → Plot builder…**, or load a probe recipe in its owning result tab. Profiles start fixed at a captured frame. **Follow timeline** resamples the same spatial coordinates when you step or play; **Fix frame** retains a comparison curve. This is an Eulerian profile, not a material-point trajectory; it uses source coordinates, not visually warped geometry.

Other curves retain their extraction snapshots. Timeline/rank/resampling changes pause following until explicitly resumed; **Cancel** also pauses it. Saving a live profile embeds the captured table rather than promising a live link after reload.

## Charts and numerical analysis

The visual **Chart type** picker offers twelve families: line, step, area, scatter, bubble, bar, pie, doughnut, histogram, box, heatmap and contour. Compatible changes retain curves and profile bindings. Missing intervals stay broken. Bubble sizes need an explicit column; pie/doughnut require an explicit statistic, nonnegative contributions and a positive total. Shares of overlapping regions are not a physical partition.

**Advanced** exposes mappings, filters, supplied unit conversions, normalization, smoothing, regression, derivatives/integrals, reference alignment and explicit grids. Calculus requires increasing numeric X within covered segments; integration restarts after gaps. Fits/smoothing do not invent uncertainty propagation. Comparison requires compatible units and explicit tolerance; no extrapolation or cross-mesh mapping occurs. Nearest gridding is not finite-element interpolation or guaranteed hole detection. Statistics use every sample even when chart delivery is reduced; diagnostics disclose sampling and coverage.

## Recipes, exports and saved runs

- **Save / Load recipe** uses version-1 JSON. Disk paths are relative; captured live snapshots become inline tables.
- **CSV + metadata** exports every derived and original selected sample, including units, association/ID, frame/time and provenance—not just displayed samples.
- **PNG / SVG** exports the current chart view, including visibility/zoom, plus provenance. Sources and bound run artifacts cannot be overwritten.
- **Saved run…** discovers tracked receipts or an explicitly selected directory. Only recorded terminal isolated runs with unchanged inputs, outputs and companions can be bound. Legacy/shared-output or uncertain ownership remains unresolved; a label is not ownership.
- **Open owning result**, sample navigation and time cursors verify the exact source/rank/frame. Another result opens in a separate tab; an existing owning tab is revealed without replacing it. Edited/resampled/busy previews can refuse navigation. Time matching never picks an equal-distance tie or converts units silently.

Tutorial archives are unbound disk sources; no isolated-run receipt is fabricated. **Show in mesh** requires the owning source; standalone unbound charts have no active-preview fallback.

## Assistant and limits

The assistant has `mesh__plot_table_read`, `mesh__plot_dataset`, `mesh__plot_runs`, `mesh__plot_run_bind`, `mesh__plot_time_cursor` and `mesh__plot_run_target`. UI and MCP share numerical recipes. Dataset calls require normal write approval because they can export CSV/provenance; the other five are read-only. MCP target resolution does not manipulate a preview.

Collection runs in a cancellable worker; partial results are labelled. Refresh explicitly rereads files; plots are not file watchers. Limits include 1,000,000 table rows, 256 columns, 128 MiB per table/source, 5,000 history frames and bounded nearest grids. Persistent companion-aware caches, automatic remeshing correspondence, broader exterior-boundary integration and additional FEM presets remain upstream work, not features claimed here.
