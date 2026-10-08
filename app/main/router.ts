/**
 * File → mode routing. Extension tables come from the submodules themselves
 * (cad/src/fileRouter.ts routeFile; mesh/src/parser/meshFormats.ts +.mdpa).
 * Overlap (.stl/.obj/.ply are viewable in both modes): the active mode wins.
 */
import { ROUTED_EXTENSIONS, routeFile } from "../../cad/src/fileRouter";
import { SUPPORTED_MESH_EXTENSIONS, meshExtname } from "../../mesh/src/parser/meshFormats";
import type { Mode } from "./ipc";

export function modeForFile(fsPath: string, activeMode: Mode): Mode | undefined {
  // NOT path.extname: both submodules moved to longest-suffix matching for
  // compound extensions (mesh 3.6.0, cad 1.5.1), and `case.post.msh` is GiD
  // postprocess while `case.msh` is Gmsh — three different formats sharing a
  // last dot. meshExtname is mesh's own single authority for the question.
  const ext = meshExtname(fsPath).toLowerCase();
  const route = routeFile(fsPath);
  const cadOk = route !== undefined;
  // MFEM rank pieces use names like `rank.mesh.000003`. They are a supported
  // multi-file reader but intentionally excluded from the submodule's ordinary
  // extension list (its file dialog registers `*.mesh.??????` separately).
  const meshOk = ext === ".mdpa" || ext === ".mfem-rank" || SUPPORTED_MESH_EXTENSIONS.includes(ext);
  if (cadOk && meshOk) {
    // CAD-Preview also imports the mesh formats through meshio++, as a
    // geometry-only boundary surface — since 1.5.1 that includes .msh/.inp/
    // .unv/.su2/.mesh/.foam/.post.msh alongside the original .mdpa/.vtk/.vtu/
    // .med/.cgns/.exo/.xdmf. Those are post-processing formats here — and
    // .mdpa is KKSS's flagship one — so they keep opening in mesh mode, which
    // reads them natively (fields, blocks, SubModelParts). CAD mode's importer
    // stays reachable from its own Open dialog. Only the genuinely shared
    // surface formats (.stl/.obj/.ply) let the active mode win. New CAE result
    // and solver formats (Code_Aster, FEBio, Elmer, Femap, libMesh, Patran,
    // Radioss, Z88, MFEM, …) arrive through the same mesh registry below.
    return route.strategy === "meshio" ? "mesh" : activeMode;
  }
  if (cadOk) return "cad";
  if (meshOk) return "mesh";
  return undefined;
}

/** Mode implied by a VS Code viewType (the shim's "vscode.openWith" hook). */
export function modeForViewType(viewType: string): Mode | undefined {
  if (viewType.startsWith("kratos.")) return "mesh";
  if (viewType.startsWith("cad-preview.")) return "cad";
  return undefined;
}

/** Single source for native associations and external launch validation. */
export const SUPPORTED_FILE_EXTENSIONS: readonly string[] = [...new Set([
  ...ROUTED_EXTENSIONS.map(ext => ext.replace(/^\./, "")),
  ...SUPPORTED_MESH_EXTENSIONS.map(ext => ext.replace(/^\./, "")),
  "mfem-rank",
  "mdpa",
])].sort();

export const FILE_ASSOCIATIONS = SUPPORTED_FILE_EXTENSIONS.map(ext => ({
  ext,
  name: `KKSS ${ext.toUpperCase()} document`,
  description: `KKSS ${ext.toUpperCase()} document`,
  mimeType: `application/x-kkss-${ext.replace(/\./g, "-")}`,
  role: "Editor" as const,
}));
