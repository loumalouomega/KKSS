# Reading a Kratos result in KKSS

The tutorial pages link here instead of repeating these notes. Control names are the ones Post-Processing shows.

## Open results {#open-results}

In the Problemtype sidebar, **Open results** opens the case's latest VTK output in a new Post-Processing tab. It reads the `vtk_output` folder beside the generated case and reports *No results in vtk_output/ yet* until the solver has written a step. A finished run opens its newest step; a run that did not finish cleanly opens its last complete step, because its final file may be truncated. If a tab already shows that series, the button moves that tab to the newest step.

A coupled case opens one participant's series. For the other, choose **File ▸ New Mesh Tab**, then **File ▸ Open…** (Ctrl+O), because Open alone replaces the focused tab's document.

## The Field panel {#field-panel}

Click **Field** in the viewer toolbar. The panel holds, from top to bottom:

- **Variable**: the field to draw.
- **Modes**: **Contour** (a colour map on the mesh), **Quiver** (arrows for a vector field), **Isosurface** (a scalar field), **Deformed** (warps the mesh by a vector field) and **Threshold** (shows only cells in a value window). Modes combine.
- **Component** (contour, isosurface and threshold) and **Unit**, which changes the display only.
- **Colormap** and **Range**. Typing a minimum and maximum fixes the colour scale; **⟲** (*Reset to data range*) restores the data's range.
- **Log scale**, **Bands** (*Continuous*, or discrete bands) and **Show scalar bar in scene**, which keeps the legend in a screenshot.

## The timeline {#timeline}

A time series shows **Previous frame**, **Play / Pause**, **Next frame** and a scrubber. Each saved output frame is one step. The label reads `Step 6 (3/12)`, the step number from the file name and the frame's position; the status bar shows `frame 3 / 12 · step 6`. Opening one file of a Kratos series (`<prefix>_<rank>_<step>.vtk`) builds the timeline from its siblings, and a folder still being written keeps extending it. **Resample** reads the series at chosen times and can export them without changing the source.

## Clipping {#clipping}

The **CLIP** controls in the bottom dock switch the clip plane on and off, choose **X**, **Y**, **Z** or **Free** (which shows raw normal inputs), and set its position. The position is a fraction from 0 to 1 of the model's extent along the axis; the slider's 0 to 100 is the same fraction in percent. The cut face is filled at the plane. It takes the active field's colours only while **Contour** is on, and is neutral grey otherwise.

## Deformed shape {#deformed-shape}

**Deformed** is a display warp. Choose the vector field in **Deform by** (for a structural result, `DISPLACEMENT`), then raise **Warp scale**, which multiplies it for display up to 1000×. Solver displacements are often far smaller than the model, so the scale makes them visible. Field values and the saved file do not change.

## Quiver and streamlines {#quiver-and-streamlines}

**Quiver** draws arrows for a vector field, coloured by magnitude. **Advanced ▸ Streamlines…** traces steady streamlines of a nodal vector field from seed points, a line, a plane (filled with **Use clip plane**) or a SubModelPart. The trace runs in a worker with per-seed progress, and **Cancel** keeps the partial trace. The streamlines follow the current frame; they are not pathlines through time.

## Inspect and probes {#inspect-and-probes}

**Inspect** turns clicks into probes: click a node, element or condition to read its id, block, SubModelPart membership and every field value. **Measure** reports the distance between two picks and its Δx, Δy and Δz. **Inspect ▸ Probe line** plots a nodal field against distance between two node picks and can export CSV. **Inspect ▸ Plot over time** samples the picked entity's field across every step.

## Plots {#plots}

**Plots** opens the plot pane for that mesh tab. It docks below or beside the mesh, and hiding it keeps its curves. Add histories with **Inspect ▸ Plot over time**, **Add points from mesh** or a probe line. A filename step is not a timestamp, so enter **Physical times** and a **Time unit** to plot in time. Missing values appear as gaps, not zeros. In the plot workspace (**File ▸ Scientific Plot Builder…**), **Save recipe** and **Load recipe** store a plot as version 1 JSON, with paths relative to the recipe file.

## Derived fields and layers {#derived-fields-and-layers}

The **Variables** section turns a formula over coordinates and fields, a distance, or a global reduction such as max or mean into a new field. It appears in the Field panel and can be used by name in other formulas. **View Layers** holds named, view-only groups of blocks, SubModelParts or picks. Hiding a layer never edits the mesh, and promoting one creates a real SubModelPart.

## Monitors, convergence and batches {#monitors-convergence-and-batches}

- **Run status**: the Problemtype status line reads *Starting…*, *Running — step N…*, then *Finished.* or a stop or failure message. While the solver runs, **Run case** reads **Stop run**, and **File ▸ Stop Kratos Run** stops it.
- **Convergence**: **Review run** on the Home screen reads the run's convergence record (`kkss-convergence-v2.jsonl`), draws its plots and reports solve-step outcomes; **Export review** writes the report as offline JSON or HTML. Without a versioned record, convergence is unavailable, and process completion never establishes it. The `mesh__case_convergence` tool reads the same record.
- **Monitors**: for a field of a time series, **Inspect** offers **Monitor**, which saves it as a named monitor of the case; the result must belong to a generated or run case. `mesh__case_monitors` lists, sets, removes and evaluates monitors.
- **Batches**: in the **Edit** section, tick **Queue operations for one apply**, then **Apply queued steps** runs the queue in order, each step undoable. **Save queue…** stores the queue as a JSON recipe, and **Load into queue…** appends a recipe to it. **Save operations…** stores applied operations as a JSON recipe, and **Load operations…** loads and replays one. The `mesh__mesh_batch_transform` tool applies a named preset from `.kratos/recipes` (`recipePreset`); `dryRun` plans without writing.
