/**
 * Worker-side holder for cad's parsed-B-rep cache (cad 1.2.6's
 * `loadBRepCached`), bundled into cadCompute.worker.ts.
 *
 * The provider keeps a per-document `BRepCacheEntry` so an interactive edit
 * replays from a cached base shape instead of re-parsing the file. That entry
 * owns live OCCT handles, so it can never cross the worker RPC boundary —
 * hence this shim: the cache lives beside the OCCT singleton that owns it, and
 * only the structured-clone-safe `BRepResult` is returned. KKSS supports N
 * concurrently open CAD tabs (each with its own `CadHost`), so entries are
 * keyed by a `sessionId` the host assigns per tab; `releaseBRepCache` is the
 * counterpart of that tab's `onDidDispose`/tab-close teardown.
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

const entries = new Map<string, BRepCacheEntry>();

/** `loadBRepCached` against the worker-held entry for this tab's session. */
export async function loadBRepCachedInWorker(
  sessionId: string,
  extensionPath: string,
  bytes: Uint8Array,
  format: Extract<CadFormat, "step" | "iges" | "brep">,
  ops: EditOp[],
  quality: TessellationParams
): Promise<BRepResult> {
  try {
    const { result, cache } = await loadBRepCached(
      extensionPath,
      bytes,
      format,
      ops,
      entries.get(sessionId),
      quality
    );
    entries.set(sessionId, cache);
    return result;
  } catch (err) {
    // Drop, never dispose — a thrown call may have left the entry
    // half-torn-down (possibly by a WASM abort), and `loadBRepCached`'s doc
    // comment is explicit that disposing it then is unsafe. The next call
    // starts from a clean parse. Same choice provider.handleBRep's catch makes.
    entries.delete(sessionId);
    throw err;
  }
}

/** Frees this tab's held entry's OCCT handles (tab close / document change). */
export function releaseBRepCache(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (entry) disposeBRepCache(entry);
  entries.delete(sessionId);
}
