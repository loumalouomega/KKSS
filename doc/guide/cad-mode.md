# Pre-Processing (CAD) Mode

Pre-Processing mode embeds the full
[CAD-Preview](https://loumalouomega.github.io/CAD-Preview/) viewer. Everything
documented for the extension applies inside KKSS too — this page summarizes
the highlights; see the
[CAD-Preview documentation](https://loumalouomega.github.io/CAD-Preview/) for
the complete feature guide.

## What you can do

- **View** STEP, IGES, and BREP models (tessellated by OpenCascade in a
  background worker) and STL, OBJ, PLY, glTF/GLB meshes (loaded natively by
  Three.js), with orbit/pan/zoom, an orientation cube, wireframe, and a
  component tree.
- **Define parts**: pick volumes, surfaces, lines, or points and group them
  into named parts (Kratos sub-model-parts). Assignments persist to a
  `<model>.parts.json` sidecar — the CAD file is never modified.
- **Edit geometry parametrically**: transforms, booleans, fillets/chamfers,
  feature modeling (extrude/revolve/sweep/loft), primitives, 2D sketches,
  bottom-up wireframe modeling, and named variables with expressions. The
  ordered op-list persists to `<model>.edits.json` and replays on every open.
- **Generate FE meshes with Gmsh** (WASM): size controls, element shape
  (tets/hexes) and order (linear/quadratic), per-part mesh sizes, physical
  groups from your parts, and a live mesh overlay.
- **Export**: STEP/IGES/BREP (via OCCT), STL/OBJ/PLY/glTF (via Three.js), and
  FE meshes to Kratos **MDPA**, Gmsh `.msh`, VTK, UNV, Abaqus, Nastran, SU2,
  and more.

## Sidecar files

Pre-Processing mode never writes your CAD file. State lives beside it:

| File | Contents |
| --- | --- |
| `<model>.parts.json` | Part definitions (entity ids, colors, mesh sizes) |
| `<model>.edits.json` | Replayable edit operations + parametric variables |
| `<model>.mesh.json` | Gmsh meshing options |
| `<model>.geo` | Generated Gmsh script (one-way; regenerated on change) |

**Save** (`Ctrl+S`) flushes all sidecars immediately; otherwise they autosave
half a second after each change.
