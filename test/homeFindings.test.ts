import { describe, expect, it } from "vitest";
import { findingRows, showArgs } from "../app/renderer/home/findings";

describe("home review findings", () => {
  it("keeps only well-formed rows and maps known targets", () => {
    const rows = findingRows({ evidence: { findings: [
      { severity: "warning", message: "bad mesh", target: "mesh" },
      { severity: "unavailable", message: "no monitor", target: "results" },
      { severity: "unavailable", message: "unknown target", target: "elsewhere" },
      { severity: "loud", message: "bad severity" },
      { severity: "error" },
      null,
    ] } });
    expect(rows).toEqual([
      { severity: "warning", message: "bad mesh", stage: "mesh" },
      { severity: "unavailable", message: "no monitor", stage: "results" },
      { severity: "unavailable", message: "unknown target" },
    ]);
  });
  it("is undefined for a value that is not a review", () => {
    expect(findingRows("text")).toBeUndefined();
    expect(findingRows({ evidence: {} })).toBeUndefined();
    expect(findingRows(null)).toBeUndefined();
  });
  it("builds study_open arguments; only results carries the run", () => {
    expect(showArgs({ severity: "warning", message: "m", stage: "mesh" }, "s1", "r1")).toEqual({ studyId: "s1", stage: "mesh" });
    expect(showArgs({ severity: "warning", message: "m", stage: "results" }, "s1", "r1")).toEqual({ studyId: "s1", stage: "results", runId: "r1" });
    expect(showArgs({ severity: "warning", message: "m" }, "s1", "r1")).toBeUndefined();
    expect(showArgs({ severity: "warning", message: "m", stage: "mesh" }, undefined, undefined)).toBeUndefined();
  });
});
