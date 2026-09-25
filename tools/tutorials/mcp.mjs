import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const python = process.env.KKSS_TUTORIAL_PYTHON ?? path.join(root, 'node_modules/.cache/kkss-tier4/runtime/bin/python');
const stdioBridge = path.join(root, 'tools/tutorials/mcp-stdio-bridge.py');

export async function servers() {
  const clients = {};
  try {
    for (const [name, script] of Object.entries({ cad: 'out/cad-runtime/dist/mcp-server.js', mesh: 'out/mcpServer.js' })) {
      const client = new Client({ name: 'kkss-tutorials', version: '1.0.0' });
      clients[name] = client;
      // The CAD WASM bundle can consume or close Node's fd 0 while it starts.
      // Keep each MCP child behind a tiny stdio-only Python pipe bridge so
      // the server sees a normal long-lived pipe. Python's standard library
      // is already required by the tutorials; no package or app API is added.
      await client.connect(new StdioClientTransport({ command: python, args: ['-u', stdioBridge, process.execPath, path.join(root, script)],
        env: { ...process.env, CAD_PREVIEW_ROOT: path.join(root, 'out/cad-runtime') }, stderr: 'pipe' }));
    }
  } catch (error) { await Promise.all(Object.values(clients).map(c => c.close())); throw error; }
  return {
    async call(name, args) {
      const [server, tool] = name.split('__');
      const result = await clients[server].callTool({ name: tool, arguments: args }, undefined, { timeout: 240_000 });
      const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (result.isError) throw new Error(`${name}: ${text}`);
      return result.structuredContent ?? JSON.parse(text);
    },
    async close() { await Promise.all(Object.values(clients).map(c => c.close())); },
  };
}
