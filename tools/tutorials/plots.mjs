/** Derive reproducible plot recipes/CSV from the published solver bytes, never rerun a solve. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { cases } from './cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'doc/public/examples/tutorials');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nearest = (model, xyz) => {
  let best = 0, distance = Infinity;
  for (let i = 0; i < model.nodeCount; i++) {
    const d = xyz.reduce((sum, v, k) => sum + (model.coords[3*i+k] - v)**2, 0);
    if (d < distance) { best = i; distance = d; }
  }
  return { id: model.nodeIds[best], xyz: Array.from(model.coords.slice(3*best, 3*best+3)) };
};

export async function publishTutorialPlots() {
  const scratch = await fs.access('/tmp/opencode').then(() => '/tmp/opencode', () => os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(scratch, 'kkss-tutorial-plots-'));
  try {
    const entry = path.join(temporary, 'data.cjs');
    // Line interpolation uses the staged meshio++ kernel, exactly as the app.
    await fs.symlink(path.join(root, 'out/meshio'), path.join(temporary, 'meshio'), process.platform === 'win32' ? 'junction' : 'dir');
    await build({ entryPoints: [path.join(root, 'tools/tutorials/plotData.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: entry,
      external: ['@meshioplusplus/wasm', '@meshioplusplus/wasm/*'] });
    const { parseMeshFile, collectPlot, resolvePlotPaths, validatePlotRecipe, plotCsvRows, plotManifest } = createRequire(import.meta.url)(entry);
    for (const c of cases) {
      const dir = path.join(output, c.id), plots = path.join(dir, 'plots');
      await fs.mkdir(plots, { recursive: true });
      const isCoupled = c.id === 'fsi' || c.id === 'cosim';
      const parameters = JSON.parse(await fs.readFile(path.join(dir, c.primaryDocument ?? 'ProjectParameters.json'), 'utf8'));
      const dtDoc = c.id === 'cosim'
        ? JSON.parse(await fs.readFile(path.join(dir, 'ProjectParametersCFD.json'), 'utf8'))
        : parameters;
      const vtkFiles = (await fs.readdir(path.join(dir, 'vtk_output'))).filter(n => n.endsWith('.vtk')).sort((a,b) => Number(a.match(/_(\d+)\.vtk$/)[1]) - Number(b.match(/_(\d+)\.vtk$/)[1]));
      const fluidFiles = vtkFiles.filter(n => n.startsWith('FluidModelPart'));
      const structFiles = vtkFiles.filter(n => n.startsWith('Structure'));
      if (isCoupled && (!fluidFiles.length || !structFiles.length || fluidFiles.length !== structFiles.length)) throw Error(`${c.id}: expected matching fluid/structure VTK families`);
      const files = isCoupled ? fluidFiles : vtkFiles;
      const model = await parseMeshFile(path.join(dir, 'vtk_output', files.at(-1)));
      const sourcePath = '../vtk_output/' + files[0];
      const finalPath = '../vtk_output/' + files.at(-1);
      const dt = c.id === 'fsi'
        ? parameters.solver_settings.fluid_solver_settings?.time_stepping?.time_step
        : dtDoc.solver_settings.time_stepping?.time_step;
      // Kratos VTK suffix = solver STEP, not a timestamp. This is an EXPLICIT
      // reconstruction for these fixed-step cases, not a general filename heuristic.
      const times = dt ? files.map(n => Number((parameters.problem_data.start_time + Number(n.match(/_(\d+)\.vtk$/)[1])*dt).toPrecision(12))) : undefined;
      const coordinates = {};
      const history = (id, node, variable) => {
        coordinates[id] = node;
        return { id, type: 'history', path: sourcePath, kind: 'Nodal', entityId: node.id, variable, ...(times ? { times, timeUnit: 's' } : {}) };
      };
      const series = (id, component, unit, name = id, factor = 1, x = 'time') => ({ id, source: id, name, x, y: `v${component}`, transforms: [{ op: 'convert', factor, unit }] });
      const recipe = (title, sources, curves, labels = {}) => ({ version: 1, sources, series: curves, presentation: { family: 'line', title, lineMode: 'lines+markers', ...labels } });
      const recipes = {};
      if (c.id === 'fluid') {
        const front = nearest(model, [0.44, 0.3, 0]), back = nearest(model, [0.56, 0.3, 0]);
        recipes['pressure-history'] = recipe('Obstacle pressure: upstream and downstream', [history('front', front, 'PRESSURE'), history('back', back, 'PRESSURE')],
          [series('front', 0, 'Pa', `Upstream node ${front.id}`), series('back', 0, 'Pa', `Downstream node ${back.id}`)], { xLabel: 'Reconstructed solver time [s]', yLabel: 'Pressure [Pa]' });
        recipes['wake-profile'] = recipe('Axial velocity through the near wake', [{ id: 'wake', type: 'probe', path: finalPath, points: [[0.565,0.3,0],[0.85,0.3,0]], variable: 'VELOCITY', samples: 80, timeStep: files.length-1, followTimeline: false }],
          [series('wake', 0, 'm/s', 'Axial velocity', 1, 'distance')], { xLabel: 'Distance along probe [m; supplied by SI case]', yLabel: 'Axial velocity [m/s]' });
      } else if (c.id === 'structural') {
        const field = model.fields.find(f => f.variable === 'DISPLACEMENT');
        let row = 0; for (let i = 1; i < field.ids.length; i++) if (Math.abs(field.values[3*i+2]) > Math.abs(field.values[3*row+2])) row = i;
        const index = model.nodeIds.indexOf(field.ids[row]);
        const tip = { id: field.ids[row], xyz: Array.from(model.coords.slice(3*index,3*index+3)) };
        recipes['displacement-history'] = recipe('Static cantilever: displacement over load steps', [history('tip', tip, 'DISPLACEMENT')], [series('tip', 2, 'mm', `Tip node ${tip.id}: Z`, 1000)], { xLabel: 'Static analysis pseudo-time [s]', yLabel: 'Displacement Z [mm]' });
        recipes['reaction-history'] = recipe('Whole-mesh signed nodal reaction sum', [{ id: 'reaction', type: 'region', path: sourcePath, kind: 'Nodal', variable: 'REACTION', scope: 'history', operation: 'sum', times, timeUnit: 's' }], [series('reaction', 2, 'N', 'Sum of supplied REACTION Z')], { xLabel: 'Static analysis pseudo-time [s]', yLabel: 'Reaction Z [N]' });
      } else if (c.id === 'shallow-water') {
        const center = nearest(model, [2,0.5,0]);
        recipes['depth-history'] = recipe('Still-water basin depth', [history('depth', center, 'HEIGHT')], [series('depth', 0, 'm', `Depth at node ${center.id}`)], { xLabel: 'Reconstructed solver time [s]', yLabel: 'Water depth [m]' });
      } else if (c.id === 'fsi') {
        // Mok benchmark: point A is the wall tip (0.500, 0.250); its
        // horizontal-displacement history is the published comparison curve
        // (Mok_ux_A.png). Both participants share the frame count; the fluid
        // family drives the time axis, the structure family the tip history.
        const structModel = await parseMeshFile(path.join(dir, 'vtk_output', structFiles.at(-1)));
        const tipA = nearest(structModel, [0.5, 0.25, 0]);
        const structSource = '../vtk_output/' + structFiles[0];
        coordinates.pointA = tipA;
        const structHistory = (id, node, variable) => {
          coordinates[id] = node;
          return { id, type: 'history', path: structSource, kind: 'Nodal', entityId: node.id, variable, ...(times ? { times, timeUnit: 's' } : {}) };
        };
        recipes['tip-displacement-history'] = recipe('Mok benchmark: wall-tip horizontal displacement (point A)', [structHistory('tipA', tipA, 'DISPLACEMENT')],
          [series('tipA', 0, 'mm', `Point A node ${tipA.id}: X`, 1000)], { xLabel: 'Reconstructed solver time [s]', yLabel: 'Displacement X [mm]' });
        const upstreamProbe = nearest(model, [0.45, 0.25, 0]);
        recipes['pressure-history'] = recipe('Pressure upstream of the flexible wall', [history('pressure', upstreamProbe, 'PRESSURE')],
          [series('pressure', 0, 'Pa', `Pressure node ${upstreamProbe.id}`)], { xLabel: 'Reconstructed solver time [s]', yLabel: 'Pressure [Pa]' });
      } else if (isCoupled) {
        // Both participants share the step count; the fluid family drives the
        // time axis, the structure family the displacement history.
        const midX = c.coupled.widthMm / 1000 / 2, midZ = c.coupled.depthMm / 1000 / 2;
        const structModel = await parseMeshFile(path.join(dir, 'vtk_output', structFiles.at(-1)));
        const probe = nearest(model, [midX, 0.05, midZ]), tip = nearest(structModel, [midX, 0, midZ]);
        const structSource = '../vtk_output/' + structFiles[0];
        coordinates.interface = tip;
        const structHistory = (id, node, variable) => {
          coordinates[id] = node;
          return { id, type: 'history', path: structSource, kind: 'Nodal', entityId: node.id, variable, ...(times ? { times, timeUnit: 's' } : {}) };
        };
        recipes['pressure-history'] = recipe('Interface pressure over coupled steps', [history('pressure', probe, 'PRESSURE')],
          [series('pressure', 0, 'Pa', `Interface pressure node ${probe.id}`)], { xLabel: 'Reconstructed solver time [s]', yLabel: 'Pressure [Pa]' });
        recipes['interface-displacement-history'] = recipe('Interface displacement over coupled steps', [structHistory('tip', tip, 'DISPLACEMENT')],
          [series('tip', 1, 'mm', `Interface node ${tip.id}: Y`, 1000)], { xLabel: 'Reconstructed solver time [s]', yLabel: 'Displacement Y [mm]' });
      } else {
        const thermal = c.id === 'thermal', min = model.bounds.min, max = model.bounds.max;
        const y = (min[1]+max[1])/2, z = (min[2]+max[2])/2, epsilon = (max[0]-min[0])*1e-5;
        const variable = thermal ? 'TEMPERATURE' : 'VELOCITY_POTENTIAL';
        recipes[thermal ? 'temperature-profile' : 'potential-profile'] = recipe(thermal ? 'Stationary conduction: temperature profile' : 'Uniform flow: potential profile',
          [{ id: 'profile', type: 'probe', path: finalPath, points: [[min[0]+epsilon,y,z],[max[0]-epsilon,y,z]], variable, samples: 60, timeStep: files.length-1 }],
          [series('profile', 0, thermal ? 'K' : 'm²/s', variable, 1, 'distance')], { xLabel: 'Distance along probe [m; supplied by SI case]', yLabel: thermal ? 'Temperature [K]' : 'Velocity potential [m²/s]' });
      }
      const inputs = {};
      const paramInputs = isCoupled
        ? (c.id === 'cosim' ? ['ProjectParametersCoSim.json', 'ProjectParametersCFD.json', 'ProjectParametersCSM.json'] : ['ProjectParameters.json'])
        : ['ProjectParameters.json'];
      const resultInputs = (isCoupled ? [...fluidFiles, ...structFiles] : files).map(n => 'vtk_output/' + n);
      for (const file of [...paramInputs, 'recipe.json', ...resultInputs]) inputs[file] = hash(await fs.readFile(path.join(dir,file)));
      const summary = { version: 1, case: c.id, source: 'Published Kratos solver output; no solver rerun or synthetic values', coordinates, inputs,
        timeMapping: times ? { basis: 'start_time + STEP * fixed time_step; VTK suffix is STEP, not a timestamp', start: parameters.problem_data.start_time, dt, times, configuredEndTime: parameters.problem_data.end_time } : { basis: 'Single stationary solution; no time history' },
        units: 'Explicitly supplied from the tutorial SI setup using recipe convert transforms; original VTK field units remain unknown',
        ownership: 'No isolated-run receipt is invented; these are relocatable disk-source recipes, not verified saved-run bindings', recipes: {} };
      for (const [name, r] of Object.entries(recipes)) {
        validatePlotRecipe(r);
        const data = await collectPlot(resolvePlotPaths(r, plots));
        if (data.partial || data.series.length !== r.series.length || data.series.some(s => !s.statistics.count)) throw Error(`${c.id}/${name}: ${JSON.stringify(data.diagnostics)} ${JSON.stringify(data.series.map(s=>s.diagnostics))}`);
        await fs.writeFile(path.join(plots,name+'.json'), JSON.stringify(r,null,2)+'\n');
        await fs.writeFile(path.join(plots,name+'.csv'), [...plotCsvRows(data)].join(''));
        const provenance = { ...plotManifest(data), recipe: r, tutorial: { case: c.id, inputs, timeMapping: summary.timeMapping, units: summary.units } };
        const portable = value => typeof value === 'string' ? value.replaceAll(dir + path.sep, '../') : Array.isArray(value) ? value.map(portable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key,portable(v)])) : value;
        await fs.writeFile(path.join(plots,name+'.csv.kratosplot.json'), JSON.stringify(portable(provenance),null,2)+'\n');
        summary.recipes[name] = data.series.map(s => ({ id: s.id, count: s.statistics.count, first: s.points[0], last: s.points.at(-1), statistics: s.statistics }));
        console.log(`${c.id}/${name}: ${data.fullCount} full-resolution points`);
      }
      await fs.writeFile(path.join(plots,'verification.json'), JSON.stringify(summary,null,2)+'\n');
      const verificationPath = path.join(dir,'verification.json');
      const verification = JSON.parse(await fs.readFile(verificationPath,'utf8'));
      for (const file of await fs.readdir(plots)) verification.files['plots/'+file] = hash(await fs.readFile(path.join(plots,file)));
      await fs.writeFile(verificationPath, JSON.stringify(verification,null,2)+'\n');
    }
    await promisify(execFile)(process.env.KKSS_TUTORIAL_ARCHIVE_PYTHON ?? 'python3', ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
def archive(source,target,prefix):
 with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
  for p in sorted(source.rglob('*')):
   if p.is_file() and p.suffix != '.zip':
    info=zipfile.ZipInfo(str(pathlib.Path(prefix)/p.relative_to(source)),(2026,10,5,0,0,0))
    info.compress_type=zipfile.ZIP_DEFLATED
    z.writestr(info,p.read_bytes())
for name in sys.argv[2:]: archive(root/name,root/(name+'.zip'),name)
archive(root,root/'tutorial-cases.zip','')`, output, ...cases.map(c=>c.id)]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishTutorialPlots();
