import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCadMeshInput } from "../app/main/cadMeshInput";
import { routeFile } from "../cad/src/fileRouter";
import { parseStl } from "../cad/src/stlParser";

const fixture = path.resolve("cad/examples/STL/cube.stl");
const compute = () => ({ bakeMeshEdits: vi.fn(), convertToStlBoundary: vi.fn(), convertFoamCaseToStlBoundary: vi.fn() });

describe("CAD mesh input", () => {
  it("uses displayed geometry without replay and scales it once", async () => {
    const c = compute();
    const raw = await fs.readFile(fixture);
    const result = await resolveCadMeshInput(fixture, routeFile(fixture)!, [], raw.toString("base64"), "m", c, []);
    expect(c.bakeMeshEdits).not.toHaveBeenCalled();
    expect(result?.kind).toBe("stl");
    if (!result || result.kind !== "stl") throw new Error("expected STL input");
    const before = parseStl(raw);
    const after = parseStl(result.stlBytes);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i] / 1000, 6);
  });

  it("replays supplied pending ops and reports a failed bake with raw fallback", async () => {
    const c = compute();
    c.bakeMeshEdits.mockRejectedValue(new Error("cannot replay"));
    const warnings: string[] = [];
    const ops = [{ op: "translate" as const, targets: ["node-0"], vec: [1, 0, 0] as [number, number, number] }];
    const result = await resolveCadMeshInput(fixture, routeFile(fixture)!, ops, undefined, "mm", c, warnings);
    expect(c.bakeMeshEdits).toHaveBeenCalledWith(expect.any(Uint8Array), "stl", ops, "stl", undefined);
    if (!result || result.kind !== "stl") throw new Error("expected STL input");
    expect(Buffer.from(result.stlBytes)).toEqual(await fs.readFile(fixture));
    expect(warnings.join(" ")).toContain("could NOT be baked (cannot replay)");
  });

  it("passes XDMF companions and preserves converter diagnostics when missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kkss-companions-"));
    try {
      const model = path.join(dir, "model.xdmf");
      await fs.writeFile(model, '<Xdmf><DataItem Format="HDF">data.h5:/mesh</DataItem></Xdmf>');
      await fs.writeFile(path.join(dir, "data.h5"), "companion");
      const c = compute();
      c.convertToStlBoundary.mockResolvedValue(await fs.readFile(fixture));
      await resolveCadMeshInput(model, routeFile(model)!, [], undefined, "mm", c, []);
      expect(c.convertToStlBoundary.mock.calls[0][3]).toEqual([{ name: "data.h5", bytes: new TextEncoder().encode("companion") }]);
      await fs.unlink(path.join(dir, "data.h5"));
      c.convertToStlBoundary.mockRejectedValue(new Error("HDF5: could not open file data.h5"));
      await expect(resolveCadMeshInput(model, routeFile(model)!, [], undefined, "mm", c, [])).rejects.toThrow("could not open file data.h5");
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
