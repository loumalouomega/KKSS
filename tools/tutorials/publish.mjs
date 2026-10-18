// Publish only independently verified generated cases; never solver logs or runtime receipts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cases } from './cases.mjs';
import { root, python } from './mcp.mjs';
import { publishTutorialPlots } from './plots.mjs';

const args = process.argv.slice(2);
const only = new Set(args.filter(a => a.startsWith('--only=')).flatMap(a => a.slice('--only='.length).split(',')));
const sources = args.filter(a => !a.startsWith('--')).map(p => path.resolve(p));
if (!sources.length) throw Error('Usage: node tools/tutorials/publish.mjs <generation-directory> [...] [--only=<case>[,<case>]]');
const exec = promisify(execFile);
const output = path.join(root, 'doc/public/examples/tutorials');
await fs.mkdir(output, { recursive: true });
for (const c of cases.filter(c => !only.size || only.has(c.id))) {
  let source;
  for (const candidate of sources) {
    try { await fs.access(path.join(candidate, c.id, 'verification.json')); source = path.join(candidate, c.id); } catch { /* another generation */ }
  }
  if (!source) throw Error(`Missing verified case: ${c.id}`);
  const verified = await exec(python, [path.join(root, 'tools/tutorials/verify.py'), c.id, source], { encoding: 'utf8' });
  const verification = JSON.parse(verified.stdout);
  // A generation-verified, solver-blocked case keeps its upstream record in
  // the published verification: the docs state it, the archives skip it.
  const recipePreview = JSON.parse(await fs.readFile(path.join(source, 'recipe.json'), 'utf8'));
  if (recipePreview.blockedSolver) {
    const prior = JSON.parse(await fs.readFile(path.join(source, 'verification.json'), 'utf8'));
    verification.blocked = true;
    verification.upstream = recipePreview.blockedSolver;
    verification.log = prior.log;
  }
  const dest = path.join(output, c.id);
  if (path.resolve(source) === path.resolve(dest)) throw Error(`${c.id}: the generation directory is the published directory`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest);
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(dest, 'LICENSE'));
  for (const name of await fs.readdir(source)) {
    if (name === 'vtk_output' || name === 'kkss-convergence-v2.jsonl' || name === c.geometry || name === 'obstacle-channel.svg' || name.startsWith(c.geometry + '.') && !name.endsWith('.geo') ||
        /^(mesh(?:_case|_Fluid|_Structural)?\.mdpa|mesh\.kratoscase\.json|ProjectParameters(?:CoSim|CFD|CSM)?\.json|.*Materials\.json|MainKratos(?:CoSim)?\.py)$/.test(name)) {
      await fs.cp(path.join(source, name), path.join(dest, name), { recursive: true });
    }
    // The wizard names its own files after the stem, not after the mesh.
    if (c.windTunnel && [`${c.windTunnel.stem}.mdpa`, `${c.windTunnel.stem}_body.stl`, `${c.windTunnel.stem}.kratosvwt.json`, `${c.windTunnel.stem}.kratoscase.json`, `${c.windTunnel.stem}_case.mdpa`, 'body-vol.mdpa'].includes(name)) {
      await fs.cp(path.join(source, name), path.join(dest, name), { recursive: true });
    }
    // The blocked case publishes its generation evidence, not solver output.
    if (recipePreview.blockedSolver && (name === 'BLOCKED.txt' || name === 'solver.log')) {
      await fs.cp(path.join(source, name), path.join(dest, name), { recursive: true });
    }
  }
  const recipe = JSON.parse(await fs.readFile(path.join(source, 'recipe.json'), 'utf8'));
  delete recipe.exported; delete recipe.inventory;
  await fs.writeFile(path.join(dest, 'recipe.json'), JSON.stringify(recipe, null, 2) + '\n');
  const hashes = {};
  async function hashFiles(dir, prefix = '') {
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name, file = path.join(dir, item.name);
      if (item.isDirectory()) await hashFiles(file, name + '/');
      else hashes[name] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await hashFiles(dest);
  verification.files = hashes;
  verification.source = c.source;
  verification.revisions = {};
  for (const name of ['cad', 'mesh']) {
    const revision = await exec('git', ['-C', path.join(root, name), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    verification.revisions[name] = revision.stdout.trim();
  }
  await fs.writeFile(path.join(dest, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
  await fs.writeFile(path.join(dest, 'README.txt'), c.windTunnel
    ? `${c.title}\n\nOpen ${c.geometry} in KKSS Pre-Processing (a CAD sphere sidecar-less: the body is one addSphere op). The wizard mesh and case are published as ${c.windTunnel.stem}.mdpa with ${c.windTunnel.stem}.kratosvwt.json (plan + report) and ${c.windTunnel.stem}.kratoscase.json (prepared case).\nRun MainKratos.py with Kratos 10.4.3 and the RANS + LinearSolvers applications, using OMP_NUM_THREADS=2.\nSee https://loumalouomega.github.io/KKSS/guide/tutorial-${c.id}\n\nverification.json records solver-produced results and SHA-256 hashes. Values are tutorial checks, not formal solver certification.\nGeometry source: ${c.source}; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.\n`
    : recipePreview.blockedSolver
      ? `${c.title}\n\nGeneration-verified; solver blocked upstream (${recipePreview.blockedSolver}).\nOpen ${c.geometry} in KKSS Pre-Processing. Sidecars replay the documented geometry edits and named Parts.\nOpen mesh.mdpa in Post-Processing for the saved Problemtype setup; mesh_case.mdpa carries the nodal DISTANCE interface field.\nSee https://loumalouomega.github.io/KKSS/guide/tutorial-${c.id}\n\nverification.json records generation checks and SHA-256 hashes. Values are tutorial checks, not formal solver certification.\nGeometry source: ${c.source}; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.\n`
      : `${c.title}\n\nOpen ${c.geometry} in KKSS Pre-Processing. Sidecars replay the documented geometry edits and named Parts.\nOpen mesh.mdpa in Post-Processing for the saved Problemtype setup.\nRun ${c.driver ?? 'MainKratos.py'} with Kratos 10.4.3 and the required application, using OMP_NUM_THREADS=2.\nSee https://loumalouomega.github.io/KKSS/guide/tutorial-${c.id}\n\nverification.json records solver-produced results and SHA-256 hashes. Values are tutorial checks, not formal solver certification.\nGeometry source: ${c.source}; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.\n`);
  await exec(python, ['-c', `import pathlib,sys,zipfile
source=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as z:
 for p in sorted(source.rglob('*')):
  if p.is_file():
   info=zipfile.ZipInfo(str(pathlib.Path(source.name)/p.relative_to(source)), (2026,9,24,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,p.read_bytes())
`, dest, path.join(output, `${c.id}.zip`)]);
  console.log(`Published ${c.id}`);
}
await fs.copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
// Partial publishes (--only) leave the shared archives for the full run:
// the combined zip and the plot recipes only make sense over every case.
if (!only.size) {
// The combined archive holds solver-verified cases only; a generation-only
// blocked case ships its own per-case zip, not this one.
await exec(python, ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
allowed=set(sys.argv[3:])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file() and p.suffix != '.zip' and (p.relative_to(root).parts[0] in allowed or len(p.relative_to(root).parts) == 1):
   info=zipfile.ZipInfo(str(p.relative_to(root)), (2026,9,24,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,p.read_bytes())
`, output, path.join(output, 'tutorial-cases.zip'), ...cases.filter(c => !c.blockedSolver).map(c => c.id)]);
console.log('Published combined tutorial-cases.zip');
await publishTutorialPlots(only);
} else {
  console.log('Partial publish: combined tutorial-cases.zip and plots deferred to the full run.');
}
