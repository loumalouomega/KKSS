/**
 * Conflict policy for the write-back engine. Pure.
 *
 * The rule the whole feature rests on: **a remote change is never overwritten
 * and a local change is never discarded.** When the two have diverged we keep
 * the local file exactly as it is and upload it beside the remote one under a
 * `(conflict …)` name, then adopt the remote's current revision as the new
 * baseline so the next debounce tick does not re-conflict forever.
 */
import { meshStem } from "../../../../mesh/src/parser/meshFormats";
import { suffixOf } from "./cachePathCore";

export type UploadDecision = "upload" | "conflict";

/**
 * `storedRev` is the revision the file had when we last synced it; `remoteRev`
 * is what the provider reports right now.
 *
 * A missing revision on either side decides **conflict**, deliberately: without
 * a baseline we cannot prove the remote is unchanged, and the cost of being
 * wrong is asymmetric — a spurious `(conflict …)` copy is a tidy-up, a
 * clobbered remote edit is lost work.
 */
export function decideUpload(input: {
  storedRev?: string;
  remoteRev?: string;
}): UploadDecision {
  if (!input.storedRev || !input.remoteRev) return "conflict";
  return input.storedRev === input.remoteRev ? "upload" : "conflict";
}

/**
 * `case.post.msh` → `case (conflict 2026-09-06 14-03-11).post.msh`.
 *
 * Split on the **longest** suffix (mesh's `meshStem`, the same authority
 * `router.ts` uses), never the last dot — `case.post (conflict …).msh` would
 * re-route as Gmsh instead of GiD postprocess and quietly become a different
 * format. The timestamp is UTC so the name is stable regardless of where the
 * two machines editing the file happen to be.
 */
export function conflictName(name: string, now: Date): string {
  const suffix = suffixOf(name);
  const stem = name.slice(0, name.length - suffix.length) || meshStem(name);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ` +
    `${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
  return `${stem} (conflict ${stamp})${suffix}`;
}
