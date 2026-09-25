import { describe, expect, it } from "vitest";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseStl } from "../cad/src/stlParser";

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
});
