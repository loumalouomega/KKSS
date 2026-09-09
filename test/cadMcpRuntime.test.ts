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

      const mesh = path.join(dir, "model.mdpa");
      fs.copyFileSync(path.join(root, "mesh/example/MDPA/double_arch.mdpa"), mesh);
      const loaded = await client.callTool({ name: "load_model", arguments: { path: mesh } });
      expect(loaded.isError, JSON.stringify(loaded.content)).not.toBe(true);
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
