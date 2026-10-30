import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "out", "cad-runtime");
const server = path.join(runtime, "dist", "mcp-server.js");

// CI builds first. Exercise the shipped worker: importing source would find
// cad/node_modules and hide the missing-runtime-package regression.
describe.skipIf(!fs.existsSync(server))("bundled CAD MCP runtime", () => {
  it("executes OCCT and meshio calls through its forked worker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-cad-mcp-"));
    const client = new Client({ name: "runtime-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, CAD_PREVIEW_ROOT: runtime } as Record<string, string>,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const model = path.join(dir, "block.stp");
      fs.copyFileSync(path.join(root, "cad/examples/STP/block.stp"), model);
      const mass = await client.callTool({ name: "get_mass_properties", arguments: { path: model } });
      expect(mass.isError, JSON.stringify(mass.content)).not.toBe(true);
      const text = (mass.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")!.text!;
      expect(JSON.parse(text).volume).toBeCloseTo(60, 5);

      // cad 3.28.0's Draft panel/tool seam: the real kernel path through the
      // forked MCP worker, not a stub. The block's vertical walls have no draft.
      const draft = await client.callTool({ name: "check_draft", arguments: { path: model, pull: "+Z", minDraftDeg: 1 } });
      expect(draft.isError, JSON.stringify(draft.content)).not.toBe(true);
      const draftText = (draft.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")!.text!;
      const draftFacts = JSON.parse(draftText);
      expect(draftFacts.supported).toBe(true);
      expect(draftFacts.pull).toEqual([0, 0, 1]);
      expect(draftFacts.faceCount).toBeGreaterThan(0);
      expect(draftFacts.counts.zeroDraft).toBeGreaterThan(0);

      // cad 3.30.0's kernel-free B-rep -> surface mesh, through the staged
      // full meshio++ artifact: block.stp closes with no open edges.
      const surface = path.join(dir, "block-surface.stl");
      const cadSurface = await client.callTool({
        name: "mesh_cad_surface",
        arguments: { path: model, outputPath: surface, targetSize: 0.5 },
      });
      expect(cadSurface.isError, JSON.stringify(cadSurface.content)).not.toBe(true);
      expect(fs.existsSync(surface)).toBe(true);

      // cad 3.32.0 (meshio++ 17.23): the three new tools through the staged
      // kernel worker. A .vtu surface keeps the cad:face data project_to_cad
      // needs; an unperturbed mesh_cad_surface output barely moves.
      const faceMesh = path.join(dir, "block-faces.vtu");
      const faces = await client.callTool({ name: "mesh_cad_surface", arguments: { path: model, outputPath: faceMesh, targetSize: 0.5 } });
      expect(faces.isError, JSON.stringify(faces.content)).not.toBe(true);
      const projectedPath = path.join(dir, "block-projected.vtu");
      const projected = await client.callTool({ name: "project_to_cad", arguments: { path: faceMesh, cadPath: model, outputPath: projectedPath } });
      expect(projected.isError, JSON.stringify(projected.content)).not.toBe(true);
      const projectedFacts = JSON.parse((projected.content as Array<{ text?: string }>).find(c => c.text)!.text!);
      expect(projectedFacts.numProjected).toBeGreaterThan(0);
      expect(fs.existsSync(projectedPath)).toBe(true);
      const layersPath = path.join(dir, "block-layers.vtu");
      const layers = await client.callTool({
        name: "grow_prism_layers",
        arguments: { path: model, outputPath: layersPath, targetSize: 1, firstHeight: 0.05, numLayers: 3 },
      });
      expect(layers.isError, JSON.stringify(layers.content)).not.toBe(true);
      expect(fs.existsSync(layersPath)).toBe(true);
      const conformity = await client.callTool({ name: "check_mesh_conformity", arguments: { path: faceMesh } });
      expect(conformity.isError, JSON.stringify(conformity.content)).not.toBe(true);

      const mesh = path.join(dir, "model.mdpa");
      fs.writeFileSync(mesh, "Begin Nodes\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\nEnd Nodes\nBegin Elements Element3D4N\n1 0 1 2 3 4\nEnd Elements\n");
      const loaded = await client.callTool({ name: "load_model", arguments: { path: mesh } });
      expect(loaded.isError, JSON.stringify(loaded.content)).not.toBe(true);
      const generated = await client.callTool({ name: "generate_mesh", arguments: { path: mesh, options: { sizeMax: 0.5 } } });
      expect(generated.isError, JSON.stringify(generated.content)).not.toBe(true);
      const payload = JSON.parse((generated.content as Array<{ text?: string }>).find(c => c.text)!.text!);
      expect(payload.nodeCount).toBeGreaterThanOrEqual(4);
      expect(payload.elementCount).toBeGreaterThan(0);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
