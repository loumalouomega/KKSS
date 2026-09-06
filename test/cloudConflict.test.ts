/**
 * services/cloud/conflictCore.ts — the rule that a remote change is never
 * overwritten and a local change is never discarded.
 */
import { describe, expect, it } from "vitest";
import { conflictName, decideUpload } from "../app/main/services/cloud/conflictCore";

describe("decideUpload", () => {
  it("uploads only when the remote is provably unchanged", () => {
    expect(decideUpload({ storedRev: "r1", remoteRev: "r1" })).toBe("upload");
    expect(decideUpload({ storedRev: "r1", remoteRev: "r2" })).toBe("conflict");
  });

  it("treats a missing revision on either side as a conflict", () => {
    // Without a baseline we cannot prove the remote is unchanged, and the cost
    // is asymmetric: a spurious conflict copy is tidy-up, a clobbered remote
    // edit is lost work.
    expect(decideUpload({ remoteRev: "r1" })).toBe("conflict");
    expect(decideUpload({ storedRev: "r1" })).toBe("conflict");
    expect(decideUpload({})).toBe("conflict");
    expect(decideUpload({ storedRev: "", remoteRev: "" })).toBe("conflict");
  });
});

describe("conflictName", () => {
  const at = new Date(Date.UTC(2026, 8, 6, 14, 3, 11));

  it("keeps the whole compound suffix at the end, where the router looks", () => {
    // `case.post (conflict …).msh` would re-route as Gmsh instead of GiD.
    expect(conflictName("case.post.msh", at)).toBe("case (conflict 2026-09-06 14-03-11).post.msh");
  });

  it("handles an ordinary extension and a name with none", () => {
    expect(conflictName("bull.stp", at)).toBe("bull (conflict 2026-09-06 14-03-11).stp");
    expect(conflictName("README", at)).toBe("README (conflict 2026-09-06 14-03-11)");
  });

  it("preserves the original case of the suffix", () => {
    expect(conflictName("BULL.STP", at)).toBe("BULL (conflict 2026-09-06 14-03-11).STP");
  });

  it("pads every component so names sort chronologically", () => {
    const early = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(conflictName("a.stp", early)).toBe("a (conflict 2026-01-02 03-04-05).stp");
  });
});
