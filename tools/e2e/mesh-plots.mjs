import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scenario, assert, menu, selectFile, until, root } from './context.mjs';

export const meshPlotsScenario = screenshotDir => scenario('mesh-plots', async c => {
  const base = path.join(root, 'doc/public/examples/tutorials');
  const file = path.join(base, 'fluid/vtk_output/FluidModelPart_0_1.vtk');
  const app = await c.launch(file);
  if (screenshotDir) await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setSize(1800, 1200));
  const page = await c.page(app, 'mesh');
  const errors = [];
  const observe = p => {
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && /Content Security Policy|vscodeShim|plotWorker|ERR_FILE/.test(m.text())) errors.push(m.text()); });
  };
  observe(page);
  await page.locator('#doc-chip-name').getByText(path.basename(file), { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => !!window.Plotly), false, 'Plotly must load only on demand');
  await page.locator('#toolbar [data-action="plots"]').click();
  await page.locator('#plot-app[data-plot-ready="true"]').waitFor();
  const load = async (p, recipe) => {
    const spec = JSON.parse(fs.readFileSync(recipe, 'utf8'));
    const expected = spec.series.reduce((sum, s) => {
      const source = spec.sources.find(v => v.id === s.source);
      return sum + (source.times?.length ?? source.samples ?? source.table?.rows.length ?? 1);
    }, 0);
    await selectFile(app, recipe);
    await p.getByRole('button', { name: 'Load recipe', exact: true }).click();
    await until(async () => (await p.locator('#plot-status').textContent()).startsWith(`${expected} full-resolution points`) &&
      await p.locator('#plot-chart').evaluate((el, target) => el.layout?.title?.text === target.title && el.data?.reduce((sum, t) => sum+t.y.length, 0) === target.count, { title: spec.presentation.title, count: expected }), 'plot collection', 60_000);
    await p.locator('#plot-chart .main-svg').first().waitFor();
  };
  const pressure = path.join(base, 'fluid/plots/pressure-history.json');
  await load(page, pressure);
  await page.locator('#toolbar [data-action="reset"]').click();
  const curves = await page.locator('#plot-chart').evaluate(el => el.data.map(t => ({ name: t.name, x: t.x, y: t.y })));
  assert.equal(curves.length, 2);
  assert.equal(curves[0].x.length, 51);
  assert.equal(curves[0].x[0], 0.1);
  assert.equal(curves[0].x.at(-1), 5.1);
  assert.equal(curves[0].y[0], 2697.7852);
  assert.equal(curves[0].y.at(-1), 9.2801962);
  assert.equal(curves[1].y.at(-1), -4.189086);
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'tutorial-fluid-pressure-history.png') });
  await page.locator('#plot-orient').click();
  assert.equal(await page.locator('#plot-resizer').getAttribute('aria-orientation'), 'horizontal');
  await page.locator('#plot-resizer').focus();
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#plot-resizer').getAttribute('aria-valuenow'), '20');
  await page.locator('#plot-hide').click();
  await page.locator('#plot-restore').click();
  assert.equal(await page.locator('#plot-chart').evaluate(el => el.data.length), 2, 'collapse must retain curves');
  await page.locator('#plot-orient').click();
  const csv = path.join(c.dir, 'pressure.csv');
  await selectFile(app, csv, true);
  await page.getByRole('button', { name: 'CSV + metadata', exact: true }).click();
  await until(() => fs.existsSync(csv+'.kratosplot.json'), 'CSV and provenance export');
  assert.ok(fs.readFileSync(csv, 'utf8').includes('2697.7852'));
  const svg = path.join(c.dir, 'pressure.svg');
  await selectFile(app, svg, true);
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  await until(() => fs.existsSync(svg+'.kratosplot.json'), 'SVG and provenance export');
  assert.ok(fs.readFileSync(svg, 'utf8').includes('<svg'));
  const saved = path.join(c.dir, 'saved.json');
  await selectFile(app, saved, true);
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await until(() => fs.existsSync(saved), 'recipe save');
  await load(page, saved);
  // Standalone tables/recipes use the same controller, but a separate scoped bridge.
  await menu(app, 'Scientific Plot Builder…');
  let standalone;
  await until(() => { standalone = app.windows().find(p => p.url().endsWith('/mesh/plots.html')); return !!standalone; }, 'standalone plotting window');
  observe(standalone);
  await standalone.locator('#plot-app[data-plot-ready="true"]').waitFor();
  await load(standalone, pressure);
  assert.equal(await standalone.locator('#plot-chart').evaluate(el => el.data[0].y.at(-1)), 9.2801962);
  if (screenshotDir) await standalone.screenshot({ path: path.join(screenshotDir, 'scientific-plot-builder.png') });
  // Every published FEM recipe also executes through the staged host worker.
  for (const [name, recipe, count, last, shot] of [
    ['structural', 'displacement-history', 8, 0.00058914793, 'tutorial-structural-displacement-plot.png'],
    ['structural', 'reaction-history', 8, -7.2000323117999905],
    ['thermal', 'temperature-profile', 60, undefined, 'tutorial-thermal-profile.png'],
    ['potential-flow', 'potential-profile', 60, undefined, 'tutorial-potential-flow-profile.png'],
    ['shallow-water', 'depth-history', 8, 1, 'tutorial-shallow-water-depth-plot.png'],
  ]) {
    await load(standalone, path.join(base, name, `plots/${recipe}.json`));
    const values = await standalone.locator('#plot-chart').evaluate(el => [...el.data[0].y]);
    assert.equal(values.length, count);
    if (last !== undefined) assert.ok(Math.abs(values.at(-1)-last) < 1e-10, `${name}/${recipe}: expected ${last}, got ${values.at(-1)}`);
    if (screenshotDir && shot) await standalone.screenshot({ path: path.join(screenshotDir, shot) });
  }
  await standalone.getByRole('button', { name: 'Chart type', exact: true }).click();
  assert.equal(await standalone.locator('#plot-type-picker [data-family]').count(), 12);
  await standalone.locator('#plot-type-picker [data-family="scatter"]').click();
  await until(async () => await standalone.locator('#plot-chart').evaluate(el => el.data?.[0]?.mode === 'markers'), 'scatter picker retains samples');
  const png = path.join(c.dir, 'depth.png');
  await selectFile(app, png, true);
  await standalone.getByRole('button', { name: 'PNG', exact: true }).click();
  await until(() => fs.existsSync(png+'.kratosplot.json'), 'PNG and provenance export');
  assert.equal(fs.readFileSync(png).subarray(1,4).toString(), 'PNG');
  await standalone.close();
  assert.equal(await page.locator('#plot-chart').evaluate(el => el.data.length), 2);
  // A profile owned by the final frame can follow the actual preview timeline.
  await menu(app, 'New Mesh Tab');
  const final = path.join(base, 'fluid/vtk_output/FluidModelPart_0_51.vtk');
  await selectFile(app, final); await menu(app, 'Open…');
  let profile;
  await until(async () => {
    for (const p of app.windows().filter(p => p.url().endsWith('/mesh/index.html'))) {
      if (await p.locator('#doc-chip-name').textContent().catch(() => '') === path.basename(final)) { profile = p; return true; }
    }
    return false;
  }, 'final-frame preview');
  observe(profile);
  await profile.locator('#tl-scrub').evaluate(el => { el.value = '50'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => (await profile.locator('#tl-label').textContent()).includes('51/51'), 'last displayed frame');
  await profile.locator('#toolbar [data-action="plots"]').click();
  await profile.locator('#plot-app[data-plot-ready="true"]').waitFor();
  await load(profile, path.join(base, 'fluid/plots/wake-profile.json'));
  await profile.locator('#toolbar [data-action="reset"]').click();
  const before = await profile.locator('#plot-chart').evaluate(el => [...el.data[0].y]);
  assert.equal(before.length, 80); assert.ok(Math.min(...before) < 0);
  if (screenshotDir) await profile.screenshot({ path: path.join(screenshotDir, 'tutorial-fluid-wake-profile.png') });
  await profile.getByRole('button', { name: 'Follow timeline', exact: true }).click();
  const timeline = profile.locator('#tl-scrub');
  await timeline.evaluate(el => { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await until(async () => {
    const after = await profile.locator('#plot-chart').evaluate(el => el.data?.[0]?.y);
    return after && JSON.stringify(after) !== JSON.stringify(before);
  }, 'profile follows timeline', 60_000);
  assert.equal(await page.locator('#plot-chart').evaluate(el => el.data.length), 2, 'another tab retains its plot');
  // Real receipt/parser/provider flow with explicitly synthetic test outputs.
  // No fixture receipt is added to the published solver examples.
  const owned = path.join(c.dir, 'owned'); fs.mkdirSync(owned);
  const input = path.join(owned, 'input.mdpa'); fs.writeFileSync(input, 'Begin Nodes\n1 0 0 0\nEnd Nodes\n');
  const vtk = value => `# vtk DataFile Version 3.0\nSynthetic navigation fixture\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n0 0 0\n1 0 0\n0 1 0\nCELLS 1 4\n3 0 1 2\nCELL_TYPES 1\n5\nPOINT_DATA 3\nSCALARS PRESSURE float 1\nLOOKUP_TABLE default\n${value} ${value+1} ${value+2}\n`;
  const results = [0,1].map(i => { const f = path.join(owned, `Owned_0_${i}.vtk`); fs.writeFileSync(f, vtk(1+3*i)); return f; });
  const revision = file => 'sha256:' + createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const recordPath = path.join(owned, '.kkss-execution.json');
  fs.writeFileSync(recordPath, JSON.stringify({ version: 1, ownerId: 'fixture-study', requestId: 'fixture-request', jobId: 'fixture-run', state: 'succeeded', runDirectory: owned, meshPath: input, createdAt: 1, updatedAt: 2,
    artifacts: [{ role: 'mesh', path: input, revision: revision(input) }, ...results.map(file => ({ role: 'result', path: file, revision: revision(file) }))] }));
  const client = new Client({ name: 'kkss-plot-navigation-fixture', version: '1.0' });
  let binding;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'out/mcpServer.js')], cwd: owned }));
    const reply = await client.callTool({ name: 'plot_run_bind', arguments: { recordPath, path: results[0] } });
    assert.ok(!reply.isError, JSON.stringify(reply.content));
    binding = JSON.parse(reply.content.find(c => c.type === 'text').text);
  } finally { await client.close(); }
  const boundRecipe = path.join(owned, 'history.json');
  fs.writeFileSync(boundRecipe, JSON.stringify({ version: 1, sources: [{ id: 'owned', type: 'history', path: results[0], kind: 'Nodal', entityId: 1, variable: 'PRESSURE', times: [0,0.2], timeUnit: 's', run: binding }],
    series: [{ id: 'owned', source: 'owned', name: 'Verified fixture point', x: 'time', y: 'v0' }], presentation: { family: 'line', title: 'Verified fixture navigation' } }));
  await menu(app, 'Scientific Plot Builder…');
  await until(() => { standalone = app.windows().find(p => p.url().endsWith('/mesh/plots.html')); return !!standalone; }, 'navigation plot window');
  observe(standalone);
  await standalone.locator('#plot-app[data-plot-ready="true"]').waitFor();
  await load(standalone, boundRecipe);
  await standalone.locator('summary').filter({ hasText: 'Plotted samples' }).click();
  const countBefore = app.windows().filter(p => p.url().endsWith('/mesh/index.html')).length;
  await standalone.getByRole('button', { name: 'Show in mesh', exact: true }).last().click();
  let target;
  await until(async () => {
    for (const p of app.windows().filter(p => p.url().endsWith('/mesh/index.html'))) {
      if (await p.locator('#doc-chip-name').textContent().catch(() => '') === path.basename(results[0])) { target = p; return (await p.locator('#tl-label').textContent()).includes('2/2'); }
    }
    return false;
  }, 'exact owning result opens in a new tab', 60_000);
  assert.equal(app.windows().filter(p => p.url().endsWith('/mesh/index.html')).length, countBefore+1);
  assert.equal(await page.locator('#plot-chart').evaluate(el => el.data.length), 2);
  assert.equal(await profile.locator('#doc-chip-name').textContent(), path.basename(final));
  // The second navigation reuses, never reloads/replaces, the owning tab.
  await standalone.getByRole('button', { name: 'Show in mesh', exact: true }).first().click();
  await until(async () => (await target.locator('#tl-label').textContent()).includes('1/2'), 'reuse owning preview');
  assert.equal(app.windows().filter(p => p.url().endsWith('/mesh/index.html')).length, countBefore+1);
  fs.appendFileSync(results[1], '\n');
  await standalone.getByRole('button', { name: 'Show in mesh', exact: true }).last().click();
  await until(async () => /revision missing or changed|ownership.*stale|identity changed/i.test(await standalone.locator('#plot-status').textContent()), 'changed run refuses navigation');
  assert.ok((await target.locator('#tl-label').textContent()).includes('1/2'));
  await standalone.close();
  assert.deepEqual(errors, []);
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await meshPlotsScenario(process.argv.includes('--screenshots') ? path.join(root, 'doc/public/screenshots') : undefined);
}
