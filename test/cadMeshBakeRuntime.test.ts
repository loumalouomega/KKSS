import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseStl } from "../cad/src/stlParser";
import type { CoarsenStlResult } from "../cad/src/mmgCoarsen";

const root = path.resolve(__dirname, "..");
const fixture = path.join(root, "cad/examples/STL/cube.stl");
const workerPath = path.join(root, "out/cadCompute.worker.js");

describe.skipIf(!fs.existsSync(workerPath))("bundled KKSS CAD mesh replay", () => {
  it("translates STL geometry through the built compute worker dispatcher", async () => {
    const input = new Uint8Array(fs.readFileSync(fixture));
    const before = parseStl(input);
    const worker = new Worker(workerPath);
    try {
      const reply = once(worker, "message");
      worker.postMessage({ id: 1, method: "bakeMeshEdits", args: [input, "stl", [
        { op: "translate", targets: ["node-0"], vec: [25, 0, 0] },
      ], "stl"] });
      const [message] = await reply as [{ id: number; ok: boolean; value?: { bytes: Uint8Array; outcomes: Array<{ applied: boolean }> }; error?: string }];
      expect(message.id).toBe(1);
      expect(message.ok, message.error).toBe(true);
      const result = message.value!;
      const after = parseStl(result.bytes);
      expect(result.outcomes).toEqual([expect.objectContaining({ applied: true })]);
      expect(Math.min(...Array.from({ length: before.length / 3 }, (_, i) => before[i * 3]))).toBeCloseTo(
        Math.min(...Array.from({ length: after.length / 3 }, (_, i) => after[i * 3])) - 25, 4,
      );
    } finally { await worker.terminate(); }
  }, 60_000);

  it("coarsens a 100k-triangle STL through the built compute worker (cad 3.22.0's mmgs heal path)", async () => {
    // The auto-decimate opt-in on check_mesh_health / the CAD Mesh Health panel
    // routes through coarsenStlBoundary, which cad 3.22.0 moved off meshio++
    // quadric `decimate` onto a Hausdorff-bisected mmgs run. That is an MMG
    // call, so it can only run in this worker — and the worker's own dispatcher
    // must carry the new name.
    const input = new Uint8Array(fs.readFileSync(path.join(root, "cad/examples/STL/large-sphere-100k.stl")));
    const runtime = path.join(root, "out", "cad-runtime");
    const worker = new Worker(workerPath);
    try {
      const reply = once(worker, "message");
      worker.postMessage({ id: 1, method: "coarsenStlBoundary", args: [runtime, input, 1000] });
      const [message] = await reply as [{ id: number; ok: boolean; value?: CoarsenStlResult; error?: string }];
      expect(message.id).toBe(1);
      expect(message.ok, message.error).toBe(true);
      const result = message.value!;
      expect(result.method).toBe("mmgs");
      expect(result.fromTriangles).toBeGreaterThan(50_000); // over the healer's ceiling: the reason the opt-in exists
      expect(result.toTriangles).toBeLessThanOrEqual(1000);
      expect(result.toTriangles).toBeGreaterThanOrEqual(700); // the 0.7 accept fraction
      expect(result.iterations).toBeGreaterThan(0);
      // A closed sphere coarsens near its own volume; the probe's number.
      expect(Math.abs(result.volumeDeltaPct ?? 100)).toBeLessThan(5);
      expect(parseStl(result.bytes).length / 9).toBe(result.toTriangles);
    } finally { await worker.terminate(); }
  }, 180_000);
});
