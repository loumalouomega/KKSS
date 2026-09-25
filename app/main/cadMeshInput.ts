import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileRoute } from "../../cad/src/fileRouter";
import type { EditOp } from "../../cad/src/editOps";
import type { DisplayUnit } from "../../cad/src/lengthUnits";
import { unitScaleFactor } from "../../cad/src/lengthUnits";
import { scaleStlBytes } from "../../cad/src/stlParser";
import { resolveExternalBuffers } from "../../cad/src/gltfParser";
import { meshioCompanionCandidates } from "../../cad/src/meshioCompanions";
import { isMeshSourceRoute, resolveMeshSourceInput } from "../../cad/src/meshSourceInput";
import type { cadCompute } from "./cadComputeClient";

type Compute = Pick<typeof cadCompute, "bakeMeshEdits" | "convertToStlBoundary" | "convertFoamCaseToStlBoundary">;

/** Viewer STL already contains edits. Only source-file input needs replay. */
export async function resolveCadMeshInput(
  modelPath: string,
  route: FileRoute,
  ops: EditOp[],
  stl: string | undefined,
  unit: DisplayUnit,
  compute: Compute,
  warnings: string[],
) {
  if (stl) {
    const bytes = Buffer.from(stl, "base64");
    const factor = unitScaleFactor(unit);
    return { kind: "stl" as const, stlBytes: factor === 1 ? bytes : scaleStlBytes(bytes, factor) };
  }
  if (!isMeshSourceRoute(route)) return undefined;
  const directory = path.dirname(modelPath);
  const readSibling = async (name: string) => {
    try { return new Uint8Array(await fs.readFile(path.resolve(directory, name))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  return resolveMeshSourceInput(route, modelPath, ops, {
    readBytes: () => fs.readFile(modelPath),
    resolveGltfBuffers: (bytes) => resolveExternalBuffers(bytes, readSibling),
    resolveMeshioCompanions: async (bytes) => {
      const names = meshioCompanionCandidates(
        path.basename(modelPath),
        route.format,
        route.format === "xdmf" ? Buffer.from(bytes).toString("utf8") : undefined,
      );
      const companions = await Promise.all(
        names.map(async (name) => {
          const data = await readSibling(name);
          return data ? { name, bytes: data } : undefined;
        }),
      );
      return companions.filter((value): value is NonNullable<typeof value> => value !== undefined);
    },
    convertToStlBoundary: (...args) => compute.convertToStlBoundary(...args),
    convertFoamCaseToStlBoundary: (...args) => compute.convertFoamCaseToStlBoundary(...args),
    bakeEdits: (bytes, format, tail, external) =>
      compute.bakeMeshEdits(bytes, format, tail, "stl", external),
  }, warnings, unit);
}
