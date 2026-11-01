import { describe, expect, it } from "vitest";
import { buildArchive, collectProjectReferences, packagedProject, planUnpack, readStoreZip, safeRelative } from "../app/main/services/workflows/projectArchive";

const enc = (s: string) => new TextEncoder().encode(s);
const ref = (path: string, kind = "project") => ({ kind, path, revision: "r" }) as any;
const project: any = { version: 1, id: "p", revision: 3, queue: { paused: false, tasks: [{ id: "t" }] }, activeRunId: "r1",
  studies: [{ id: "s", name: "n", source: ref("a.stp"), mesh: ref("/abs/m.mdpa", "external"), meshing: {}, caseSettings: null,
    runs: [{ id: "r1", artifacts: [{ role: "result", ownerId: "r1", reference: ref(".kkss/runs/r1/out.vtk") }] }] }] };

describe("project archive", () => {
  it("rejects unsafe names", () => {
    for (const bad of ["../x", "/x", "C:\\x", "a//b", "a/../b", ""]) expect(safeRelative(bad)).toBeUndefined();
    expect(safeRelative("a\\b.txt")).toBe("a/b.txt");
  });
  it("collects run references only on request", () => {
    expect(collectProjectReferences(project, false)).toHaveLength(2);
    expect(collectProjectReferences(project, true)).toHaveLength(3);
    const p = packagedProject(project, false);
    expect(p.studies[0].runs).toEqual([]); expect(p.queue).toEqual({ paused: true, tasks: [] });
    expect(project.studies[0].runs).toHaveLength(1);
  });
  it("round-trips and reports damaged, missing and conflicting files", () => {
    const zip = buildArchive(project, [{ path: "a.stp", data: enc("A") }, { path: "b.txt", data: enc("B") }], [{ owner: "s:mesh", path: "/abs/m.mdpa" }], false, "t");
    const plan = planUnpack(readStoreZip(zip), (rel) => rel === "b.txt");
    expect(plan.files.map((f) => f.path)).toEqual(["a.stp", "b.txt"]);
    expect(plan.conflicts).toEqual(["b.txt"]);
    expect(plan.manifest.external).toHaveLength(1);
    const members = readStoreZip(zip);
    members.set("files/a.stp", enc("tampered")); members.delete("files/b.txt");
    expect(planUnpack(members, () => false).problems).toEqual([{ path: "a.stp", problem: "damaged" }, { path: "b.txt", problem: "missing" }]);
  });
  it("refuses a manifest path that escapes", () => {
    const members = readStoreZip(buildArchive(project, [{ path: "a.stp", data: enc("A") }], [], false, "t"));
    const m = JSON.parse(new TextDecoder().decode(members.get("manifest.json")!)); m.files[0].path = "../evil";
    members.set("manifest.json", enc(JSON.stringify(m)));
    expect(planUnpack(members, () => false).problems[0].problem).toBe("unsafe");
  });
  it("rejects a corrupted zip body", () => {
    const zip = buildArchive(project, [{ path: "a.stp", data: enc("AAAA") }], [], false, "t");
    const i = Buffer.from(zip).indexOf("AAAA"); zip[i] = 66;
    expect(() => readStoreZip(zip)).toThrow(/damaged/);
  });
});
