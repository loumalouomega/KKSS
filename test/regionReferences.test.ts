import { describe, expect, it } from "vitest";
import { applyRenames, carryOverReport, collectReferences, listMdpaRegions, parseRenames, renamePath } from "../app/main/services/workflows/regionReferences";

const settings = {
  assignments: [{ conditionId: "fixed", smpPath: "Structure/Fixed", values: {} }, { conditionId: "load", smpPath: "Structure/Load", values: {} }],
  materials: [{ smpPath: "Structure", lawId: "steel", values: {} }],
  collections: { sensors: [{ name: "s1", type: "t", parts: ["Structure/Load", "Probe"], values: {} }] },
};

describe("collectReferences", () => {
  it("finds assignments, materials and collection parts", () => {
    const refs = collectReferences(settings);
    expect(refs.map(r => `${r.owner}:${r.path}`)).toEqual([
      "assignment:Structure/Fixed", "assignment:Structure/Load", "material:Structure", "collection:Structure/Load", "collection:Probe",
    ]);
    expect(refs[4].label).toBe("sensors/s1");
  });
  it("tolerates null, empty and malformed settings", () => {
    expect(collectReferences(null)).toEqual([]);
    expect(collectReferences({ assignments: [null, { smpPath: 3 }, { smpPath: "" }], collections: { a: "x" } })).toEqual([]);
  });
});

describe("listMdpaRegions", () => {
  it("returns nested slash paths and ignores bodies", () => {
    const text = "Begin Nodes\n1 0 0 0\nEnd Nodes\nBegin SubModelPart Structure\n  Begin SubModelPartNodes\n 1\n  End SubModelPartNodes\n  Begin SubModelPart Fixed\n  End SubModelPart\nEnd SubModelPart\r\nBegin SubModelPart Other\nEnd SubModelPart\n";
    expect(listMdpaRegions(text)).toEqual(["Structure", "Structure/Fixed", "Other"]);
  });
});

describe("carryOverReport", () => {
  const refs = collectReferences(settings);
  it("marks kept and lost, lists new regions, and suggests a unique rename by name only", () => {
    const report = carryOverReport(refs, ["Structure", "Structure/Fixed", "Structure/load", "Extra"]);
    expect(report).toMatchObject({ available: true, basis: "name-only", lost: 2 });
    const byPath = Object.fromEntries(report.regions.map(r => [r.path, r]));
    expect(byPath["Structure/Fixed"].status).toBe("kept");
    expect(byPath["Structure/Load"]).toMatchObject({ status: "lost", possibleRename: "Structure/load" });
    expect(byPath["Probe"].status).toBe("lost");
    expect(byPath["Probe"].possibleRename).toBeUndefined();
    expect(report.newRegions).toEqual(["Structure/load", "Extra"]);
    expect(byPath["Structure/Load"].references.map(r => r.owner)).toEqual(["assignment", "collection"]);
  });
  it("does not offer one new region as the rename of two lost ones", () => {
    const report = carryOverReport(collectReferences({ assignments: [{ conditionId: "a", smpPath: "A/Wall" }, { conditionId: "b", smpPath: "B/Wall" }] }), ["C/Wall"]);
    expect(report.regions.filter(r => r.possibleRename).length).toBe(1);
  });
  it("claims nothing when the mesh has no region listing", () => {
    expect(carryOverReport(refs, undefined, "no listing")).toMatchObject({ available: false, unavailableReason: "no listing", regions: [], lost: 0 });
  });
});

describe("renames", () => {
  it("moves a path and its children, only on a path boundary", () => {
    expect(renamePath("A", "A", "X")).toBe("X");
    expect(renamePath("A/B", "A", "X")).toBe("X/B");
    expect(renamePath("AB", "A", "X")).toBe("AB");
  });
  it("applies to a copy and counts changes", () => {
    const before = JSON.stringify(settings);
    const { settings: next, changed } = applyRenames(settings, [{ from: "Structure", to: "Body" }]);
    expect(JSON.stringify(settings)).toBe(before);
    expect(changed).toBe(5 - 1); // Probe is untouched
    expect(collectReferences(next).map(r => r.path)).toEqual(["Body/Fixed", "Body/Load", "Body", "Body/Load", "Probe"]);
  });
  it("validates the request", () => {
    expect(() => parseRenames([])).toThrow();
    expect(() => parseRenames([{ from: "a", to: "a" }])).toThrow();
    expect(() => parseRenames([{ from: "a", to: "b c" }])).toThrow();
    expect(() => parseRenames([{ from: "a", to: "/b" }])).toThrow();
    expect(() => parseRenames([{ from: "a", to: "b" }, { from: "a", to: "c" }])).toThrow();
    expect(parseRenames([{ from: "a", to: "b/c" }])).toEqual([{ from: "a", to: "b/c" }]);
  });
});
