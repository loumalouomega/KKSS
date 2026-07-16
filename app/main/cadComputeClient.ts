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

type LoadBRep = typeof occt.loadBRep;
type ExportBRep = typeof occt.exportBRep;
type GenerateMesh = typeof gmsh.generateMesh;
type ExportGeoUnrolled = typeof gmsh.exportGeoUnrolled;
type ExportMeshFormat = typeof gmsh.exportMeshFormat;
type ExportMdpa = typeof gmsh.exportMdpa;

export const cadCompute = {
  loadBRep: (...args: Parameters<LoadBRep>) => call<Awaited<ReturnType<LoadBRep>>>("loadBRep", args),
  exportBRep: (...args: Parameters<ExportBRep>) => call<Awaited<ReturnType<ExportBRep>>>("exportBRep", args),
  generateMesh: (...args: Parameters<GenerateMesh>) =>
    call<Awaited<ReturnType<GenerateMesh>>>("generateMesh", args),
  exportGeoUnrolled: (...args: Parameters<ExportGeoUnrolled>) =>
    call<Awaited<ReturnType<ExportGeoUnrolled>>>("exportGeoUnrolled", args),
  exportMeshFormat: (...args: Parameters<ExportMeshFormat>) =>
    call<Awaited<ReturnType<ExportMeshFormat>>>("exportMeshFormat", args),
  exportMdpa: (...args: Parameters<ExportMdpa>) => call<Awaited<ReturnType<ExportMdpa>>>("exportMdpa", args),
};
