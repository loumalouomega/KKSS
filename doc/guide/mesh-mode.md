# Post-Processing (Mesh) Mode

Post-Processing mode embeds the full [VSCode-MDPA-Preview](https://loumalouomega.github.io/VSCode-MDPA-Preview/) viewer — KKSS drives the extension's own host code, so behavior matches the extension exactly. This page summarizes the highlights; see the [extension documentation](https://loumalouomega.github.io/VSCode-MDPA-Preview/) for the complete guide.

![Mesh mode: an MDPA model with the outline, edit history and mesh-modification sidebar](/screenshots/mesh-viewer.png)

## What you can do

- **Inspect MDPA models**: a vtk.js 3D view with a navigable ModelPart/SubModelPart outline, toggleable layers, node IDs, a background grid, an orientation cube, and a clip plane.
- **Visualize results**: nodal/elemental/conditional field data with colormaps. The Field panel offers **combinable display modes** — solid contour, isosurfaces, vector quivers, and a **deformed-shape** warp driven by a displacement field — that can be layered together; VTK time-series play back on a timeline, and new step files written by a running simulation extend it automatically.
- **Check mesh quality**: aspect/edge ratio, min/max angles, and size gradation histograms with bad-element highlighting.
- **Analyze mesh size**: the **Mesh Size** panel reports nodal size (Kratos `NODAL_H` — min distance to a node sharing an element) and element size (mean edge length) as box-whisker statistics, and highlights the IQR-outlier small/large elements.
- **Modify meshes** with full undo/redo and saveable JSON recipes: merge coincident nodes, remove orphans, scale/translate/rotate, delete/rename/ extract SubModelParts, linear→quadratic conversion, and **MMG remeshing** and **level-set splitting** (run in a worker thread, with live progress and cancel).
- **Save and export**: overwrite the source (with a one-time warning), Save As, or export the whole model — or a single SubModelPart — to MDPA, VTK, VTU, VTP, STL, OBJ, or PLY, plus ~29 extended formats via meshio++ (Gmsh `.msh`, Abaqus `.inp`, Nastran, UNV, Medit, Netgen, SU2, XDMF, Triangle `.poly`, and more, including the field-only `.dex`/`.ip`/`.mff` targets and the write-only SVG/TikZ figure formats, grouped in the Export menu under Solvers, Fields, and Figures).
- **Screenshots**: save the current view as a PNG.

| Outline & edit sidebar | File menu |
| --- | --- |
| ![Sidebar](/screenshots/mesh-outline.png) | ![File menu](/screenshots/mesh-file-menu.png) |

## Problemtypes: Kratos case setup

The Problemtype sidebar section turns the loaded MDPA model into a runnable Kratos case: pick a built-in (Structural, Fluid, Convection-Diffusion, Potential Flow, Shallow Water) or a workspace `.js`/`.py` problemtype, assign conditions and materials to SubModelParts, then **Generate** writes ProjectParameters.json, the materials file(s), and MainKratos.py next to the mesh; **Run** launches `python MainKratos.py` in the embedded terminal; **Open results** opens the first `vtk_output/` file back in the viewer. Kratos itself isn't bundled — point Settings at a local install or rely on a pip-installed `KratosMultiphysics` on PATH.

**Flowgraph** is a built-in that replaces the sidebar forms with an embedded node-editor: selecting it splits the viewport (toggle the split direction, or hide/restore the pane) to show the [`@kratos-flowgraph/flowgraph`](https://www.npmjs.com/package/@kratos-flowgraph/flowgraph) graph editor, seeded from the current case's ProjectParameters.json; its own Generate button writes the graph back the same way as the standard flow. It's UI-only — there's no headless/MCP equivalent — and it's why KKSS is licensed [**AGPL-3.0**](https://github.com/loumalouomega/KKSS/blob/master/LICENSE): Flowgraph itself is AGPL-3.0, and the mesh engine bundling it moved to AGPL-3.0-or-later.

## Timeline discovery

Opening one file of a Kratos-style series (`<prefix>_<rank>_<step>.vtk`) discovers its siblings, builds the timeline, and merges rank/subpart files into the outline. The directory is watched, so a still-running simulation keeps extending the timeline as new steps land on disk.

![A VTK time series with the playback timeline](/screenshots/mesh-vtk-timeline.png)
