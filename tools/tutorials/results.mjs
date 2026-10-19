// Where a tutorial case's solver output comes from. Solver output no longer
// ships (b9f83b1 removed the published vtk_output/ folders), so screenshots and
// GIFs read it from, in order:
//   1. KKSS_TUTORIAL_RESULTS/<case>/vtk_output (an explicit override),
//   2. a cache under node_modules/.cache filled from the last commit that did
//      ship the frames (b9f83b1^), byte for byte,
//   3. a local generation directory whose mesh hashes to the published record
//      (never chosen by recency: the mesh hash alone decides).
// Nothing read here is written back into doc/public.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const publishedDir = path.join(root, 'doc/public/examples/tutorials');
const cacheRoot = path.join(root, 'node_modules/.cache');
/** The last commit whose tree still carried every case's vtk_output/. */
export const LAST_SHIPPED = 'b9f83b1^';
/** The mesh whose sha256 names a generation (the published verification record hashes it). */
const HASH_FILE = { 'wind-tunnel': 'tunnel.mdpa' };
const git = (args, options = {}) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 512 * 1024 * 1024, ...options });

export function publishedVerification(id) {
  return JSON.parse(fs.readFileSync(path.join(publishedDir, id, 'verification.json'), 'utf8'));
}

export const hashFileFor = (id) => HASH_FILE[id] ?? 'mesh.mdpa';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** `FluidModelPart_0_12.vtk` → { family: 'FluidModelPart_0', index: 12 }. */
export function parseFrame(name) {
  const m = name.match(/^(.*)_(\d+)\.(vtk|vtu)$/);
  return m ? { family: m[1], index: Number(m[2]) } : null;
}

/** Frames of one result folder, grouped by family and sorted by step. */
export function groupFrames(names) {
  const families = new Map();
  for (const name of names) {
    const frame = parseFrame(name);
    if (!frame) continue;
    if (!families.has(frame.family)) families.set(frame.family, []);
    families.get(frame.family).push({ name, index: frame.index });
  }
  for (const list of families.values()) list.sort((a, b) => a.index - b.index);
  return families;
}

function blobAt(rev, file) {
  return git(['rev-parse', '--verify', '--quiet', `${rev}:${file}`], { encoding: 'utf8' }).trim();
}

/** True when the published mesh is byte-identical to the one the shipped frames came from. */
export function matchesShipped(id) {
  const hashFile = hashFileFor(id);
  const published = path.join(publishedDir, id, hashFile);
  if (!fs.existsSync(published)) return false;
  const current = git(['hash-object', published], { encoding: 'utf8' }).trim();
  const shipped = blobAt(LAST_SHIPPED, `doc/public/examples/tutorials/${id}/${hashFile}`);
  return current === shipped;
}

/** Local generation directories (node_modules/.cache/tutorials-*\/<id>) whose mesh hashes to the published record. */
export function localGenerations(id) {
  if (!fs.existsSync(cacheRoot)) return [];
  const hashFile = hashFileFor(id);
  const expected = publishedVerification(id).files?.[hashFile];
  if (!expected) return [];
  return fs.readdirSync(cacheRoot)
    .filter((name) => name.startsWith('tutorials-'))
    .map((name) => path.join(cacheRoot, name, id))
    .filter((dir) => fs.existsSync(path.join(dir, hashFile)) && sha256(path.join(dir, hashFile)) === expected);
}

function describe(dir, source, id) {
  const vtkDir = path.join(dir, 'vtk_output');
  const names = fs.existsSync(vtkDir) ? fs.readdirSync(vtkDir) : [];
  const families = groupFrames(names);
  const monitors = fs.readdirSync(dir).filter((n) => n.endsWith('.dat')).sort().map((n) => ({ name: n, path: path.join(dir, n) }));
  // `frames` in verification.json counts steps per family (fsi and cosim write
  // one VTK series per participant), so every family must match it.
  const expected = publishedVerification(id).frames;
  for (const [family, list] of families) {
    if (list.length !== expected) {
      throw new Error(`${id}: ${family} has ${list.length} frames in ${vtkDir}, the published record says ${expected}`);
    }
  }
  return { id, dir, vtkDir, source, families, monitors, expected };
}

/** Copies the shipped frames of one case into the cache, byte for byte. */
function fillFromGit(id, cache) {
  const folder = `doc/public/examples/tutorials/${id}/vtk_output`;
  const listed = git(['ls-tree', '-r', '--name-only', LAST_SHIPPED, '--', folder], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  if (!listed.length) throw new Error(`${id}: ${LAST_SHIPPED} has no ${folder}; set KKSS_TUTORIAL_RESULTS to a folder with vtk_output/`);
  fs.rmSync(path.join(cache, 'vtk_output'), { recursive: true, force: true });
  fs.mkdirSync(path.join(cache, 'vtk_output'), { recursive: true });
  for (const file of listed) {
    const bytes = git(['cat-file', 'blob', `${LAST_SHIPPED}:${file}`]);
    fs.writeFileSync(path.join(cache, 'vtk_output', path.basename(file)), bytes);
  }
  // Monitor files (.dat) never shipped in git; take them from a matching
  // local generation when one exists, and leave them out otherwise.
  const [local] = localGenerations(id);
  if (local) {
    for (const name of fs.readdirSync(local).filter((n) => n.endsWith('.dat'))) {
      fs.copyFileSync(path.join(local, name), path.join(cache, name));
    }
  }
  fs.writeFileSync(path.join(cache, 'provenance.json'), JSON.stringify({
    source: `git ${LAST_SHIPPED}`,
    files: listed.length,
    monitorsFrom: local ?? null,
  }, null, 2) + '\n');
}

/**
 * Returns { id, dir, vtkDir, source, families, frames, monitors, expected } for
 * one case, or throws with the exact command that would produce the output.
 */
export function resultsDir(id) {
  const override = process.env.KKSS_TUTORIAL_RESULTS && path.join(process.env.KKSS_TUTORIAL_RESULTS, id);
  if (override && fs.existsSync(path.join(override, 'vtk_output'))) return describe(override, 'override', id);

  if (matchesShipped(id)) {
    const cache = path.join(cacheRoot, 'kkss-tutorial-results', id);
    const names = fs.existsSync(path.join(cache, 'vtk_output')) ? fs.readdirSync(path.join(cache, 'vtk_output')) : [];
    const expected = publishedVerification(id).frames;
    const complete = names.length > 0 && [...groupFrames(names).values()].every((list) => list.length === expected);
    if (!complete) fillFromGit(id, cache);
    return describe(cache, 'git', id);
  }

  for (const dir of localGenerations(id)) {
    if (!fs.existsSync(path.join(dir, 'vtk_output'))) continue;
    return describe(dir, 'local', id);
  }
  if (process.env.KKSS_TUTORIAL_SOLVE === '1') return solveScratch(id);
  throw new Error(`${id}: no solver output. Either set KKSS_TUTORIAL_RESULTS to a folder holding ${id}/vtk_output, generate the case with \`node tools/tutorials/generate.mjs ${id}\`, or set KKSS_TUTORIAL_SOLVE=1 to solve it into a scratch folder.`);
}

/** Working directory a generate.mjs run announced ("Working directory: <dir>"), or null. */
export function workingDirectoryFrom(output) {
  const m = /^Working directory: (.+)$/m.exec(output);
  return m ? m[1].trim() : null;
}

/**
 * Opt-in last resort (KKSS_TUTORIAL_SOLVE=1): generates and solves the case
 * into a fresh scratch generation. The mesh may differ slightly from the
 * published one, so the frame count is checked but the mesh hash is not.
 */
function solveScratch(id) {
  const output = execFileSync(process.execPath, [path.join(root, 'tools/tutorials/generate.mjs'), id], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  const work = workingDirectoryFrom(output);
  const dir = work && path.join(work, id);
  if (!dir || !fs.existsSync(path.join(dir, 'vtk_output'))) {
    throw new Error(`${id}: the scratch solve produced no vtk_output (generate.mjs output follows)\n${output.slice(-2000)}`);
  }
  return describe(dir, 'scratch', id);
}

/**
 * Eigenvalue runs write GiD results (EigenResults/*.post.bin), not VTK, and
 * git never kept them. Only a local generation of the same mesh can supply
 * them, so this lookup has no git provider.
 */
export function eigenResultsDir(id = 'eigen') {
  const override = process.env.KKSS_TUTORIAL_RESULTS && path.join(process.env.KKSS_TUTORIAL_RESULTS, id, 'EigenResults');
  const candidates = [override, ...localGenerations(id).map((dir) => path.join(dir, 'EigenResults'))].filter(Boolean);
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.post.bin')).sort();
    if (files.length) return { dir, files, source: dir === override ? 'override' : 'local' };
  }
  throw new Error(`${id}: no EigenResults/*.post.bin. Set KKSS_TUTORIAL_RESULTS to a folder holding ${id}/EigenResults, or generate the case with \`node tools/tutorials/generate.mjs ${id}\`.`);
}
