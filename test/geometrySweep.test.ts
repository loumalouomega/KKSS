import { describe, expect, it } from "vitest";
import { geometryDestination, overrideVariable, sidecarCandidates, variableExpressions } from "../app/main/services/workflows/geometrySweep";

describe("variableExpressions", () => {
  it("turns numbers and expressions into text", () => {
    expect(variableExpressions("L", [10, 12.5, "2*W"])).toEqual({ name: "L", expressions: ["10", "12.5", "2*W"] });
  });
  it("rejects bad names, counts, non-finite and duplicate values", () => {
    expect(() => variableExpressions("1L", [1])).toThrow(/variable/);
    expect(() => variableExpressions("L", [])).toThrow(/1–50/);
    expect(() => variableExpressions("L", Array.from({ length: 51 }, (_, i) => i))).toThrow(/1–50/);
    expect(() => variableExpressions("L", [Infinity])).toThrow(/finite/);
    expect(() => variableExpressions("L", [1, "1"])).toThrow(/distinct/);
    expect(() => variableExpressions("L", [{}])).toThrow();
  });
});

describe("geometryDestination", () => {
  it("keeps the file name inside the run directory", () => {
    expect(geometryDestination(".kkss/runs/r1", "/models/plate.step")).toBe(".kkss/runs/r1/geometry/plate.step");
    expect(geometryDestination(".kkss/runs/r1", "../../etc/plate.step")).toBe(".kkss/runs/r1/geometry/plate.step");
  });
});

describe("sidecars and variable override", () => {
  it("lists every sidecar beside the model", () => {
    const files = sidecarCandidates("/m/plate.step");
    expect(files).toContain("/m/plate.step.edits.json");
    expect(files.every(f => f.startsWith("/m/plate.step."))).toBe(true);
  });
  it("replaces only the swept expression and refuses an unknown variable", () => {
    const vars = [{ name: "L", expr: "10" }, { name: "W", expr: "L/2" }];
    expect(overrideVariable(vars, "L", "20")).toEqual([{ name: "L", expr: "20" }, { name: "W", expr: "L/2" }]);
    expect(vars[0].expr).toBe("10");
    expect(() => overrideVariable(vars, "H", "1")).toThrow(/defines no variable "H".*L, W/);
    expect(() => overrideVariable([], "H", "1")).toThrow(/defines no variable/);
  });
});
