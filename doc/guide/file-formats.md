# File Formats

## Which mode opens what

| Extension | Mode | Notes |
| --- | --- | --- |
| `.step` `.stp` `.iges` `.igs` `.brep` | 🔷 Pre-Processing | B-rep, tessellated by OpenCascade |
| `.gltf` `.glb` | 🔷 Pre-Processing | Loaded natively by Three.js |
| `.mdpa` | 🔶 Post-Processing | Kratos model part |
| `.vtk` `.vtu` `.vtp` `.vti` `.vts` `.vtr` `.vtm` | 🔶 Post-Processing | Legacy + XML VTK, multiblock, time-series |
| `.msh` `.inp` `.bdf` `.nas` `.fem` `.unv` `.mesh` `.vol` `.su2` `.xdmf` `.xmf` `.off` `.avs` `.dat` `.tec` `.mphtxt` `.node` `.ele` `.f3grid` `.pf3` `.post` `.dato` `.ugrid` `.mfm` `.wkt` `.xml` `.dex` `.ip` `.mff` `.case` `.geo` `.poly` `.e` `.exo` `.ex2` `.cgns` `.h5m` `.hmf` `.med` | 🔶 Post-Processing | Extended formats read via [meshio++](https://github.com/nschloe/meshio) (Gmsh, Abaqus/ANSYS, Nastran, I-deas UNV, Medit, Netgen, SU2, XDMF, COMSOL, tetgen, EnSight Gold, Triangle, Exodus II, CGNS, MOAB, Salome MED, …). Named groups (Gmsh physical groups, Abaqus `*NSET`/`*ELSET`/`*SURFACE`, Exodus element blocks / node sets / side sets) arrive as SubModelParts. `.e`/`.exo`/`.ex2` (Exodus) carry their time steps **inside one file** and drive the timeline from there — no `<prefix>_<rank>_<step>` sibling naming needed; Salome `.med` also accepts a time step, but reports no step count up front, so its timeline isn't discoverable before a read. `.dex`/`.ip`/`.mff` are field-only formats — they carry point fields with no geometry, so reading one yields a point cloud (or an empty mesh); `.case`/`.geo` (EnSight Gold) and `.poly` (Triangle) need their sibling file(s) alongside |
| `.stl` `.obj` `.ply` | Both | Opens in the **currently active** mode |

Pre-Processing can *also* read `.vtk` `.vtu` `.med` `.cgns` `.exo` `.e` `.xdmf` `.mdpa` through meshio++, as a **geometry-only boundary surface** (named regions become Parts; fields are not converted, though a scalar point/cell field can be used to colour the model). Those are post-processing formats here and mesh mode reads them natively — fields, blocks and SubModelParts — so opening one always lands in Post-Processing regardless of the active mode. Reach the CAD-side importer from Pre-Processing's own **Open…** dialog (or drag the file onto the CAD view) when you specifically want to mesh or edit that geometry.

## Export targets

**Pre-Processing** (depends on the source pipeline):

- B-rep sources → STEP, IGES, BREP, STL, OBJ, PLY, glTF
- Mesh sources → STL, OBJ, PLY, glTF (no mesh→B-rep path exists)
- FE meshing → Kratos MDPA (Elements+Conditions or Geometries), Gmsh `.msh` / `.msh2` / `.geo_unrolled` (+ XAO companion), VTK, UNV, Abaqus `.inp`, Nastran `.bdf`, SU2, and more — plus MED, CGNS and XDMF (+ its `.h5` companion) written through meshio++, which Gmsh's own writers can't produce
- Screenshot → PNG (**File ▸ Screenshot…**, `Ctrl+Alt+P`)

Every export target can optionally be **unit-converted** (mm/cm/m/in/ft) on the way out: a second quick-pick after the format, defaulting to native mm. This is a real geometric scale on the exported file — STEP and IGES also get their declared header unit written to match — not the display-unit selector in the view controls, which only changes how measurements read. A CGNS export of a pure surface mesh is a known gap: it writes, but meshio++'s own reader can't read it back (volume meshes are fine).

When an FE-meshing export produces a file Post-Processing can display (`.mdpa`, `.vtk`, …), the app switches to Post-Processing mode and opens it automatically — a one-way pre → post handoff. Exports the post viewer can't open (`.msh`, `.inp`, …) and shared formats (`.stl`/`.obj`/`.ply`) stay in Pre-Processing.

**Post-Processing**: MDPA, VTK (legacy), VTU, VTP, STL, OBJ, PLY — for the whole model or any single SubModelPart, or just the **boundary skin** of the volume cells (**Advanced ▸ Export skin…**) — plus ~36 extended formats written via [meshio++](https://github.com/nschloe/meshio) (Gmsh `.msh`, Abaqus `.inp`, Nastran `.bdf`/`.nas`/`.fem`, I-deas UNV, Medit `.mesh`, Netgen `.vol`, SU2, XDMF, Triangle `.poly`, Exodus `.e`/`.exo`/`.ex2`, CGNS, MOAB `.h5m`, `.hmf`, Salome `.med`, and more), including the field-only `.dex`/`.ip`/`.mff` targets (point fields kept, geometry dropped) and the write-only SVG/TikZ figure formats (a 2D/3D-projected drawing of the mesh, not a re-readable mesh). SubModelParts now survive an export to `.med` (as MED families) and `.inp` (as real `*NSET`/`*ELSET` sets), and every mesh block keeps its name in `.exo`; a `.msh` export still carries no groups (meshio++ writes no `$PhysicalNames` for a mesh that didn't come from Gmsh). Exodus export remains lossy — element blocks and fields survive, genuine SubModelParts do not, and a time series flattens to one step; export to `.mdpa`, `.vtu` or `.med` when the grouping matters. Structured VTK types (`.vti`/`.vts`/`.vtr`) and `.vtm` are view-only.
