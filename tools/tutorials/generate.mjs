import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cases } from './cases.mjs';
import { root, python, servers } from './mcp.mjs';

const exec = promisify(execFile);
const selected = process.argv.slice(2);
const output = await fs.mkdtemp(path.join(root, 'node_modules/.cache/tutorials-'));
console.log(`Working directory: ${output}`);
const mcp = await servers();
let failed = false;
try {
  for (const c of cases.filter(c => !selected.length || selected.includes(c.id))) {
    const dir = path.join(output, c.id);
    await fs.mkdir(dir);
    try {
      const geometry = path.join(dir, c.geometry), meshPath = path.join(dir, 'mesh.mdpa');
      await fs.copyFile(path.join(root, c.source), geometry);
      if (c.planarGeometry === 'obstacle') await fs.writeFile(path.join(dir, 'obstacle-channel.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -600 2000 600" width="2000" height="600">\n  <path d="M 0 -600 L 0 0 L 2000 0 L 2000 -600 Z"/>\n  <circle cx="500" cy="-300" r="60"/>\n</svg>\n');
      if (c.ops.length) await mcp.call('cad__apply_edit_ops', { path: geometry, ops: c.ops });
      let inventory = await mcp.call('cad__load_model', { path: geometry });
      let parts = c.parts;
      if (c.planar) {
        if (c.planarGeometry === 'obstacle') {
          const edgeCount = 4 + c.obstacle.sides;
          const edges = [];
          for (let n = 0; n < edgeCount; n++) edges.push(await mcp.call('cad__inspect', { path: geometry, entityId: `edge-${n}` }));
          const loop = await mcp.call('cad__apply_edit_ops', { path: geometry, ops: [{ op: 'addSurfaceFromLines', edges: edges.map((_, n) => `edge-${n}`) }] });
          if (!loop.report?.every(row => row.accepted && row.applied !== false)) throw Error('CAD did not build the channel face with an obstacle hole');
          inventory = await mcp.call('cad__load_model', { path: geometry });
          const inlet = [], outlet = [], walls = [], obstacle = [];
          const { widthMm, heightMm } = c.obstacle;
          edges.forEach((edge, n) => {
            const id = `edge-${n}`, [x, y] = edge.center;
            if (n >= 4) obstacle.push(id);
            else if (Math.abs(x) < 1e-6) inlet.push(id);
            else if (Math.abs(x - widthMm) < 1e-6) outlet.push(id);
            else if (Math.abs(y) < 1e-6 || Math.abs(y - heightMm) < 1e-6) walls.push(id);
            else throw Error(`Could not classify channel boundary edge ${id} at ${edge.center}`);
          });
          if (inlet.length !== 1 || outlet.length !== 1 || walls.length !== 2 || obstacle.length !== c.obstacle.sides) throw Error('Unexpected obstacle-channel boundary topology');
          parts = [
            { name: 'Domain', surfaces: ['face-0'] },
            { name: 'Inlet', lines: inlet }, { name: 'Outlet', lines: outlet }, { name: 'Walls', lines: walls },
            { name: 'Obstacle', lines: obstacle, meshGrading: { sizeAtWall: 12, sizeFar: 60, distNear: 25, distFar: 350 } },
          ];
        } else {
          const edges = [];
          for (let n = 0; n < 4; n++) edges.push(await mcp.call('cad__inspect', { path: geometry, entityId: `edge-${n}` }));
          await fs.writeFile(path.join(dir, 'edges.json'), JSON.stringify(edges, null, 2));
          const left = [], right = [], walls = [];
          edges.forEach((edge, n) => {
            const x = edge.center[0];
            (Math.abs(x) < 1e-6 ? left : Math.abs(x - 4000) < 1e-6 ? right : walls).push(`edge-${n}`);
          });
          if (left.length !== 1 || right.length !== 1 || walls.length !== 2) throw Error('Unexpected rectangle orientation');
          parts = [{ name: 'Domain', surfaces: ['face-0'] }, { name: 'Boundary', lines: [...left, ...right, ...walls] }];
        }
      }
      for (const part of parts) await mcp.call('cad__set_part', { path: geometry, ...part });
      await mcp.call('cad__set_mesh_options', { path: geometry, options: c.options });
      const exported = await mcp.call('cad__export_mesh', { path: geometry, outputPath: meshPath, format: 'mdpaElements', unit: 'm', options: c.options });
      const described = await mcp.call('mesh__problemtype_describe', { problemtype: c.problemtype });
      const state = described.defaultState;
      Object.assign(state.values.problem, c.problem);
      state.assignments = c.assignments;
      state.materials = c.materials;
      await mcp.call('mesh__case_write_state', { meshPath, state });
      await mcp.call('mesh__case_generate', { meshPath });
      await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify({ ...c, parts, ops: c.planarGeometry === 'obstacle'
        ? [...c.ops, { op: 'addSurfaceFromLines', edges: Array.from({ length: 4 + c.obstacle.sides }, (_, n) => `edge-${n}`) }]
        : c.ops, exportUnit: 'm', inventory, exported }, null, 2));
      console.log(`${c.id}: generated; solving`);
      const { stdout, stderr } = await exec(python, ['MainKratos.py'], { cwd: dir, env: { ...process.env, OMP_NUM_THREADS: '2' }, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
      await fs.writeFile(path.join(dir, 'solver.log'), stdout + stderr);
      const verification = await exec(python, [path.join(root, 'tools/tutorials/verify.py'), c.id, dir], { maxBuffer: 1024 * 1024 });
      const report = JSON.parse(verification.stdout);
      const inputs = {};
      for (const name of await fs.readdir(dir)) if (/\.(mdpa|json|py|stp|brep|svg)$/.test(name) && !name.includes('preparation') && name !== 'recipe.json') inputs[name] = createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex');
      await fs.writeFile(path.join(dir, 'verification.json'), JSON.stringify({ ...report, inputs }, null, 2) + '\n');
      console.log(`${c.id}: ${JSON.stringify(report.checks)}`);
    } catch (e) {
      failed = true;
      await fs.writeFile(path.join(dir, 'failure.log'), `${e.stack}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
      console.error(`${c.id}: FAILED; see ${dir}/failure.log`);
    }
  }
} finally { await mcp.close(); }
if (failed) process.exitCode = 1;
