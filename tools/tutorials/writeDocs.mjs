#!/usr/bin/env node
// Renders the generated islands of the tutorial pages from each case's
// published verification record (see docIslands.mjs). The prose of a page is
// hand-written and is never touched here.
//
//   node tools/tutorials/writeDocs.mjs          rewrite the islands in place
//   node tools/tutorials/writeDocs.mjs --check  exit 1 if any island is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glanceIsland, islandsIn, replaceIsland, verifiedIsland } from './docIslands.mjs';

// The repo root, computed here: mcp.mjs (which carries the MCP SDK) is not needed to render pages.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const publishedDir = path.join(root, 'doc/public/examples/tutorials');
const guideDir = path.join(root, 'doc/guide');

/** Tutorial id → its page. The coupled case is linked as tutorial-cosimulation everywhere. */
export const PAGES = {
  structural: 'tutorial-structural.md',
  eigen: 'tutorial-eigen.md',
  fluid: 'tutorial-fluid.md',
  rans: 'tutorial-rans.md',
  thermal: 'tutorial-thermal.md',
  'potential-flow': 'tutorial-potential-flow.md',
  'shallow-water': 'tutorial-shallow-water.md',
  fsi: 'tutorial-fsi.md',
  cosim: 'tutorial-cosimulation.md',
  'wind-tunnel': 'tutorial-wind-tunnel.md',
  'two-fluids': 'tutorial-two-fluids.md',
};

/** The rendered page for one tutorial, from the page's own text. */
export function renderPage(id, markdown) {
  const report = JSON.parse(fs.readFileSync(path.join(publishedDir, id, 'verification.json'), 'utf8'));
  const download = `/examples/tutorials/${id}.zip`;
  const bodies = { glance: glanceIsland(report, { id, download }), verified: verifiedIsland(report) };
  let out = markdown;
  for (const name of islandsIn(markdown)) out = replaceIsland(out, name, bodies[name]);
  const missing = ['glance', 'verified'].filter((name) => !islandsIn(markdown).includes(name));
  if (missing.length) throw new Error(`${id}: the page has no ${missing.join(' or ')} island`);
  return out;
}

/** Renders every page; returns the pages whose text would change. */
export function renderAll() {
  const changed = [];
  for (const [id, file] of Object.entries(PAGES)) {
    const target = path.join(guideDir, file);
    const before = fs.readFileSync(target, 'utf8');
    const after = renderPage(id, before);
    if (after !== before) changed.push({ id, target, after });
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check');
  const changed = renderAll();
  if (check) {
    if (changed.length) {
      console.error(`writeDocs: stale islands in ${changed.map((c) => path.relative(root, c.target)).join(', ')}; run node tools/tutorials/writeDocs.mjs`);
      process.exitCode = 1;
    } else console.log('writeDocs: every island is current');
  } else {
    for (const { target, after } of changed) fs.writeFileSync(target, after);
    console.log(`writeDocs: ${changed.length} page${changed.length === 1 ? '' : 's'} updated`);
  }
}
