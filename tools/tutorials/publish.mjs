// Publish only independently verified generated cases; never solver logs or runtime receipts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cases } from './cases.mjs';
import { root, python } from './mcp.mjs';

const sources = process.argv.slice(2).map(p => path.resolve(p));
if (!sources.length) throw Error('Usage: node tools/tutorials/publish.mjs <generation-directory> [...]');
const exec = promisify(execFile);
const output = path.join(root, 'doc/public/examples/tutorials');
await fs.mkdir(output, { recursive: true });
for (const c of cases) {
  let source;
  for (const candidate of sources) {
    try { await fs.access(path.join(candidate, c.id, 'verification.json')); source = path.join(candidate, c.id); } catch { /* another generation */ }
  }
  if (!source) throw Error(`Missing verified case: ${c.id}`);
  const verified = await exec(python, [path.join(root, 'tools/tutorials/verify.py'), c.id, source], { encoding: 'utf8' });
  const verification = JSON.parse(verified.stdout);
  const dest = path.join(output, c.id);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest);
  await fs.copyFile(path.join(root, 'LICENSE'), path.join(dest, 'LICENSE'));
  for (const name of await fs.readdir(source)) {
    if (name === 'vtk_output' || name === c.geometry || name === 'obstacle-channel.svg' || name.startsWith(c.geometry + '.') && !name.endsWith('.geo') ||
        /^(mesh(?:_case)?\.mdpa|mesh\.kratoscase\.json|ProjectParameters\.json|.*Materials\.json|MainKratos\.py)$/.test(name)) {
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
  await fs.writeFile(path.join(dest, 'README.txt'), `${c.title}\n\nOpen ${c.geometry} in KKSS Pre-Processing. Sidecars replay the documented geometry edits and named Parts.\nOpen mesh.mdpa in Post-Processing for the saved Problemtype setup.\nRun MainKratos.py with Kratos 10.4.3 and the required application, using OMP_NUM_THREADS=2.\nSee https://loumalouomega.github.io/KKSS/guide/tutorial-${c.id}\n\nverification.json records solver-produced results and SHA-256 hashes. Values are tutorial checks, not formal solver certification.\nGeometry source: ${c.source}; source and derived tutorial assets distributed under KKSS's AGPL-3.0-or-later license.\n`);
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
await exec(python, ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file() and p.suffix != '.zip':
   info=zipfile.ZipInfo(str(p.relative_to(root)), (2026,9,24,0,0,0))
   info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,p.read_bytes())
`, output, path.join(output, 'tutorial-cases.zip')]);
console.log('Published combined tutorial-cases.zip');
