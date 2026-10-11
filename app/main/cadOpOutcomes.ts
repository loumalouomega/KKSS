/**
 * app/main/cadOpOutcomes.ts — re-bases the kernel's per-op results onto the
 * document's full edit history.
 *
 * A B-rep load replays only the unbaked tail of the edit list (`replayTail`),
 * so the kernel's `opOutcomes` / `opBuckets` indices are tail-relative. The
 * Edits panel indexes its rows by full-history position, so the host shifts
 * them by `bakedThrough` before posting `geometry` — a 1:1 port of the rebase
 * inside `cad/src/provider.ts`'s `handleBRep`, kept here (vscode-free) so it
 * can be unit-tested. Baked rows are in the source file by definition, hence
 * they pad as applied, never as skipped.
 */
import type { EditOpKind, OpOutcome } from "../../cad/src/editOps";
import type { OpBucket } from "../../cad/src/opBuckets";

export function rebaseOpOutcomes(
  opOutcomes: OpOutcome[],
  opBuckets: OpBucket[],
  bakedThrough: number,
  bakedKinds: EditOpKind[]
): { opOutcomes: OpOutcome[]; opBuckets: OpBucket[] } {
  if (bakedThrough <= 0) return { opOutcomes, opBuckets };
  return {
    opOutcomes: [
      ...bakedKinds.slice(0, bakedThrough).map((kind, index): OpOutcome => ({ index, kind, applied: true })),
      ...opOutcomes.map((o) => ({ ...o, index: o.index + bakedThrough })),
    ],
    opBuckets: opBuckets.map((b) => ({ ...b, op: b.op + bakedThrough })),
  };
}
