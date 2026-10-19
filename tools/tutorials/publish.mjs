// Publish only independently verified generated cases; never solver logs or runtime receipts.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cases } from './cases.mjs';
import { root, python } from './mcp.mjs';

const args = process.argv.slice(2);
// Published text names no machine: the repository is relative to its root, the
// generation folder is "generated/" and anything else under the home directory
// is "~". Recipes and records quote these paths in their notes.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GENERATED = new RegExp(`${escapeRegExp(root)}/node_modules/\\.cache/tutorials-[A-Za-z0-9]+/`, 'g');
export function scrubPaths(text) {
  return text.replace(GENERATED, 'generated/').split(`${root}/`).join('').split(os.homedir()).join('~');
}
const TEXT_FILE = /\.(json|py|txt|mdpa|geo)$/;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
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
  const dest = path.join(output, c.id);
  if (path.resolve(source) === path.resolve(dest)) throw Error(`${c.id}: the generation directory is the published directory`);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest);
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(dest, 'LICENSE'));
  // Text files are scrubbed of machine paths, and the verification's input
  // hashes follow the bytes that ship; binary geometry is copied as it is.
  async function copyPublished(name) {
    const from = path.join(source, name), to = path.join(dest, name);
    if (!TEXT_FILE.test(name)) return fs.cp(from, to, { recursive: true });
    const scrubbed = scrubPaths(await fs.readFile(from, 'utf8'));
    if (/\/home\/[A-Za-z]/.test(scrubbed)) throw Error(`${c.id}/${name} still names an absolute home path`);
    await fs.writeFile(to, scrubbed);
    if (verification.inputs?.[name]) verification.inputs[name] = sha256(scrubbed);
  }
  for (const name of await fs.readdir(source)) {
    // No solver output ships: vtk_output stays in the generation directory
    // (verification ran against it there); the published case carries the
    // inputs, the generated case and the verification record.
    if (name === 'kkss-convergence-v2.jsonl' || name === c.geometry || name === 'obstacle-channel.svg' || name.startsWith(c.geometry + '.') && !name.endsWith('.geo') ||
        /^(mesh(?:_case|_Fluid|_Structural)?\.mdpa|mesh\.kratoscase\.json|ProjectParameters(?:CoSim|CFD|CSM)?\.json|.*Materials\.json|MainKratos(?:CoSim)?\.py)$/.test(name)) {
      await copyPublished(name);
    }
    // The wizard names its own files after the stem, not after the mesh.
    if (c.windTunnel && [`${c.windTunnel.stem}.mdpa`, `${c.windTunnel.stem}_body.stl`, `${c.windTunnel.stem}.kratosvwt.json`, `${c.windTunnel.stem}.kratoscase.json`, `${c.windTunnel.stem}_case.mdpa`].includes(name)) {
      await copyPublished(name);
    }
  }
  const recipe = JSON.parse(await fs.readFile(path.join(source, 'recipe.json'), 'utf8'));
  delete recipe.exported; delete recipe.inventory;
  const recipeText = scrubPaths(JSON.stringify(recipe, null, 2) + '\n');
  if (/\/home\/[A-Za-z]/.test(recipeText)) throw Error(`${c.id}/recipe.json still names an absolute home path`);
  await fs.writeFile(path.join(dest, 'recipe.json'), recipeText);
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
  const verificationText = scrubPaths(JSON.stringify(verification, null, 2) + '\n');
  if (/\/home\/[A-Za-z]/.test(verificationText)) throw Error(`${c.id}/verification.json still names an absolute home path`);
  await fs.writeFile(path.join(dest, 'verification.json'), verificationText);
  await fs.writeFile(path.join(dest, 'README.txt'), c.windTunnel
    ? `${c.title}\n\nOpen ${c.geometry} in KKSS Pre-Processing (a CAD sphere sidecar-less: the body is one addSphere op). The wizard mesh and case are published as ${c.windTunnel.stem}.mdpa with ${c.windTunnel.stem}.kratosvwt.json (plan + report) and ${c.windTunnel.stem}.kratoscase.json (prepared case).\nRun MainKratos.py with Kratos 10.4.3 and the RANS + LinearSolvers applications, using OMP_NUM_THREADS=2.\nSee https://loumalouomega.github.io/KKSS/guide/tutorial-${c.id}\n\nverification.json records solver-produced results and SHA-256 hashes. Values are tutorial checks, not formal solver certification.\nGeometry source: ${c.source}; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.\n`
    : `${c.title}\n\nOpen ${c.geometry} in KKSS Pre-Processing. Sidecars replay the documented geometry edits and named Parts.\nOpen mesh.mdpa in Post-Processing for the saved Problemtype setup.\n${c.solverAlias ? `Before the run, create ${c.solverAlias.name}.py in the KratosMultiphysics/FluidDynamicsApplication package directory with the single line: from KratosMultiphysics.FluidDynamicsApplication.${c.solverAlias.target} import *\nThe serial two-fluid wrapper of Kratos 10.4.3 asks for the singular module name; the package ships the plural one.\n` : ''}Run ${c.driver ?? 'MainKratos.py'} with Kratos 10.4.3 and the required application, using OMP_NUM_THREADS=2.\nSee https://loumalouomega.github.io/KKSS/guide/tutorial-${c.id}\n\nverification.json records solver-produced results and SHA-256 hashes. Values are tutorial checks, not formal solver certification.\nGeometry source: ${c.source}; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.\n`);
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
// The combined archive is rebuilt from whatever is published: it holds
// solver-verified cases only, and a partial publish
// that refreshes one case still ships a coherent whole.
await exec(python, ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
allowed=set(sys.argv[3:])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file() and p.suffix != '.zip' and (p.relative_to(root).parts[0] in allowed or len(p.relative_to(root).parts) == 1):
   info=zipfile.ZipInfo(str(p.relative_to(root)), (2026,9,24,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,p.read_bytes())
`, output, path.join(output, 'tutorial-cases.zip'), ...cases.map(c => c.id)]);
console.log('Published combined tutorial-cases.zip');
