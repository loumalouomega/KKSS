import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cases } from './cases.mjs';
import { root, python, servers } from './mcp.mjs';
import { ensureSolverAlias } from './runtimeAlias.mjs';

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
      if (c.windTunnel) {
        // The wizard builds the mesh and the case itself: the body is a CAD
        // sphere (unit m) skinned to an STL, then plan + generate. Nothing
        // below applies; the whole case is this branch.
        const sphere = await mcp.call('cad__apply_edit_ops', { path: geometry, ops: [{ op: 'addSphere', center: [0, 0, 0], radius: c.windTunnel.radiusMm }] });
        if (!sphere.report?.every(row => row.accepted && row.applied !== false)) throw Error('CAD did not build the wind-tunnel sphere');
        inventory = await mcp.call('cad__load_model', { path: geometry });
        const solid = (inventory.solids ?? [])[0]?.id ?? 'solid-0';
        await mcp.call('cad__set_part', { path: geometry, name: 'Body', volumes: [solid] });
        await mcp.call('cad__set_mesh_options', { path: geometry, options: { dimension: 3, sizeMin: c.windTunnel.sizeMinMm, sizeMax: c.windTunnel.sizeMaxMm } });
        const bodyVol = path.join(dir, 'body-vol.mdpa');
        await mcp.call('cad__export_mesh', { path: geometry, outputPath: bodyVol, format: 'mdpaElements', unit: 'm', options: { dimension: 3, sizeMin: c.windTunnel.sizeMinMm, sizeMax: c.windTunnel.sizeMaxMm } });
        const bodyStl = path.join(dir, `${c.windTunnel.stem}_body_src.stl`);
        await mcp.call('mesh__mesh_extract_skin', { path: bodyVol, outputPath: bodyStl });
        const plan = await mcp.call('mesh__wind_tunnel_plan', { bodyPath: bodyStl, unit: 'm', ...c.windTunnel.plan });
        if ((plan.errors ?? []).length) throw Error(`Wind-tunnel plan refused: ${(plan.errors ?? []).join('; ')}`);
        const generated = await mcp.call('mesh__wind_tunnel_generate', {
          bodyPath: bodyStl, unit: 'm', ...c.windTunnel.plan,
          outputFolder: dir, stem: c.windTunnel.stem, generateCase: true,
        });
        await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify({ ...c, plan, report: generated.report, problemtype: generated.problemtype, caseNotes: generated.caseNotes }, null, 2));
        console.log(`${c.id}: generated; solving`);
        const { stdout, stderr } = await exec(python, ['MainKratos.py'], { cwd: dir, env: { ...process.env, OMP_NUM_THREADS: '2' }, timeout: c.timeout ?? 180000, maxBuffer: 16 * 1024 * 1024 });
        await fs.writeFile(path.join(dir, 'solver.log'), stdout + stderr);
        const verification = await exec(python, [path.join(root, 'tools/tutorials/verify.py'), c.id, dir], { maxBuffer: 1024 * 1024 });
        const report = JSON.parse(verification.stdout);
        const inputs = {};
        for (const name of await fs.readdir(dir)) if (/\.(mdpa|json|py|stp|brep|svg|stl)$/.test(name) && !name.includes('preparation') && name !== 'recipe.json') inputs[name] = createHash('sha256').update(await fs.readFile(path.join(dir, name))).digest('hex');
        await fs.writeFile(path.join(dir, 'verification.json'), JSON.stringify({ ...report, inputs }, null, 2) + '\n');
        console.log(`${c.id}: ${JSON.stringify(report.checks)}`);
        continue; // the wizard wrote its own mesh and case; the shared path below does not apply.
      }
      if (c.coupled3d) {
        // Two touching boxes sharing the y = 0 face: the fluid channel above,
        // the structure slab below. Faces are classified by outward normal and
        // centre; the shared face exists once per solid and the Interface part
        // takes the fluid side (the export fragments touching volumes so the
        // merged face meshes once).
        const { widthMm: W, fluidHeightMm: Hf, solidHeightMm: Hs, depthMm: D } = c.coupled;
        inventory = await mcp.call('cad__load_model', { path: geometry });
        const solids = inventory.solids ?? [];
        if (solids.length !== 2) throw Error(`Coupled channel needs two solids, found ${solids.length}`);
        const at = (v, target) => Math.abs(v - target) < 1e-6;
        const faces = [];
        for (const s of solids) for (const id of s.faceIds ?? []) {
          const info = await mcp.call('cad__inspect', { path: geometry, entityId: id });
          faces.push({ id, solid: s.id, center: info.center });
        }
        if (faces.length !== 12) throw Error(`Coupled channel needs twelve faces, found ${faces.length}`);
        const fluidSolid = solids.find(s => faces.some(f => f.solid === s.id && at(f.center[1], Hf)))?.id;
        const structSolid = solids.find(s => s.id !== fluidSolid)?.id;
        if (!fluidSolid || !structSolid) throw Error('Could not tell the fluid solid from the structure solid');
        // Box face normals are not outward-oriented, so classification is by
        // centre position only.
        const inlet = [], outlet = [], walls = [], fixed = [];
        let fluidInterface = null, structInterface = null;
        for (const f of faces) {
          const [x, y, z] = f.center, id = f.id;
          if (f.solid === fluidSolid) {
            if (at(x, 0)) inlet.push(id);
            else if (at(x, W)) outlet.push(id);
            else if (at(y, Hf) || at(z, 0) || at(z, D)) walls.push(id);
            else if (at(y, 0)) fluidInterface = id;
            else throw Error(`Could not classify fluid boundary face ${id} at ${f.center}`);
          } else {
            if (at(y, 0)) structInterface = id;
            else if ((at(x, 0) || at(x, W)) && !at(y, -Hs)) fixed.push(id);
            else if (!(at(x, 0) || at(x, W) || at(y, -Hs) || at(z, 0) || at(z, D))) throw Error(`Could not classify structure boundary face ${id} at ${f.center}`);
          }
        }
        if (inlet.length !== 1 || outlet.length !== 1 || walls.length !== 3 || !fluidInterface || !structInterface || fixed.length !== 2) throw Error('Unexpected coupled-channel boundary topology');
        parts = [
          { name: 'Fluid', volumes: [fluidSolid] },
          { name: 'Structure', volumes: [structSolid] },
          { name: 'Inlet', surfaces: inlet }, { name: 'Outlet', surfaces: outlet }, { name: 'Walls', surfaces: walls },
          // One shared Interface part: the exporter drops a second part with
          // identical faces, and the slicer carries a shared path into both
          // domain meshes. Both interface conditions address it.
          { name: 'Interface', surfaces: [fluidInterface] },
          { name: 'Fixed', surfaces: fixed },
        ];
      } else if (c.twoFluids) {
        // The dam-break tank is one rectangle. Two rectangles split at the water
        // edge would put a mesh line on x = waterWidth, with nodes exactly on the
        // free surface (signed distance exactly 0); the level set is set from
        // the geometry (signedDistance) instead, so the tank stays one face. The
        // top is an atmospheric outlet at zero pressure: a closed tank has no
        // pressure reference, and its gauge drifts without one.
        const { widthMm: W, heightMm: H } = c.tank;
        const at = (v, target) => Math.abs(v - target) < 1e-6;
        const walls = [], top = [];
        for (let n = 0; n < 4; n++) {
          const { center: [x, y] } = await mcp.call('cad__inspect', { path: geometry, entityId: `edge-${n}` });
          if (at(y, H)) top.push(`edge-${n}`);
          else if (at(x, 0) || at(x, W) || at(y, 0)) walls.push(`edge-${n}`);
        }
        if (walls.length !== 3 || top.length !== 1) throw Error(`Unexpected tank boundary topology (${walls.length} walls, ${top.length} top edges)`);
        parts = [
          { name: 'Domain', surfaces: ['face-0'] },
          { name: 'Walls', lines: walls },
          { name: 'Outlet', lines: top },
        ];
      } else if (c.mok) {
        // The Mok channel: classify every edge of the model the ops built by
        // its midpoint. The flexible wall's slot edges (three) become the
        // shared Interface; its bottom line is the Fixed clamp; inlet and
        // outlet are the two risers; the remaining boundary (base, ramp, flat
        // bottom and top) is the no-slip Walls and the slip Slip.
        const edgeCount = c.ops[0].points.length + 1; // closed polyline + the wall's bottom line
        const at = (v, target) => Math.abs(v - target) < 1e-6;
        const inlet = [], outlet = [], walls = [], slip = [], fixed = [], iface = [];
        for (let n = 0; n < edgeCount; n++) {
          const id = `edge-${n}`;
          const { center: [x, y] } = await mcp.call('cad__inspect', { path: geometry, entityId: id });
          if (at(x, 0)) inlet.push(id);
          else if (at(x, 1750)) outlet.push(id);
          else if (at(y, 500)) slip.push(id);
          else if (at(y, 0)) (x > 500 && x < 505 ? fixed : walls).push(id);
          else if (at(x, 500) || at(x, 505) || (at(x, 502.5) && at(y, 250))) iface.push(id);
          else walls.push(id); // the ramp and the flat bottom at y = 300
        }
        if (inlet.length !== 1 || outlet.length !== 1 || slip.length !== 1 || fixed.length !== 1 || iface.length !== 3 || walls.length !== edgeCount - 7)
          throw Error(`Unexpected Mok channel boundary topology (${edgeCount} edges: ${[inlet, outlet, walls, slip, fixed, iface].map(a => a.length)})`);
        parts = [
          { name: 'Fluid', surfaces: ['face-0'] },
          // The wall meshes at 1.5 mm so the bending tip resolves; the fluid
          // refines from 2 mm at the interface to 40 mm far away, through the
          // Interface part's grading field.
          { name: 'Structure', surfaces: ['face-1'], meshSize: 1.5 },
          { name: 'Inlet', lines: inlet }, { name: 'Outlet', lines: outlet },
          { name: 'Walls', lines: walls }, { name: 'Slip', lines: slip }, { name: 'Fixed', lines: fixed },
          { name: 'Interface', lines: iface, meshGrading: { sizeAtWall: 2, sizeFar: 30, distNear: 12, distFar: 150 } },
        ];
      } else if (c.planar) {
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
            { name: 'Obstacle', lines: obstacle, meshGrading: c.obstacleWallGrading ?? { sizeAtWall: 12, sizeFar: 60, distNear: 25, distFar: 350 } },
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
      await mcp.call('cad__set_mesh_options', { path: geometry, options: c.meshOptions ?? c.options });
      const exported = await mcp.call('cad__export_mesh', { path: geometry, outputPath: meshPath, format: 'mdpaElements', unit: 'm', options: c.meshOptions ?? c.options });
      const described = await mcp.call('mesh__problemtype_describe', { problemtype: c.problemtype });
      const state = described.defaultState;
      if (c.values) {
        // Coupled problemtypes keep section-keyed values (fsi:
        // problem/fluid/structure; cosim: coupling/fluid/structure).
        for (const [section, vals] of Object.entries(c.values)) Object.assign(state.values[section] ??= {}, vals);
      } else {
        Object.assign(state.values.problem, c.problem);
      }
      state.assignments = c.assignments;
      state.materials = c.materials;
      if (c.output) state.output = { ...state.output, ...c.output };
      if (c.signedDistance) {
        // The level set is a nodal field written before the case state, so the
        // solver's requiresFields check sees it. The free surface is the faces
        // of a box, so the exact signed distance is the 2D box formula: negative
        // in the water, zero on its faces, positive in the air. Measured against
        // the water face instead (sdfDistance), every water node sat at exactly
        // 0, which the two-fluid solver cannot divide. The transform overwrites
        // the mesh in place, exactly File ▸ Save.
        const { expr, output } = c.signedDistance;
        const transformed = await mcp.call('mesh__mesh_transform', { path: meshPath, ops: [{ op: 'fieldCalc', expr, location: 'Nodal', output }] });
        if (!JSON.stringify(transformed).includes(output)) throw Error(`fieldCalc ${expr} produced no ${output} field`);
      }
      await mcp.call('mesh__case_write_state', { meshPath, state });
      await mcp.call('mesh__case_generate', { meshPath });
      // mesh 5.5.0 structured preflight: record the finding set beside the
      // recipe so publish/writeDocs can document it. A refusing report is a
      // finding, not a generation failure — the solver run below still decides.
      let preflight = null;
      try {
        preflight = await mcp.call('mesh__case_validate', { meshPath });
      } catch (e) {
        preflight = { ok: false, error: String(e.message ?? e).slice(0, 500) };
      }
      await fs.writeFile(path.join(dir, 'recipe.json'), JSON.stringify({ ...c, parts, ops: c.planarGeometry === 'obstacle'
        ? [...c.ops, { op: 'addSurfaceFromLines', edges: Array.from({ length: 4 + c.obstacle.sides }, (_, n) => `edge-${n}`) }]
        : c.ops, exportUnit: 'm', inventory, exported, preflight }, null, 2));
      console.log(`${c.id}: generated; solving`);
      // A case whose stock solver wrapper imports a module name the package
      // does not ship gets the documented one-file alias first (idempotent).
      if (c.solverAlias) await ensureSolverAlias(c.solverAlias);
      const driver = c.driver ?? 'MainKratos.py';
      let solverStdout = '', solverStderr = '', solveFailed = null;
      try {
        ({ stdout: solverStdout, stderr: solverStderr } = await exec(python, [driver], { cwd: dir, env: { ...process.env, OMP_NUM_THREADS: '2' }, timeout: c.timeout ?? 180000, maxBuffer: 16 * 1024 * 1024 }));
      } catch (e) { solveFailed = e; solverStdout = e.stdout ?? ''; solverStderr = e.stderr ?? ''; }
      await fs.writeFile(path.join(dir, 'solver.log'), solverStdout + solverStderr);
      if (solveFailed) throw solveFailed;
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
