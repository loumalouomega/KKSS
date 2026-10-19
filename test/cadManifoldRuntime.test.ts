import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "out", "cad-runtime");
const server = path.join(runtime, "dist", "mcp-server.js");

/**
 * A closed binary STL of a cube (±s on every axis), outward-wound. Small
 * enough to read at a glance: six quads, two triangles each, per-face normals.
 */
function boxStl(s: number): Buffer {
  const v: Array<[number, number, number]> = [
    [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
    [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
  ];
  // CCW seen from outside, so every face normal points away from the centre.
  const quads: Array<[number, number, number, number]> = [
    [4, 5, 6, 7], // +z
    [1, 0, 3, 2], // -z
    [5, 1, 2, 6], // +x
    [0, 4, 7, 3], // -x
    [7, 6, 2, 3], // +y
    [0, 1, 5, 4], // -y
  ];
  const tris: Array<[number, number, number]> = [];
  for (const [a, b, c, d] of quads) tris.push([a, b, c], [a, c, d]);
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((tri, i) => {
    const [p, q, r] = tri.map((n) => v[n]) as Array<[number, number, number]>;
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
    const wx = r[0] - p[0], wy = r[1] - p[1], wz = r[2] - p[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    let off = 84 + i * 50;
    for (const n of [nx / len, ny / len, nz / len, ...p, ...q, ...r]) {
      buf.writeFloatLE(n, off);
      off += 4;
    }
  });
  return buf;
}

/** Triangle count from an STL header (binary STL only). */
function stlTriangleCount(bytes: Buffer): number {
  return bytes.length >= 84 ? Math.round((bytes.length - 84) / 50) : 0;
}

/**
 * Signed volume through the divergence theorem, summed over the STL's
 * triangles. A closed outward-wound solid gives its true volume; the sign
 * flips for an inside-out one. Edges are counted by rounded vertex key, so a
 * closed manifold has none used once.
 */
function stlStats(bytes: Buffer): { volume: number; freeEdges: number } {
  const edges = new Map<string, number>();
  let volume = 0;
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  for (let i = 0; i < stlTriangleCount(bytes); i++) {
    const off = 84 + i * 50 + 12;
    const pts: Array<[number, number, number]> = [];
    for (let j = 0; j < 3; j++) {
      const b = off + j * 12;
      pts.push([bytes.readFloatLE(b), bytes.readFloatLE(b + 4), bytes.readFloatLE(b + 8)]);
    }
    const [p, q, r] = pts;
    volume += (p[0] * (q[1] * r[2] - q[2] * r[1]) + p[1] * (q[2] * r[0] - q[0] * r[2]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    for (const [a, b] of [[p, q], [q, r], [r, p]] as Array<[[number, number, number], [number, number, number]]>) {
      const k = [key(...a), key(...b)].sort().join("|");
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let freeEdges = 0;
  for (const count of edges.values()) if (count !== 2) freeEdges++;
  return { volume, freeEdges };
}

// The probe works on the SHIPPED tree (out/), like cadMcpRuntime.test.ts: the
// manifold WASM is staged by the parent build into out/cad-runtime/dist/manifold
// and the kernel worker reads it from beside its own bundle, so importing
// cad's source would find cad/node_modules and hide a missing staging step.
describe.skipIf(!fs.existsSync(server))("bundled CAD manifold runtime", () => {
  it("bakes a mesh hole through manifold, not the approximate CSG fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-cad-manifold-"));
    const client = new Client({ name: "manifold-runtime-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, CAD_PREVIEW_ROOT: runtime } as Record<string, string>,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const model = path.join(dir, "cube.stl");
      fs.writeFileSync(model, boxStl(10));
      // A pending edit op, exactly the sidecar the viewer would persist: drill
      // a Ø6 through-hole down the cube's +Z face. `save_model` replays it
      // headlessly through the kernel worker's bakeMeshEdits.
      fs.writeFileSync(
        `${model}.edits.json`,
        JSON.stringify({
          ops: [
            { op: "addHole", targets: ["node-0"], position: [0, 0, 10], axis: [0, 0, -1], radius: 3, depth: 24 },
          ],
        })
      );
      const saved = await client.callTool({ name: "save_model", arguments: { path: model } });
      expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true);
      const payload = JSON.parse(
        (saved.content as Array<{ text?: string }>).find((c) => c.text)!.text!
      ) as { baked: number; warnings: string[] };
      expect(payload.baked).toBe(1);
      // The approximate three-bvh-csg path reports itself in the warnings — its
      // output "may not be closed". Zero mentions means manifold took the job.
      expect(payload.warnings.filter((w) => /manifold/i.test(w))).toEqual([]);

      const written = fs.readFileSync(model);
      const { volume, freeEdges } = stlStats(written);
      // 20³ mm cube minus a Ø6 through-hole: 8000 - π·3²·20 ≈ 7434 mm³, and
      // the tool cylinder's 32 segments are inscribed, so the hole is a touch
      // smaller and the solid a touch larger (≈ 7438).
      expect(volume).toBeGreaterThan(7400);
      expect(volume).toBeLessThan(7460);
      // The load-bearing difference: manifold's result is a closed solid.
      expect(freeEdges).toBe(0);
      expect(stlTriangleCount(written)).toBeGreaterThan(12);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
