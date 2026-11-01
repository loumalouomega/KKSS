import { describe, expect, it } from "vitest";
import { expandSweep, parseSweepMode } from "../app/main/services/workflows/sweepExpansion";

describe("expandSweep", () => {
  it("keeps the one-parameter labels the original sweep used", () => {
    for (const mode of ["grid", "paired"] as const) {
      const { rows, count } = expandSweep([{ name: "values.problem.timeStep", values: [0.05, "fast", true] }], mode);
      expect(count).toBe(3);
      expect(rows.map(r => r.label)).toEqual(["values.problem.timeStep=0.05", "values.problem.timeStep=fast", "values.problem.timeStep=true"]);
    }
  });
  it("expands a grid like nested loops, last parameter fastest", () => {
    const { rows, summary } = expandSweep([{ name: "a", values: [1, 2] }, { name: "b", values: ["x", "y", "z"] }], "grid");
    expect(summary).toBe("grid 2 × 3 = 6 rows");
    expect(rows.map(r => r.label)).toEqual(["a=1, b=x", "a=1, b=y", "a=1, b=z", "a=2, b=x", "a=2, b=y", "a=2, b=z"]);
    expect(rows[4].assignment).toEqual({ a: 2, b: "y" });
  });
  it("pairs equal-length lists and names the lengths when they differ", () => {
    expect(expandSweep([{ name: "a", values: [1, 2] }, { name: "b", values: [10, 20] }], "paired").rows.map(r => r.label)).toEqual(["a=1, b=10", "a=2, b=20"]);
    expect(() => expandSweep([{ name: "a", values: [1, 2] }, { name: "b", values: [10] }], "paired")).toThrow(/equal length \(a: 2, b: 1\)/);
  });
  it("refuses an oversized grid with its arithmetic, before building anything", () => {
    const big = (name: string, n: number) => ({ name, values: Array.from({ length: n }, (_, i) => i) });
    expect(() => expandSweep([big("a", 5), big("b", 5), big("c", 3)], "grid")).toThrow(/5 × 5 × 3 = 75 rows; the cap is 50/);
    expect(() => expandSweep([big("a", 51)], "grid")).toThrow(/cap is 50/);
    expect(expandSweep([big("a", 10), big("b", 5)], "grid").count).toBe(50);
  });
  it("validates parameters", () => {
    expect(() => expandSweep([], "grid")).toThrow();
    expect(() => expandSweep(Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, values: [1] })), "grid")).toThrow(/1–4/);
    expect(() => expandSweep([{ name: "a", values: [1] }, { name: "a", values: [2] }], "grid")).toThrow(/twice/);
    expect(() => expandSweep([{ name: "a", values: [1, 1] }], "grid")).toThrow(/repeated/);
    expect(() => expandSweep([{ name: "a", values: [] }], "grid")).toThrow(/at least one/);
  });
  it("parses the mode", () => {
    expect(parseSweepMode(undefined)).toBe("grid");
    expect(parseSweepMode("paired")).toBe("paired");
    expect(() => parseSweepMode("cartesian")).toThrow();
  });
});
