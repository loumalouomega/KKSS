# Post-Processing (Mesh) Mode

Post-Processing mode embeds the full
[VSCode-MDPA-Preview](https://loumalouomega.github.io/VSCode-MDPA-Preview/)
viewer — KKSS drives the extension's own host code, so behavior matches the
extension exactly. This page summarizes the highlights; see the
[extension documentation](https://loumalouomega.github.io/VSCode-MDPA-Preview/)
for the complete guide.

## What you can do

- **Inspect MDPA models**: a vtk.js 3D view with a navigable
  ModelPart/SubModelPart outline, toggleable layers, node IDs, a background
  grid, an orientation cube, and a clip plane.
- **Visualize results**: nodal/elemental/conditional field data with
  colormaps, isosurfaces, and vector quivers; VTK time-series play back on a
  timeline, and new step files written by a running simulation extend it
  automatically.
- **Check mesh quality**: aspect/edge ratio, min/max angles, and size
  gradation histograms with bad-element highlighting.
- **Modify meshes** with full undo/redo and saveable JSON recipes: merge
  coincident nodes, remove orphans, scale/translate/rotate, delete/rename/
  extract SubModelParts, linear→quadratic conversion, and **MMG remeshing** and
  **level-set splitting** (run in a worker thread, with live progress and
  cancel).
- **Save and export**: overwrite the source (with a one-time warning), Save
  As, or export the whole model — or a single SubModelPart — to MDPA, VTK,
  VTU, VTP, STL, OBJ, or PLY.
- **Screenshots**: save the current view as a PNG.

## Timeline discovery

Opening one file of a Kratos-style series (`<prefix>_<rank>_<step>.vtk`)
discovers its siblings, builds the timeline, and merges rank/subpart files
into the outline. The directory is watched, so a still-running simulation
keeps extending the timeline as new steps land on disk.
