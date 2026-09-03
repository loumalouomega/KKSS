/**
 * RPC client for cadCompute.worker.ts. One persistent worker hosts the OCCT +
 * Gmsh WASM singletons (mirroring the lazy-init discipline of the extension
 * host); calls are serialized by id. All args/results are structured-clone
 * friendly (bytes, typed arrays, plain objects).
 *
 * The `import type` below is erased at build time — occtService/gmshService
 * are bundled ONLY into the worker, never into main.
 */
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type * as occt from "../../cad/src/occtService";
import type * as gmsh from "../../cad/src/gmshService";
import type * as massProps from "../../cad/src/massProperties";
import type * as entityFacts from "../../cad/src/entityFacts";
import type * as meshio from "../../cad/src/meshioService";
import type * as meshioParts from "../../cad/src/meshioRegionParts";
import type * as hitTestService from "../../cad/src/hitTestService";
import type * as meshHeal from "../../cad/src/meshHeal";
import type * as primitiveReport from "../../cad/src/primitiveReport";
import type * as meshRegionFit from "../../cad/src/meshRegionFit";
import type * as primitiveWrite from "../../cad/src/primitiveWrite";
import type * as svgSilhouetteHost from "../../cad/src/svgSilhouetteHost";
import type * as modelDiffHost from "../../cad/src/modelDiffHost";
import type * as stepPartsService from "../../cad/src/stepPartsService";
import type * as brepCache from "./cadBRepCache";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, PendingCall>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, "cadCompute.worker.js"));
  worker.on("message", (res: { id: number; ok: boolean; value?: unknown; error?: string }) => {
    const call = pending.get(res.id);
    if (!call) return;
    pending.delete(res.id);
    if (res.ok) call.resolve(res.value);
    else call.reject(new Error(res.error ?? "cadCompute worker error"));
  });
  worker.on("error", (err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    worker = undefined;
  });
  worker.on("exit", () => {
    for (const call of pending.values()) call.reject(new Error("cadCompute worker exited"));
    pending.clear();
    worker = undefined;
  });
  return worker;
}

function call<T>(method: string, args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    ensureWorker().postMessage({ id, method, args });
  });
}

/**
 * One RPC binding. The type parameter is the submodule function itself, so a
 * changed signature upstream is a typecheck error here rather than a runtime
 * surprise — the property this whole layer exists to keep.
 */
function rpc<F extends (...args: never[]) => unknown>(method: string) {
  return (...args: Parameters<F>) => call<Awaited<ReturnType<F>>>(method, args as unknown[]);
}

/**
 * Mirrors cad 1.3.0+'s `DocumentPipeline` (cad/src/kernelClient.ts). cad runs
 * it over a forked child process; KKSS runs the same handler set in a worker
 * thread (cadCompute.worker.ts), which is why the method names match exactly.
 */
export const cadCompute = {
  // ---- OCCT ------------------------------------------------------------
  loadBRep: rpc<typeof occt.loadBRep>("loadBRep"),
  exportBRep: rpc<typeof occt.exportBRep>("exportBRep"),
  // cad 1.2.6's cached parse+replay. The cache entry itself never crosses the
  // RPC — see app/main/cadBRepCache.ts.
  loadBRepCachedInWorker: rpc<typeof brepCache.loadBRepCachedInWorker>("loadBRepCachedInWorker"),
  releaseBRepCache: rpc<typeof brepCache.releaseBRepCache>("releaseBRepCache"),

  // ---- Gmsh ------------------------------------------------------------
  generateMesh: rpc<typeof gmsh.generateMesh>("generateMesh"),
  exportGeoUnrolled: rpc<typeof gmsh.exportGeoUnrolled>("exportGeoUnrolled"),
  exportMeshFormat: rpc<typeof gmsh.exportMeshFormat>("exportMeshFormat"),
  exportMdpa: rpc<typeof gmsh.exportMdpa>("exportMdpa"),
  // cad 1.5.0: fTetWild-backed watertight repair.
  repairMesh: rpc<typeof gmsh.repairMesh>("repairMesh"),

  // ---- Facts, measurement, interference --------------------------------
  computeMassProperties: rpc<typeof massProps.computeMassProperties>("computeMassProperties"),
  computeBom: rpc<typeof massProps.computeBom>("computeBom"),
  getEntityFacts: rpc<typeof entityFacts.getEntityFacts>("getEntityFacts"),
  measureEntities: rpc<typeof entityFacts.measureEntities>("measureEntities"),
  measureExact: rpc<typeof entityFacts.measureExact>("measureExact"),
  checkInterference: rpc<typeof entityFacts.checkInterference>("checkInterference"),
  checkInterferenceAll: rpc<typeof entityFacts.checkInterferenceAll>("checkInterferenceAll"),
  rebindPartsAcrossOps: rpc<typeof entityFacts.rebindPartsAcrossOps>("rebindPartsAcrossOps"),
  hitTest: rpc<typeof hitTestService.hitTest>("hitTest"),

  // ---- Mesh health, primitives, region fitting --------------------------
  checkMeshHealth: rpc<typeof meshHeal.checkMeshHealth>("checkMeshHealth"),
  promoteMeshToBrep: rpc<typeof meshHeal.promoteMeshToBrep>("promoteMeshToBrep"),
  recognizePrimitives: rpc<typeof primitiveReport.recognizePrimitives>("recognizePrimitives"),
  fitMeshRegion: rpc<typeof meshRegionFit.fitMeshRegion>("fitMeshRegion"),
  buildPrimitivesFile: rpc<typeof primitiveWrite.buildPrimitivesFile>("buildPrimitivesFile"),

  // ---- Drawings, diffing, rendering, catalog ---------------------------
  exportSvgSilhouette: rpc<typeof svgSilhouetteHost.exportSvgSilhouette>("exportSvgSilhouette"),
  compareModels: rpc<typeof modelDiffHost.compareModels>("compareModels"),
  searchStandardParts: rpc<typeof stepPartsService.searchStandardParts>("searchStandardParts"),
  downloadStandardPart: rpc<typeof stepPartsService.downloadStandardPart>("downloadStandardPart"),

  // ---- meshio++ route (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA, OpenFOAM) -----
  convertToStlBoundary: rpc<typeof meshio.convertToStlBoundary>("convertToStlBoundary"),
  convertToStlBoundaryWithRegions:
    rpc<typeof meshio.convertToStlBoundaryWithRegions>("convertToStlBoundaryWithRegions"),
  convertFoamCaseToStlBoundary:
    rpc<typeof meshio.convertFoamCaseToStlBoundary>("convertFoamCaseToStlBoundary"),
  readMeshioMetadata: rpc<typeof meshio.readMeshioMetadata>("readMeshioMetadata"),
  readMeshioDataInfo: rpc<typeof meshio.readMeshioDataInfo>("readMeshioDataInfo"),
  readMeshioFieldValues: rpc<typeof meshio.readMeshioFieldValues>("readMeshioFieldValues"),
  runMeshioOps: rpc<typeof meshio.runMeshioOps>("runMeshioOps"),
  exportViaMeshio: rpc<typeof meshio.exportViaMeshio>("exportViaMeshio"),
  buildPartsFromMeshioRegions:
    rpc<typeof meshioParts.buildPartsFromMeshioRegions>("buildPartsFromMeshioRegions"),
};
