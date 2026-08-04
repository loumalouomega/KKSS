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
import * as massProps from "../../cad/src/massProperties";
import * as entityFacts from "../../cad/src/entityFacts";
import * as meshio from "../../cad/src/meshioService";
// CPU-only, but it pulls in three + the webview facet segmenter — keep that
// out of the main bundle.
import * as meshioParts from "../../cad/src/meshioRegionParts";
// The parsed-B-rep cache holds live OCCT handles, so it lives here rather than
// in the host (see the module's own doc comment).
import * as brepCache from "./cadBRepCache";

interface RpcRequest {
  id: number;
  method: string;
  args: unknown[];
}

// No exported name collides across these five modules (checked at review time);
// a collision would silently shadow, so keep them disjoint.
const api: Record<string, (...args: never[]) => unknown> = {
  ...(occt as object),
  ...(gmsh as object),
  ...(massProps as object),
  ...(entityFacts as object),
  ...(meshio as object),
  ...(meshioParts as object),
  ...(brepCache as object),
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
