/**
 * Worker-thread host for the cad submodule's heavy WASM services (OpenCascade
 * tessellation + Gmsh meshing). These are multi-second blocking calls; in
 * VS Code they only block the extension host, but in Electron's main process
 * they would freeze the whole UI — so they run here, behind a tiny RPC
 * (see cadComputeClient.ts). The submodule functions are called unmodified;
 * `extensionPath` points at out/cad-runtime, which carries the dist/-shaped
 * WASM layout occtService/gmshService expect.
 */
import { parentPort } from "node:worker_threads";
import * as occt from "../../cad/src/occtService";
import * as gmsh from "../../cad/src/gmshService";

interface RpcRequest {
  id: number;
  method: string;
  args: unknown[];
}

const api: Record<string, (...args: never[]) => unknown> = {
  ...(occt as object),
  ...(gmsh as object),
} as Record<string, (...args: never[]) => unknown>;

const port = parentPort;
if (!port) throw new Error("cadCompute.worker must run as a worker thread");

port.on("message", async (req: RpcRequest) => {
  try {
    const fn = api[req.method];
    if (typeof fn !== "function") {
      throw new Error(`Unknown cadCompute method: ${req.method}`);
    }
    const value = await fn(...(req.args as never[]));
    port.postMessage({ id: req.id, ok: true, value });
  } catch (err) {
    port.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? `${err.message}` : String(err),
    });
  }
});
