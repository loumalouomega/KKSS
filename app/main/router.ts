/**
 * File → mode routing. Extension tables come from the submodules themselves
 * (cad/src/fileRouter.ts routeFile; mesh/src/parser/meshFormats.ts +.mdpa).
 * Overlap (.stl/.obj/.ply are viewable in both modes): the active mode wins.
 */
import * as path from "node:path";
import { routeFile } from "../../cad/src/fileRouter";
import { SUPPORTED_MESH_EXTENSIONS } from "../../mesh/src/parser/meshFormats";
import type { Mode } from "./ipc";

export function modeForFile(fsPath: string, activeMode: Mode): Mode | undefined {
  const ext = path.extname(fsPath).toLowerCase();
  const cadOk = routeFile(fsPath) !== undefined;
  const meshOk = ext === ".mdpa" || SUPPORTED_MESH_EXTENSIONS.includes(ext);
  if (cadOk && meshOk) return activeMode;
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
