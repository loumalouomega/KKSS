import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileRevision, staleQuantities } from "../app/main/services/workflows/project";

describe("staleQuantities", () => {
  it("reports changed and missing result sources only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sq-"));
    fs.writeFileSync(path.join(root, "a.vtk"), "one"); fs.writeFileSync(path.join(root, "b.vtk"), "two");
    const ra = await fileRevision(path.join(root, "a.vtk")), rb = await fileRevision(path.join(root, "b.vtk"));
    const q = (file: string, revision: string, field: string) => ({ field, kind: "Nodal", component: "x", region: "r", time: 1, reduction: "max", unit: "m", value: 1, runId: "r1", source: { kind: "project", path: file, revision } });
    const study: any = { runs: [{ id: "r1", evidence: { quantities: [q("a.vtk", ra, "A"), q("b.vtk", rb, "B"), q("gone.vtk", "zz", "C")] } }] };
    fs.writeFileSync(path.join(root, "b.vtk"), "changed");
    const out = await staleQuantities(root, study);
    expect(out.map((o) => [o.field, o.reason])).toEqual([["B", "changed"], ["C", "missing"]]);
    expect(await staleQuantities(root, { runs: [] } as any)).toEqual([]);
  });
});
