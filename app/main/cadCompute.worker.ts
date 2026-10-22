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
// cad 3.22.0 moved auto-decimate off meshio++'s quadric `decimate` onto mmgs
// (coarsenStlBoundary, Hausdorff-bisected) — an MMG run, hence worker-only.
import * as mmgCoarsen from "../../cad/src/mmgCoarsen";
// CPU-only, but it pulls in three + the webview facet segmenter — keep that
// out of the main bundle.
import * as meshioParts from "../../cad/src/meshioRegionParts";
import * as meshEditBake from "../../cad/src/meshEditBake";
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
import * as brepHealth from "../../cad/src/brepHealth";
import * as passageAnalysis from "../../cad/src/passageAnalysisHost";
import * as meshDeviation from "../../cad/src/meshDeviationHost";
import * as printabilityHost from "../../cad/src/printabilityHost";
// cad 3.28.0's Draft / undercut facts: the kernel half of `check_draft` and of
// the Draft panel's overlay, beside the printability host it mirrors.
import * as draftAnalysisHost from "../../cad/src/draftAnalysisHost";
// cad 3.19.0's Fit to CAD: meshio++ fitCad over a segmented, primitive-fitted
// closed skin — the analytic counterpart of meshHeal's promotion.
import * as meshFitCad from "../../cad/src/meshFitCad";
// cad 3.14.0 compressed glTF: Draco/meshopt geometry expansion runs in the
// kernel worker (WASM decoders never run in the host process).
import * as gltfDecode from "../../cad/src/gltfDecode";
// cad 3.26.0's OpenSCAD WASM port: .scad evaluation without an installed
// binary (convertScadViaWasm). Worker-side for the same reason as the binary
// path's cwd trick — `use`/`include` resolve relative to the source file.
import * as scadWasm from "../../cad/src/scadWasmService";
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
  ["mmgCoarsen", mmgCoarsen],
  ["meshioRegionParts", meshioParts],
  ["meshEditBake", meshEditBake],
  ["hitTestService", hitTestService],
  ["meshHeal", meshHeal],
  ["primitiveReport", primitiveReport],
  ["meshRegionFit", meshRegionFit],
  ["primitiveWrite", primitiveWrite],
  ["svgSilhouetteHost", svgSilhouetteHost],
  ["modelDiffHost", modelDiffHost],
  ["stepPartsService", stepPartsService],
  ["brepHealth", brepHealth],
  ["passageAnalysisHost", passageAnalysis],
  ["meshDeviationHost", meshDeviation],
  ["printabilityHost", printabilityHost],
  ["draftAnalysisHost", draftAnalysisHost],
  ["meshFitCad", meshFitCad],
  ["gltfDecode", gltfDecode],
  ["scadWasm", scadWasm],
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
    // cad 3.26.0's kernelIpc parity: the error's class name travels with the
    // message, so the host can tell a ScadWasmFallbackError (decline to the
    // binary path) from a genuine conversion failure — without it every
    // worker error arrives as a plain Error and WASM-first .scad conversion
    // would never fall back.
    port.postMessage({
      id: req.id,
      ok: false,
      error: {
        message: err instanceof Error ? `${err.message}` : String(err),
        ...(err instanceof Error && err.name && err.name !== "Error" ? { name: err.name } : {}),
      },
    });
  }
});
