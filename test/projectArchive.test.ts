import { describe, expect, it } from "vitest";
import { deflateSync } from "fflate";
import { referencesForRole, relinkPlan, buildArchive, collectProjectReferences, packagedProject, planUnpack, readStoreZip, readZip, safeRelative, unresolvedExternal } from "../app/main/services/workflows/projectArchive";

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

  // Minimal zip writer with deflate members for third-party-archive cases.
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (d: Uint8Array) => { let c = 0xffffffff; for (const b of d) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(members: { name: string; data: Uint8Array; declared?: number }[]): Uint8Array {
    const parts: Uint8Array[] = [], central: Uint8Array[] = []; let off = 0;
    for (const m of members) {
      const name = enc(m.name), body = deflateSync(m.data), size = m.declared ?? m.data.length;
      const l = new DataView(new ArrayBuffer(30)); l.setUint32(0, 0x04034b50, true); l.setUint16(8, 8, true); l.setUint32(14, crc(m.data), true); l.setUint32(18, body.length, true); l.setUint32(22, size, true); l.setUint16(26, name.length, true);
      const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(10, 8, true); c.setUint32(16, crc(m.data), true); c.setUint32(20, body.length, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      parts.push(new Uint8Array(l.buffer), name, body); central.push(new Uint8Array(c.buffer), name); off += 30 + name.length + body.length;
    }
    const cd = central.reduce((n, p) => n + p.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, members.length, true); e.setUint16(10, members.length, true); e.setUint32(12, cd, true); e.setUint32(16, off, true);
    return Buffer.concat([...parts, ...central, new Uint8Array(e.buffer)]);
  }
  const manifestFor = (files: { path: string; data: Uint8Array }[]) => enc(JSON.stringify({ version: 1, projectId: "p", generated: "t", includesRuns: false, external: [],
    files: files.map((f) => ({ path: f.path, sha256: require("node:crypto").createHash("sha256").update(f.data).digest("hex"), bytes: f.data.length })) }));

  it("reads deflate members and plans them", () => {
    const a = enc("A".repeat(5000));
    const z = zip([{ name: "manifest.json", data: manifestFor([{ path: "a.txt", data: a }]) }, { name: "files/a.txt", data: a }]);
    const plan = planUnpack(readZip(z).members, () => false);
    expect(plan.files[0].data).toEqual(a); expect(plan.problems).toEqual([]);
  });
  it("lists a hash mismatch in a compressed member as damaged", () => {
    const a = enc("hello");
    const z = zip([{ name: "manifest.json", data: manifestFor([{ path: "a.txt", data: enc("other") }]) }, { name: "files/a.txt", data: a }]);
    expect(planUnpack(readZip(z).members, () => false).problems).toEqual([{ path: "a.txt", problem: "damaged" }]);
  });
  it("refuses a decompression bomb before and during inflate", () => {
    const big = new Uint8Array(1_000_000);
    const honest = zip([{ name: "files/b.bin", data: big }]);
    expect(() => readZip(honest, { maxMembers: 10, maxTotalBytes: 100_000 })).toThrow(/size limit/);
    const lying = zip([{ name: "files/b.bin", data: big, declared: 10 }]);
    expect(() => readZip(lying)).toThrow(/damaged/);
    expect(() => readZip(honest, { maxMembers: 0, maxTotalBytes: 1e9 })).toThrow(/more than/);
  });
  it("never extracts a traversal member name", () => {
    const z = zip([{ name: "files/../evil", data: enc("x") }, { name: "/abs", data: enc("x") }, { name: "files/ok.txt", data: enc("ok") }]);
    const r = readZip(z);
    expect([...r.members.keys()]).toEqual(["files/ok.txt"]); expect(r.unsafeMembers).toEqual(["files/../evil", "/abs"]);
  });
  it("offers a replacement once per study for sources and a relocation for every other role", () => {
    const u: any[] = [
      { path: "/gone/a.stp", owner: "s1:source", studyId: "s1", role: "source", relink: "app__study_relink_source" },
      { path: "/gone/b.stp", owner: "s1:source", studyId: "s1", role: "source", relink: "app__study_relink_source" },
      { path: "/gone/m.mdpa", owner: "s1:mesh", studyId: "s1", role: "mesh", relink: "app__study_relink_reference" },
      { path: "/gone/c.stp", owner: "s2:source", studyId: "s2", role: "source", relink: "app__study_relink_source" }];
    const r = relinkPlan(u);
    expect(r.relinkable.map((x) => x.studyId)).toEqual(["s1", "s2"]);
    expect(r.relocatable.map((x) => x.role)).toEqual(["mesh"]);
    expect(relinkPlan([])).toEqual({ relinkable: [], relocatable: [] });
  });
  it("finds the live references a role names", () => {
    const ref = (p: string) => ({ kind: "external", path: p, revision: "a".repeat(64) });
    const study: any = { id: "s", mesh: ref("/m"), geometry: { baseSource: ref("/b") }, handoff: { artifacts: [{ role: "mesh", reference: ref("/h1") }, { role: "x", reference: ref("/h2") }] },
      runs: [{ id: "r1", artifacts: [{ role: "result", reference: ref("/o1") }, { role: "log", reference: ref("/l") }] }] };
    expect(referencesForRole(study, "mesh")[0]).toBe(study.mesh);
    expect(referencesForRole(study, "baseSource")[0]).toBe(study.geometry.baseSource);
    expect(referencesForRole(study, "handoff").map((x) => x.path)).toEqual(["/h1", "/h2"]);
    expect(referencesForRole(study, "r1:result")[0]).toBe(study.runs[0].artifacts[0].reference);
    expect(referencesForRole(study, "source")).toEqual([]);
    expect(referencesForRole(study, "r2:result")).toEqual([]);
    expect(referencesForRole(study, "nope")).toEqual([]);
  });
  it("lists unresolved external references by study and role", () => {
    const m: any = { external: [{ owner: "s1:source", path: "/gone/a.stp" }, { owner: "s1:mesh", path: "/here/m.mdpa" }, { owner: "s2:r1:result", path: "/gone/o.vtk" }] };
    expect(unresolvedExternal(m, (p) => p === "/here/m.mdpa")).toEqual([
      { path: "/gone/a.stp", owner: "s1:source", studyId: "s1", role: "source", relink: "app__study_relink_source" },
      { path: "/gone/o.vtk", owner: "s2:r1:result", studyId: "s2", role: "r1:result", relink: "app__study_relink_reference" }]);
  });
});
