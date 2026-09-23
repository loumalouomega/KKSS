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
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
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
import { createKernelTracker } from "./cadKernelStatus";

interface PendingCall {
  id: number;
  method: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  jobKey?: string;
  jobRecord?: OwnedJobRecord;
}

export interface OwnedJobRecord {
  version: 1; jobId: string; ownerId: string; requestId: string;
  state: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  startedAt?: number; finishedAt?: number; message?: string;
}
interface OwnedJobContext { key: string; record: OwnedJobRecord }

let worker: Worker | undefined;
let nextId = 1;
const queue: PendingCall[] = [];
let activeCall: PendingCall | undefined;
const jobs = new Map<string, OwnedJobRecord>();
const jobStorage = new AsyncLocalStorage<OwnedJobContext>();

// One worker serves every CAD tab, so kernel readiness is app-wide state — the
// analogue of the per-provider `kernelState()` cad 3.0.0 exposes. Inferred from
// calls (see cadKernelStatus.ts); cadHost fans changes out as `kernelStatus`.
const kernels = createKernelTracker();
export const kernelState = kernels.state;
export const onKernelState = kernels.subscribe;

function ensureWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(path.join(__dirname, "cadCompute.worker.js"));
  worker = instance;
  instance.on("message", (res: { id: number; ok: boolean; value?: unknown; error?: string }) => {
    if (worker !== instance || activeCall?.id !== res.id) return;
    const call = activeCall;
    activeCall = undefined;
    if (res.ok) call.resolve(res.value);
    else call.reject(new Error(res.error ?? "cadCompute worker error"));
    pump();
  });
  instance.on("error", (err) => {
    const error = err instanceof Error ? err : new Error(String(err));
    failWorker(instance, error);
  });
  instance.on("exit", () => {
    failWorker(instance, new Error("cadCompute worker exited"));
  });
  return instance;
}

function failWorker(instance: Worker, error: Error): void {
  if (worker !== instance) return;
  worker = undefined;
  kernels.reset(); // the WASM kernels died with the worker
  const call = activeCall;
  activeCall = undefined;
  call?.reject(error);
  pump();
}

function pump(): void {
  if (activeCall || !queue.length) return;
  const call = queue.shift()!;
  if (call.jobRecord && ["cancelling", "cancelled"].includes(call.jobRecord.state)) {
    call.reject(new Error(`CAD job ${call.jobRecord.requestId} was cancelled by owner ${call.jobRecord.ownerId}.`));
    pump();
    return;
  }
  activeCall = call;
  if (call.jobRecord) {
    call.jobRecord.state = "running";
    call.jobRecord.startedAt ??= Date.now();
  }
  kernels.start(call.method);
  try {
    ensureWorker().postMessage({ id: call.id, method: call.method, args: call.args });
  } catch (err) {
    activeCall = undefined;
    kernels.failure(call.method);
    call.reject(err instanceof Error ? err : new Error(String(err)));
    pump();
  }
}

function call<T>(method: string, args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job = jobStorage.getStore();
    if (job && ["cancelling", "cancelled"].includes(job.record.state)) {
      reject(new Error(`CAD job ${job.record.requestId} was cancelled by owner ${job.record.ownerId}.`));
      return;
    }
    const id = nextId++;
    queue.push({ id, method, args, jobKey: job?.key, jobRecord: job?.record,
      resolve: (value) => {
        kernels.success(method);
        resolve(value as T);
      },
      reject: (err) => {
        kernels.failure(method);
        reject(err);
      },
    });
    pump();
  });
}

export async function runOwnedJob<T>(identity: { ownerId: string; requestId: string; jobId?: string }, action: () => Promise<T>): Promise<T> {
  if (!identity.ownerId.trim() || !identity.requestId.trim()) throw new Error("Owned CAD jobs require stable ownerId and requestId values.");
  const key = `${identity.ownerId}\0${identity.requestId}`;
  if (jobs.has(key)) throw new Error(`CAD job ${identity.requestId} was already registered for this owner.`);
  const record: OwnedJobRecord = { version: 1, jobId: identity.jobId ?? randomUUID(), ownerId: identity.ownerId, requestId: identity.requestId, state: "queued" };
  jobs.set(key, record);
  while (jobs.size > 500) {
    const first = jobs.entries().next().value as [string, OwnedJobRecord] | undefined;
    if (!first || ["queued", "running", "cancelling"].includes(first[1].state)) break;
    jobs.delete(first[0]);
  }
  return jobStorage.run({ key, record }, async () => {
    try {
      const value = await action();
      if (["cancelling", "cancelled"].includes(record.state)) throw new Error(`CAD job ${record.requestId} was cancelled by owner ${record.ownerId}.`);
      record.state = "succeeded"; record.finishedAt = Date.now();
      return value;
    } catch (error) {
      record.state = ["cancelling", "cancelled"].includes(record.state) ? "cancelled" : "failed";
      record.finishedAt = Date.now();
      record.message = error instanceof Error ? error.message : String(error);
      throw error;
    }
  });
}

export function jobStatus(ownerId: string, requestId: string): OwnedJobRecord | undefined {
  const record = jobs.get(`${ownerId}\0${requestId}`);
  return record ? structuredClone(record) : undefined;
}

export function cancelOwnedJob(ownerId: string, requestId: string): OwnedJobRecord | undefined {
  const key = `${ownerId}\0${requestId}`;
  const record = jobs.get(key);
  if (!record) return undefined;
  if (record.state === "queued") {
    record.state = "cancelled"; record.finishedAt = Date.now();
  } else if (record.state === "running") {
    record.state = "cancelling";
    for (const call of queue.splice(0)) {
      if (call.jobKey === key) call.reject(new Error(`CAD job ${requestId} was cancelled by owner ${ownerId}.`));
      else queue.push(call);
    }
    if (activeCall?.jobKey === key) {
      const current = activeCall, instance = worker;
      activeCall = undefined;
      worker = undefined;
      kernels.reset();
      current.reject(new Error(`CAD job ${requestId} was cancelled by owner ${ownerId}.`));
      if (instance) void instance.terminate();
      pump();
    }
  }
  return structuredClone(record);
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
  // cad 1.9.0's selector synthesis — all three live in entityFacts.ts, which the
  // worker already spreads, so only these bindings were missing (they mirror
  // cad/src/kernelClient.ts's own additions).
  resolveBucketSelector: rpc<typeof entityFacts.resolveBucketSelector>("resolveBucketSelector"),
  synthesizeSelector: rpc<typeof entityFacts.synthesizeSelector>("synthesizeSelector"),
  resolvePartSelectors: rpc<typeof entityFacts.resolvePartSelectors>("resolvePartSelectors"),
  hitTest: rpc<typeof hitTestService.hitTest>("hitTest"),

  // ---- Mesh health, primitives, region fitting --------------------------
  checkMeshHealth: rpc<typeof meshHeal.checkMeshHealth>("checkMeshHealth"),
  promoteMeshToBrep: rpc<typeof meshHeal.promoteMeshToBrep>("promoteMeshToBrep"),
  recognizePrimitives: rpc<typeof primitiveReport.recognizePrimitives>("recognizePrimitives"),
  fitMeshRegion: rpc<typeof meshRegionFit.fitMeshRegion>("fitMeshRegion"),
  buildPrimitivesFile: rpc<typeof primitiveWrite.buildPrimitivesFile>("buildPrimitivesFile"),

  // ---- Drawings, diffing, rendering, catalog ---------------------------
  exportSvgSilhouette: rpc<typeof svgSilhouetteHost.exportSvgSilhouette>("exportSvgSilhouette"),
  exportDrawingSheet: rpc<typeof svgSilhouetteHost.exportDrawingSheet>("exportDrawingSheet"),
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
  readMeshioProvenance: rpc<typeof meshio.readMeshioProvenance>("readMeshioProvenance"),
  decimateStlBoundary: rpc<typeof meshio.decimateStlBoundary>("decimateStlBoundary"),
  runMeshioOps: rpc<typeof meshio.runMeshioOps>("runMeshioOps"),
  exportViaMeshio: rpc<typeof meshio.exportViaMeshio>("exportViaMeshio"),
  buildPartsFromMeshioRegions:
    rpc<typeof meshioParts.buildPartsFromMeshioRegions>("buildPartsFromMeshioRegions"),
};
