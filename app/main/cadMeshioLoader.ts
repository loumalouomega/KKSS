/**
 * Resolution shim for `@meshioplusplus/wasm`, aliased in place of the real
 * package in the cad compute worker (esbuild.mjs `cadWorkerConfig`).
 *
 * Why this exists: `cad/src/meshioService.ts` loads the package with a bare
 * `await import("@meshioplusplus/wasm")` and no directory fallback — unlike
 * `mesh/src/parser/meshio.ts`, whose `packageDir()` ends at
 * `__dirname/meshio`. That bare specifier resolves fine in the extension
 * (which ships its own node_modules) but KKSS ships none, so every meshio
 * route would die with ERR_MODULE_NOT_FOUND in a packaged install. The
 * submodule is consumed verbatim, so the fix lives here: same `out/meshio/`
 * tree esbuild.mjs already copies from `mesh/dist/meshio` (cad and mesh both
 * pin ^9.9.0, so one copy serves both).
 *
 * The alias only rewrites the bare specifier; mesh's own loader builds its
 * import path at runtime, so it is untouched by it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MeshioNamespace = { loadMeshioPlusPlus: (...args: any[]) => Promise<any> };

let resolvedDir: string | undefined;

/**
 * The installed package directory: the copied tree beside the bundle
 * (`out/meshio`, the packaged layout), else a submodule's node_modules when
 * running from a source checkout. Resolution cannot change at runtime, so the
 * answer is cached.
 *
 * Deliberately NOT `require.resolve("@meshioplusplus/wasm/package.json")` the
 * way mesh's own loader does: the esbuild alias that routes the bare specifier
 * here also catches that subpath, so esbuild would try to resolve it against
 * *this file* at build time and fail with "not a directory".
 */
function packageDir(): string {
  if (resolvedDir) return resolvedDir;
  const candidates = [
    path.join(__dirname, "meshio"), // packaged: esbuild.mjs copies mesh/dist/meshio here
    path.join(__dirname, "..", "mesh", "node_modules", "@meshioplusplus", "wasm"),
    path.join(__dirname, "..", "cad", "node_modules", "@meshioplusplus", "wasm"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "src", "index.mjs"))) {
      resolvedDir = dir;
      return resolvedDir;
    }
  }
  throw new Error("@meshioplusplus/wasm was not found — the meshio++ CAD formats are unavailable.");
}

// Hidden from esbuild AND from tsc's CommonJS downlevelling, both of which
// would rewrite a literal import() into a require() and break on this
// ESM-only package (mesh/src/parser/meshio.ts uses the same trick).
const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<MeshioNamespace>;

let nsPromise: Promise<MeshioNamespace> | undefined;

function namespace(): Promise<MeshioNamespace> {
  if (!nsPromise) {
    const entry = path.join(packageDir(), "src", "index.mjs");
    nsPromise = dynImport(pathToFileURL(entry).href).catch((e: unknown) => {
      nsPromise = undefined; // never poison the cache with a transient failure
      throw e;
    });
  }
  return nsPromise;
}

/**
 * Drop-in for the package's own named export. `locateFile` is passed
 * explicitly and stays **name-aware**: the loader hands it the bare filename
 * of whichever variant it picked, and returning a fixed path would hand the
 * threaded glue the sequential binary — a bare LinkError naming neither.
 * cad's `getMeshio()` forces `{ variant: "seq" }`, but the override must not
 * depend on that.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadMeshioPlusPlus(overrides?: any, options?: any): Promise<any> {
  const ns = await namespace();
  const dist = path.join(packageDir(), "dist");
  return ns.loadMeshioPlusPlus(
    { locateFile: (name: string) => path.join(dist, path.basename(name)), ...overrides },
    options
  );
}
