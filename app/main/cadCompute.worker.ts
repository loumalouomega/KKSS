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
// cad 1.3.0 moved every kernel call behind a forked child (kernelWorker.ts);
// this worker is KKSS's equivalent, so it mirrors that file's handler table.
import * as hitTestService from "../../cad/src/hitTestService";
import * as meshHeal from "../../cad/src/meshHeal";
import * as primitiveReport from "../../cad/src/primitiveReport";
import * as meshRegionFit from "../../cad/src/meshRegionFit";
import * as primitiveWrite from "../../cad/src/primitiveWrite";
import * as svgSilhouetteHost from "../../cad/src/svgSilhouetteHost";
import * as modelDiffHost from "../../cad/src/modelDiffHost";
import * as stepPartsService from "../../cad/src/stepPartsService";
// The parsed-B-rep cache holds live OCCT handles, so it lives here rather than
// in the host (see the module's own doc comment).
import * as brepCache from "./cadBRepCache";

interface RpcRequest {
  id: number;
  method: string;
  args: unknown[];
}

// No exported name may collide across these modules — a collision silently
// shadows, so `assertNoCollisions` below turns it into a startup failure
// instead of a mystery at call time.
const modules: Array<[string, object]> = [
  ["occtService", occt],
  ["gmshService", gmsh],
  ["massProperties", massProps],
  ["entityFacts", entityFacts],
  ["meshioService", meshio],
  ["meshioRegionParts", meshioParts],
  ["hitTestService", hitTestService],
  ["meshHeal", meshHeal],
  ["primitiveReport", primitiveReport],
  ["meshRegionFit", meshRegionFit],
  ["primitiveWrite", primitiveWrite],
  ["svgSilhouetteHost", svgSilhouetteHost],
  ["modelDiffHost", modelDiffHost],
  ["stepPartsService", stepPartsService],
  ["cadBRepCache", brepCache],
];

const api: Record<string, (...args: never[]) => unknown> = {};
const owner = new Map<string, string>();
for (const [name, mod] of modules) {
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value !== "function") continue;
    const previous = owner.get(key);
    if (previous) {
      throw new Error(
        `cadCompute.worker: "${key}" is exported by both ${previous} and ${name} — ` +
          `one would silently shadow the other. Rename the RPC or dispatch per module.`
      );
    }
    owner.set(key, name);
    api[key] = value as (...args: never[]) => unknown;
  }
}

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
