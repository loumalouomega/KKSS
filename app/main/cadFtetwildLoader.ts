/**
 * Resolution shim for `float-tetwild-wasm`, aliased in place of the real
 * package in the cad compute worker (esbuild.mjs `cadWorkerConfig`).
 *
 * Same problem and same shape as app/main/cadMeshioLoader.ts, for the fourth
 * WASM kernel cad 1.5.0 added (`cad/src/ftetwildService.ts`, behind Mesh
 * health ▸ Repair and Promote-to-B-rep). Two reasons it cannot be bundled:
 *
 *   1. The package is ESM-only (`"type": "module"`, no CJS build) and its
 *      threaded glue uses a **top-level await**, which esbuild refuses to emit
 *      into a `cjs` bundle at all — so this is a hard build error, not just a
 *      runtime one.
 *   2. The Emscripten glue locates its `.wasm` (and, for the threaded build,
 *      `libtbb.so*`) relative to its own file, so the tree has to exist on
 *      disk. That is the same reason electron-builder.yml sets `asar: false`.
 *
 * cad's `getFtetwild()` forces `{ threads: false }`, so only the serial pair
 * is ever loaded — but the whole package tree is copied regardless, since
 * that choice belongs to the submodule and may change on a bump.
 *
 * License note: float-tetwild-wasm is MPL-2.0 — file-level copyleft,
 * compatible with KKSS's AGPL-3.0 via MPL 2.0 §3.3. It ships verbatim.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FtetwildNamespace = { loadFloatTetwild: (...args: any[]) => Promise<any> };

let resolvedDir: string | undefined;

/**
 * The installed package directory: the copied tree beside the bundle
 * (`out/ftetwild`, the packaged layout), else cad's node_modules when running
 * from a source checkout. Resolution cannot change at runtime, so the answer
 * is cached.
 *
 * Deliberately not `require.resolve(...)`: the esbuild alias that routes the
 * bare specifier here catches its subpaths too, so esbuild would try to
 * resolve one against *this file* at build time — the trap documented in
 * cadMeshioLoader.ts.
 */
function packageDir(): string {
  if (resolvedDir) return resolvedDir;
  const candidates = [
    path.join(__dirname, "ftetwild"), // packaged: esbuild.mjs copies the tree here
    path.join(__dirname, "..", "cad", "node_modules", "float-tetwild-wasm"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.js"))) {
      resolvedDir = dir;
      return resolvedDir;
    }
  }
  throw new Error(
    "float-tetwild-wasm was not found — mesh repair and mesh→B-rep promotion are unavailable."
  );
}

// Hidden from esbuild AND from tsc's CommonJS downlevelling, both of which
// would rewrite a literal import() into a require() and break on this
// ESM-only package (cadMeshioLoader.ts uses the same trick).
const dynImport = new Function("u", "return import(u)") as (u: string) => Promise<FtetwildNamespace>;

let nsPromise: Promise<FtetwildNamespace> | undefined;

function namespace(): Promise<FtetwildNamespace> {
  if (!nsPromise) {
    const entry = path.join(packageDir(), "index.js");
    nsPromise = dynImport(pathToFileURL(entry).href).catch((e: unknown) => {
      nsPromise = undefined; // never poison the cache with a transient failure
      throw e;
    });
  }
  return nsPromise;
}

/**
 * Drop-in for the package's own named export. Unlike meshio++, the loader
 * resolves its own `dist/*.mjs` siblings relative to `index.js`, so no
 * `locateFile` override is needed — the copied tree keeps that layout.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadFloatTetwild(options?: any): Promise<any> {
  const ns = await namespace();
  return ns.loadFloatTetwild(options);
}

export default loadFloatTetwild;
