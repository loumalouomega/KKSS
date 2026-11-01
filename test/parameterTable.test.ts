import { describe, expect, it } from "vitest";
import { parameterPlotSvg, parameterTables } from "../app/main/services/workflows/parameterTable";
import { comparisonHtml, type VariantComparison } from "../app/main/services/workflows/comparison";

const definition = { field: "TEMPERATURE", kind: "Nodal", component: "scalar", region: "Fluid", time: 1, reduction: "max" };
function comparison(over: Partial<VariantComparison> = {}): VariantComparison {
  const row = (studyId: string, name: string) => ({ studyId, name, settings: null, state: "succeeded", variation: "solver-parameter" as const, convergence: "unavailable" as const });
  return {
    version: 2, parentStudyId: "p", parentName: "Base", classification: "solver-parameter",
    rows: [row("p", "Base"), row("a", "a"), row("b", "b"), row("c", "c")],
    differences: [
      { studyId: "a", changes: [{ path: "values.k", baseline: 1, value: 2, baselinePresent: true, valuePresent: true }] },
      { studyId: "b", changes: [{ path: "values.k", baseline: 1, value: 3, baselinePresent: true, valuePresent: true }, { path: "values.mode", baseline: "x", value: "y", baselinePresent: true, valuePresent: true }] },
      { studyId: "c", changes: [{ path: "values.k", baseline: 1, value: 4, baselinePresent: true, valuePresent: true }] },
    ],
    quantities: [{ definition, compatible: true, unit: "K", values: [{ studyId: "p", value: 10 }, { studyId: "a", value: 20 }, { studyId: "b", value: null }, { studyId: "c", value: 40 }] }],
    findings: [], ...over,
  };
}

describe("parameterTables", () => {
  const tables = parameterTables(comparison(), [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "p" }]);
  it("has one column per differing path and keeps missing as null, never zero", () => {
    const [table] = tables;
    expect(table.parameters).toEqual(["values.k", "values.mode"]);
    expect(table.rows.find(r => r.studyId === "a")!.parameters).toEqual({ "values.k": 2, "values.mode": null });
    expect(table.rows.find(r => r.studyId === "b")!.value).toBeNull();
    expect(table.rows.find(r => r.studyId === "p")!.parameters["values.k"]).toBeNull();
    expect(table.findings.join()).toMatch(/1 row have no saved value|1 row/);
  });
  it("picks the first fully numeric axis", () => expect(tables[0].numericAxis).toBe("values.k"));
  it("adds geometry variables as numeric columns when they parse", () => {
    const [t] = parameterTables(comparison({ differences: [] }), [{ id: "a", geometry: { baseSource: { kind: "project", path: "x", revision: "r" }, variables: { L: "20", W: "2*L" } } }, { id: "b", geometry: { baseSource: { kind: "project", path: "x", revision: "r" }, variables: { L: "30", W: "3*L" } } }]);
    expect(t.parameters).toEqual(["geometry.L", "geometry.W"]);
    expect(t.rows.find(r => r.studyId === "b")!.parameters["geometry.L"]).toBe(30);
    expect(t.rows.find(r => r.studyId === "b")!.parameters["geometry.W"]).toBe("3*L");
    expect(t.numericAxis).toBe("geometry.L");
  });
  it("skips incompatible units and reports a table with no axis when nothing is numeric", () => {
    expect(parameterTables(comparison({ quantities: [{ definition, compatible: false, values: [] }] }), [])).toEqual([]);
    const text = comparison({ differences: [{ studyId: "a", changes: [{ path: "values.mode", baseline: "x", value: "y", baselinePresent: true, valuePresent: true }] }] });
    expect(parameterTables(text, [])[0].numericAxis).toBeUndefined();
  });
});

describe("export", () => {
  it("draws an escaped SVG only with a numeric axis and lists missing rows", () => {
    const withTables = comparison(); withTables.parameterTables = parameterTables(withTables, []);
    const html = comparisonHtml(withTables);
    expect(html).toContain("<svg");
    expect(html).toContain("2 rows are not drawn (no value for this quantity, or no value for values.k)");
    expect(html).not.toMatch(/<script(?![^>]*application\/json)/);
    const none = comparison({ differences: [{ studyId: "a", changes: [{ path: "values.mode", baseline: "x", value: "<b>y</b>", baselinePresent: true, valuePresent: true }] }] });
    none.parameterTables = parameterTables(none, []);
    const noSvg = comparisonHtml(none);
    expect(noSvg).not.toContain("<svg");
    expect(noSvg).toContain("&lt;b&gt;y&lt;/b&gt;");
    expect(parameterPlotSvg({ ...none.parameterTables[0], numericAxis: undefined })).toBe("");
  });
});
