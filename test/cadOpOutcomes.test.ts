/**
 * Glue guard for the `geometry` post's op-outcome rebase (app/main/cadOpOutcomes.ts).
 *
 * The kernel replays only the unbaked tail of the edit list, so its indices are
 * tail-relative; the Edits panel indexes by full-history row. Getting the
 * shift wrong would put the ⚠ mark on the wrong row, which is worse than none.
 */
import { describe, expect, it } from "vitest";
import type { OpOutcome } from "../cad/src/editOps";
import type { OpBucket } from "../cad/src/opBuckets";
import { rebaseOpOutcomes } from "../app/main/cadOpOutcomes";

const tailOutcomes = (): OpOutcome[] => [
  { index: 0, kind: "fillet", applied: true },
  { index: 1, kind: "chamfer", applied: false, diagnostic: "no edges matched", hint: "pick an edge" },
];
const tailBuckets = (): OpBucket[] => [{ op: 0, kind: "fillet", roles: { band: ["face-3", "face-4"] } }];

describe("rebaseOpOutcomes", () => {
  it("is the identity when nothing is baked", () => {
    const outcomes = tailOutcomes();
    const buckets = tailBuckets();
    const out = rebaseOpOutcomes(outcomes, buckets, 0, []);
    expect(out.opOutcomes).toBe(outcomes);
    expect(out.opBuckets).toBe(buckets);
  });

  it("pads the baked prefix as applied and shifts the tail by bakedThrough", () => {
    const out = rebaseOpOutcomes(tailOutcomes(), tailBuckets(), 2, ["extrude", "addCylinder"]);
    expect(out.opOutcomes).toEqual([
      { index: 0, kind: "extrude", applied: true },
      { index: 1, kind: "addCylinder", applied: true },
      { index: 2, kind: "fillet", applied: true },
      { index: 3, kind: "chamfer", applied: false, diagnostic: "no edges matched", hint: "pick an edge" },
    ]);
  });

  it("shifts bucket op indices and leaves their other fields alone", () => {
    const out = rebaseOpOutcomes(tailOutcomes(), tailBuckets(), 3, ["extrude", "addCylinder", "addCylinder"]);
    expect(out.opBuckets).toEqual([{ op: 3, kind: "fillet", roles: { band: ["face-3", "face-4"] } }]);
  });

  it("never mutates its inputs", () => {
    const outcomes = tailOutcomes();
    const buckets = tailBuckets();
    rebaseOpOutcomes(outcomes, buckets, 2, ["extrude", "addCylinder"]);
    expect(outcomes).toEqual(tailOutcomes());
    expect(buckets).toEqual(tailBuckets());
  });

  it("pads only up to bakedThrough even if more kinds are supplied", () => {
    const out = rebaseOpOutcomes([], [], 1, ["extrude", "addCylinder"]);
    expect(out.opOutcomes).toEqual([{ index: 0, kind: "extrude", applied: true }]);
  });
});
