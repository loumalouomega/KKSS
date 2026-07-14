# File Formats

## Which mode opens what

| Extension | Mode | Notes |
| --- | --- | --- |
| `.step` `.stp` `.iges` `.igs` `.brep` | 🔷 Pre-Processing | B-rep, tessellated by OpenCascade |
| `.gltf` `.glb` | 🔷 Pre-Processing | Loaded natively by Three.js |
| `.mdpa` | 🔶 Post-Processing | Kratos model part |
| `.vtk` `.vtu` `.vtp` `.vti` `.vts` `.vtr` `.vtm` | 🔶 Post-Processing | Legacy + XML VTK, multiblock, time-series |
| `.stl` `.obj` `.ply` | Both | Opens in the **currently active** mode |

## Export targets

**Pre-Processing** (depends on the source pipeline):

- B-rep sources → STEP, IGES, BREP, STL, OBJ, PLY, glTF
- Mesh sources → STL, OBJ, PLY, glTF (no mesh→B-rep path exists)
- FE meshing → Kratos MDPA (Elements+Conditions or Geometries), Gmsh `.msh` / `.msh2` / `.geo_unrolled` (+ XAO companion), VTK, UNV, Abaqus `.inp`, Nastran `.bdf`, SU2, and more

When an FE-meshing export produces a file Post-Processing can display (`.mdpa`, `.vtk`, …), the app switches to Post-Processing mode and opens it automatically — a one-way pre → post handoff. Exports the post viewer can't open (`.msh`, `.inp`, …) and shared formats (`.stl`/`.obj`/`.ply`) stay in Pre-Processing.

**Post-Processing**: MDPA, VTK (legacy), VTU, VTP, STL, OBJ, PLY — for the whole model or any single SubModelPart. Structured VTK types (`.vti`/`.vts`/ `.vtr`) and `.vtm` are view-only.
