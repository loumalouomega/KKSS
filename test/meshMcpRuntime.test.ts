import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { parseMdpa } from '../mesh/src/parser/mdpaParser';
import type { MmgWorkResponse } from '../mesh/src/mmgWorkerClient';
import type { StreamlineWorkResponse } from '../mesh/src/streamlineWorker';
import { TOOL_ACCESS } from '../app/main/services/chat/toolPolicy';

const root = path.resolve(__dirname, '..');
const server = path.join(root, 'out/mcpServer.js');
const fixture = `Begin Properties 1
DENSITY 1000
End Properties
Begin Properties 2
DENSITY 2000
End Properties
Begin Nodes
1 0 0 0
2 1 0 0
3 1 1 0
4 0 1 0
End Nodes
Begin Elements Element2D3N
1 1 1 2 3
2 2 1 3 4
End Elements
Begin NodalData T
1 0 0
2 0 1
3 0 3
4 0 2
End NodalData
`;

it.skipIf(!fs.existsSync(server))('bundled mesh MCP preserves selection, edits and sampled fields through export/reopen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-mesh-mcp-'));
  const client = new Client({ name: 'mesh-runtime-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: dir, stderr: 'pipe' });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return JSON.parse((result.content as Array<{ text?: string }>).find(c => c.text)!.text!);
  };
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => `mesh__${t.name}`).sort()).toEqual(Object.keys(TOOL_ACCESS).filter(n => n.startsWith('mesh__')).sort());
    expect(tools.find(t => t.name === 'mesh_flow_balance')?.inputSchema.properties).toHaveProperty('pressureDensity');
    expect(tools.find(t => t.name === 'mesh_pack_series')?.inputSchema.properties).toHaveProperty('provenance');
    const source = path.join(dir, 'square.mdpa');
    fs.writeFileSync(source, fixture);
    const capabilities = await call('mesh_capabilities');
    expect(JSON.stringify(capabilities)).toContain('vtk');
    expect(capabilities.exportFidelity.version).toBe(2);
    const selection = await call('mesh_select', { path: source, seed: { kind: 'property', propertyId: 2 } });
    expect(selection.elementIds).toEqual([2]);
    expect(selection.conditionIds).toEqual([]);
    const probeArgs = { points: [[0.1, 0.1, 0], [0.9, 0.9, 0]], variable: 'T', samples: 5 };
    const assertProbe = (probe: { covered: number; rows: Array<{ position: number[]; values: number[] }> }) => {
      expect(probe.covered).toBe(5);
      for (const row of probe.rows) expect(row.values[0]).toBeCloseTo(row.position[0] + 2 * row.position[1], 5);
    };
    assertProbe(await call('mesh_probe', { path: source, ...probeArgs }));
    const converted = path.join(dir, 'square.vtu');
    await call('mesh_convert', { path: source, outputPath: converted });
    assertProbe(await call('mesh_probe', { path: converted, ...probeArgs }));
    const edited = path.join(dir, 'edited.mdpa');
    const transformed = await call('mesh_transform', { path: source, outputPath: edited, provenance: 'sidecar', verify: true, ops: [
      { op: 'setProperty', propertyId: 1, name: 'DENSITY', value: 2700 },
      { op: 'createSubModelPartFromSelection', name: 'Kept', parentPath: '', elements: [1] },
      { op: 'deleteEntities', elements: [2] },
    ] });
    expect(transformed.report.provenance.embedded).toBe(true);
    expect(transformed.report.unexpected).toEqual([]);
    // The sidecar captures the write; verify:true adds read-back evidence to
    // the returned report after publication, without rewriting that record.
    const sidecar = JSON.parse(fs.readFileSync(edited + '.kratosexport.json', 'utf8'));
    expect(sidecar.provenance).toEqual(transformed.report.provenance);
    expect(sidecar.operations).toEqual(transformed.report.operations);
    expect(sidecar.categories).toEqual(transformed.report.categories.map(({ verified: _verified, ...category }: { verified?: boolean }) => category));
    expect(transformed.report.categories.every((c: { verified?: boolean }) => c.verified === true)).toBe(true);
    const text = fs.readFileSync(edited, 'utf8');
    expect(text).toMatch(/DENSITY\s+2700/);
    expect(text).toMatch(/Begin SubModelPart Kept/);
    expect(text).toMatch(/1\s+1\s+1\s+2\s+3/);
    expect(text).not.toMatch(/2\s+2\s+1\s+3\s+4/);
    expect((await call('mesh_select', { path: edited, seed: { kind: 'part', path: 'Kept' } })).elementIds).toEqual([1]);
    assertProbe(await call('mesh_probe', { path: edited, ...probeArgs }));
    expect(fs.readFileSync(source, 'utf8')).toBe(fixture);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(!fs.existsSync(server))('bundled streamline worker traces, streams progress and retains partial cancellation', async () => {
  const workerPath = path.join(root, 'out/streamlineWorker.js');
  expect(fs.existsSync(workerPath)).toBe(true);
  const model = parseMdpa(fixture + `Begin NodalData V\n1 0 (1,0,0)\n2 0 (1,0,0)\n3 0 (1,0,0)\n4 0 (1,0,0)\nEnd NodalData\n`);
  for (const cancel of [false, true]) {
    const worker = new Worker(workerPath);
    const progress: number[] = [];
    try {
      const response = new Promise<StreamlineWorkResponse>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('exit', code => reject(new Error(`Streamline worker exited before replying: ${code}`)));
        worker.on('message', (message: StreamlineWorkResponse) => {
          if (message.type === 'progress') {
            progress.push(message.done);
            if (cancel && message.done === 1) worker.postMessage({ type: 'cancel' });
          } else resolve(message);
        });
      });
      const count = cancel ? 2000 : 4;
      worker.postMessage({ type: 'trace', model, params: { variable: 'V', seeds: { kind: 'line', from: [0.1, 0.1, 0], to: [0.1, 0.9, 0], count }, stepFraction: cancel ? 0.001 : 0.25, maxSeeds: 5000 } });
      const message = await response;
      expect(message.type, JSON.stringify(message)).toBe('done');
      if (message.type !== 'done') throw new Error('Trace failed');
      expect(message.result.cancelled).toBe(cancel);
      expect(progress.length).toBeGreaterThan(0);
      expect(message.result.lines.length).toBeGreaterThan(0);
      expect(message.result.lines[0].points).toBeInstanceOf(Float64Array);
      if (cancel) expect(message.result.lines.length).toBeLessThan(count);
      else { expect(message.result.lines).toHaveLength(count); expect(progress[progress.length - 1]).toBe(count); }
    } finally { await worker.terminate(); }
  }
}, 60_000);


it.skipIf(!fs.existsSync(path.join(root, 'out/mmgWorker.js')))('bundled MMG worker loads its WASM and refines real geometry', async () => {
  const model = parseMdpa(fixture);
  const worker = new Worker(path.join(root, 'out/mmgWorker.js'));
  try {
    const response = new Promise<MmgWorkResponse>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('exit', code => reject(new Error(`MMG exited before replying: ${code}`)));
      worker.on('message', (message: MmgWorkResponse) => {
        if (message.type !== 'progress') resolve(message);
      });
    });
    worker.postMessage({ op: 'remesh', model, params: { mode: 'factor', factor: 0.3 } });
    const message = await response;
    expect(message.type, JSON.stringify(message)).toBe('done');
    if (message.type !== 'done') throw new Error('MMG did not finish');
    expect(message.result.model.nodeCount).toBeGreaterThan(model.nodeCount);
    expect(message.result.model.bounds.min).toEqual(model.bounds.min);
    expect(message.result.model.bounds.max).toEqual(model.bounds.max);
  } finally { await worker.terminate(); }
}, 60_000);
