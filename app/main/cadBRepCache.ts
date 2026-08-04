/**
 * Worker-side holder for cad's parsed-B-rep cache (cad 1.2.6's
 * `loadBRepCached`), bundled into cadCompute.worker.ts.
 *
 * The provider keeps a per-document `BRepCacheEntry` so an interactive edit
 * replays from a cached base shape instead of re-parsing the file. That entry
 * owns live OCCT handles, so it can never cross the worker RPC boundary —
 * hence this shim: the cache lives beside the OCCT singleton that owns it, and
 * only the structured-clone-safe `BRepResult` is returned. KKSS is
 * one-document-per-mode, so a single slot is enough; `releaseBRepCache` is the
 * counterpart of the provider's `onDidDispose` teardown.
 */
import {
  loadBRepCached,
  disposeBRepCache,
  type BRepCacheEntry,
  type BRepResult,
} from "../../cad/src/occtService";
import type { TessellationParams } from "../../cad/src/tessellationQuality";
import type { CadFormat } from "../../cad/src/fileRouter";
import type { EditOp } from "../../cad/src/editOps";

let current: BRepCacheEntry | undefined;

/** `loadBRepCached` against the worker-held entry — see provider.handleBRep. */
export async function loadBRepCachedInWorker(
  extensionPath: string,
  bytes: Uint8Array,
  format: Extract<CadFormat, "step" | "iges" | "brep">,
  ops: EditOp[],
  quality: TessellationParams
): Promise<BRepResult> {
  try {
    const { result, cache } = await loadBRepCached(extensionPath, bytes, format, ops, current, quality);
    current = cache;
    return result;
  } catch (err) {
    // Drop, never dispose — a thrown call may have left the entry
    // half-torn-down (possibly by a WASM abort), and `loadBRepCached`'s doc
    // comment is explicit that disposing it then is unsafe. The next call
    // starts from a clean parse. Same choice provider.handleBRep's catch makes.
    current = undefined;
    throw err;
  }
}

/** Frees the held entry's OCCT handles (session teardown / document change). */
export function releaseBRepCache(): void {
  if (current) disposeBRepCache(current);
  current = undefined;
}
