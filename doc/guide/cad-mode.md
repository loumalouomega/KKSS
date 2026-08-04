# Pre-Processing (CAD) Mode

Pre-Processing mode embeds the full [CAD-Preview](https://loumalouomega.github.io/CAD-Preview/) viewer. Everything documented for the extension applies inside KKSS too — this page summarizes the highlights; see the [CAD-Preview documentation](https://loumalouomega.github.io/CAD-Preview/) for the complete feature guide.

![CAD mode: bull.stp with the components tree, parts, edits and FE mesh panels](/screenshots/cad-viewer.png)

## What you can do

- **View** STEP, IGES, and BREP models (tessellated by OpenCascade in a background worker) and STL, OBJ, PLY, glTF/GLB meshes (loaded natively by Three.js), with orbit/pan/zoom, an orientation cube, five **display modes** (Shaded, Wireframe, X-Ray, Hidden Lines, Flat), a capped **clipping plane**, an exploded-view slider, background/opacity controls, an orthographic/perspective toggle, and a searchable component tree with per-part isolate/hide. A STEP or IGES file's declared length unit is detected and preselected.
- **Import mesh-only formats**: VTK/VTU, MED, CGNS, Exodus, XDMF and Kratos MDPA open as a boundary surface through meshio++, with named regions turned into Parts and any scalar point/cell field usable to **colour the model**. Geometry only — for fields, blocks and SubModelParts, open the file in Post-Processing instead (which is where a double-click lands it).
- **Define parts**: pick volumes, surfaces, lines, or points and group them into named parts (Kratos sub-model-parts). Assignments persist to a `<model>.parts.json` sidecar — the CAD file is never modified. After a topology-changing edit, part assignments are geometrically **rebound** to the renumbered entities instead of being silently lost.
- **Edit geometry parametrically**: transforms, booleans, fillets/chamfers, feature modeling (extrude/revolve/sweep/loft), primitives, 2D sketches, bottom-up wireframe modeling, and named variables with expressions. The ordered op-list persists to `<model>.edits.json` and replays on every open.
- **Measure and inspect**: distance, edge length, angle and radius as a live overlay, each with an **⟟ Exact** button that recomputes against the true OCCT geometry instead of the triangulation; a measurement can be **pinned** to the model so it persists across sessions. Plus a **Mass Properties** panel (volume, surface area, centre of mass, moments of inertia) for the whole model or one entity.
- **Keep your place**: the camera, display mode, projection and clip plane are saved per document, and the components tree reads a STEP file's real XCAF assembly structure. Edits replay from a cached parse, so an interactive change re-tessellates in a fraction of the original load time. Sidecars and the source are watched, so an external change reloads in place.
- **Annotate**: freehand, line, arrow, rectangle and circle markup drawn over the 3D view, with undo/redo and an eraser, baked into screenshots.
- **Generate FE meshes with Gmsh** (WASM): size controls, element shape (tets/hexes/hex-dominant) and order (linear/quadratic), per-part mesh sizes, physical groups from your parts, a live mesh overlay, and a **quality summary** with the worst elements highlighted through the model.
- **Export**: STEP/IGES/BREP (via OCCT), STL/OBJ/PLY/glTF (via Three.js), and FE meshes to Kratos **MDPA**, Gmsh `.msh`, VTK, UNV, Abaqus, Nastran, SU2, MED, CGNS, XDMF, and more — each optionally **unit-converted** (mm/cm/m/in/ft) on the way out. **File ▸ Screenshot…** (`Ctrl+Alt+P`) saves the current view as a PNG.

| Components tree | File menu | FE Mesh panel |
| --- | --- | --- |
| ![Components tree](/screenshots/cad-components-tree.png) | ![File menu](/screenshots/cad-file-menu.png) | ![FE Mesh panel](/screenshots/cad-fe-mesh-panel.png) |

The toolbar is **Fit · Tree · FE Mesh** plus four dropdowns — **View ▾** (Grid, Edges, Screenshot), **Select ▾** (selection mode + Point/Vol/Surf/Line), **Measure ▾** and **Markup ▾** — with the display modes, clip, appearance and unit controls in the view-controls panel.

## Viewer defaults

**Settings ▸ CAD Viewer Defaults** seeds a newly opened document: **Up Axis** (Y or Z), **Default Mesh Size** (Coarse/Medium/Fine), **Tessellation Quality** (Draft/Standard/Fine — how finely a B-rep is triangulated, traded against load time) and **Show Grid & Axes on Open**. They are only the starting point — a per-document `<model>.mesh.json` or `<model>.view.json` value, or a runtime toggle in the view controls, always wins once set. Tessellation quality is re-read on every B-rep load, so a change applies at the next edit or reopen.

| Edits panel | Parts panel | View controls |
| --- | --- | --- |
| ![Edits panel](/screenshots/cad-edits-panel.png) | ![Parts panel](/screenshots/cad-parts-panel.png) | ![View controls](/screenshots/cad-view-controls.png) |

## Sidecar files

Pre-Processing mode never writes your CAD file. State lives beside it:

| File | Contents |
| --- | --- |
| `<model>.parts.json` | Part definitions (entity ids, colors, mesh sizes) |
| `<model>.edits.json` | Replayable edit operations + parametric variables |
| `<model>.annotations.json` | Pinned measurements |
| `<model>.view.json` | Camera, display mode, projection, clip plane |
| `<model>.mesh.json` | Gmsh meshing options |
| `<model>.geo` | Generated Gmsh script (one-way; regenerated on change) |

**Save** (`Ctrl+S`) flushes all sidecars immediately; otherwise they autosave half a second after each change.

**File ▸ Save Preprocess…** bundles the CAD source and whichever sidecars exist into a single `.zip`, and **Load Preprocess…** restores one next to a destination you pick and opens it. The archive carries a manifest with a SHA-256 per entry, so a tampered or truncated file is rejected rather than half-restored; the reader also refuses entries that decompress far beyond their stored size. The `.geo` script is deliberately not packed — it is regenerated from the restored mesh options.
