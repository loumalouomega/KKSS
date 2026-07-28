# File Formats

## Which mode opens what

| Extension | Mode | Notes |
| --- | --- | --- |
| `.step` `.stp` `.iges` `.igs` `.brep` | 🔷 Pre-Processing | B-rep, tessellated by OpenCascade |
| `.gltf` `.glb` | 🔷 Pre-Processing | Loaded natively by Three.js |
| `.mdpa` | 🔶 Post-Processing | Kratos model part |
| `.vtk` `.vtu` `.vtp` `.vti` `.vts` `.vtr` `.vtm` | 🔶 Post-Processing | Legacy + XML VTK, multiblock, time-series |
| `.msh` `.inp` `.bdf` `.nas` `.fem` `.unv` `.mesh` `.vol` `.su2` `.xdmf` `.xmf` `.off` `.avs` `.dat` `.tec` `.mphtxt` `.node` `.ele` `.f3grid` `.pf3` `.post` `.dato` `.ugrid` `.mfm` `.wkt` `.xml` `.dex` `.ip` `.mff` `.case` `.geo` `.poly` `.e` `.exo` `.ex2` `.cgns` `.h5m` `.hmf` `.med` | 🔶 Post-Processing | Extended formats read via [meshio++](https://github.com/nschloe/meshio) (Gmsh, Abaqus/ANSYS, Nastran, I-deas UNV, Medit, Netgen, SU2, XDMF, COMSOL, tetgen, EnSight Gold, Triangle, Exodus II, CGNS, MOAB, Salome MED, …). Named groups (Gmsh physical groups, Abaqus `*NSET`/`*ELSET`/`*SURFACE`, Exodus element blocks / node sets / side sets) arrive as SubModelParts. `.e`/`.exo`/`.ex2` (Exodus) carry their time steps **inside one file** and drive the timeline from there — no `<prefix>_<rank>_<step>` sibling naming needed. `.med` is read-only. `.dex`/`.ip`/`.mff` are field-only formats — they carry point fields with no geometry, so reading one yields a point cloud (or an empty mesh); `.case`/`.geo` (EnSight Gold) and `.poly` (Triangle) need their sibling file(s) alongside |
| `.stl` `.obj` `.ply` | Both | Opens in the **currently active** mode |

## Export targets

**Pre-Processing** (depends on the source pipeline):

- B-rep sources → STEP, IGES, BREP, STL, OBJ, PLY, glTF
- Mesh sources → STL, OBJ, PLY, glTF (no mesh→B-rep path exists)
- FE meshing → Kratos MDPA (Elements+Conditions or Geometries), Gmsh `.msh` / `.msh2` / `.geo_unrolled` (+ XAO companion), VTK, UNV, Abaqus `.inp`, Nastran `.bdf`, SU2, and more

When an FE-meshing export produces a file Post-Processing can display (`.mdpa`, `.vtk`, …), the app switches to Post-Processing mode and opens it automatically — a one-way pre → post handoff. Exports the post viewer can't open (`.msh`, `.inp`, …) and shared formats (`.stl`/`.obj`/`.ply`) stay in Pre-Processing.

**Post-Processing**: MDPA, VTK (legacy), VTU, VTP, STL, OBJ, PLY — for the whole model or any single SubModelPart, or just the **boundary skin** of the volume cells (**Advanced ▸ Export skin…**) — plus ~35 extended formats written via [meshio++](https://github.com/nschloe/meshio) (Gmsh `.msh`, Abaqus `.inp`, Nastran `.bdf`/`.nas`/`.fem`, I-deas UNV, Medit `.mesh`, Netgen `.vol`, SU2, XDMF, Triangle `.poly`, Exodus `.e`/`.exo`/`.ex2`, CGNS, MOAB `.h5m`, `.hmf`, and more), including the field-only `.dex`/`.ip`/`.mff` targets (point fields kept, geometry dropped) and the write-only SVG/TikZ figure formats (a 2D/3D-projected drawing of the mesh, not a re-readable mesh). Exodus export is deliberately lossy — element blocks and nodal fields survive, SubModelParts do not, and a time series flattens to one step; export to `.mdpa` or `.vtu` when the grouping matters. Structured VTK types (`.vti`/`.vts`/ `.vtr`), `.vtm`, and `.med` are view-only.
