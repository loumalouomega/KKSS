import fs from 'node:fs';
import { scenario, assert, selectFile, until, menu } from './context.mjs';

// Small, deterministic fixtures: two property regions and a linear nodal field.
const nodes = '1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n5 1 1 1';
const mdpa = `Begin ModelPartData\nEnd ModelPartData
Begin Properties 1\nDENSITY 1000\nEnd Properties
Begin Properties 2\nDENSITY 2000\nEnd Properties
Begin Nodes\n${nodes}\nEnd Nodes
Begin Elements Element3D4N\n1 1 1 2 3 4\n2 2 2 3 4 5\nEnd Elements
Begin NodalData TEMPERATURE\n1 0 0\n2 0 1\n3 0 1\n4 0 1\n5 0 3\nEnd NodalData
`;
const vtk = offset => `# vtk DataFile Version 3.0
Probe fixture
ASCII
DATASET UNSTRUCTURED_GRID
POINTS 5 float
0 0 0  1 0 0  0 1 0  0 0 1  1 1 1
CELLS 2 10
4 0 1 2 3
4 1 2 3 4
CELL_TYPES 2
10 10
POINT_DATA 5
SCALARS TEMPERATURE float 1
LOOKUP_TABLE default
${[0, 1, 1, 1, 3].map(v => v + offset).join(' ')}
`;

await scenario('mesh-submodule-features', async c => {
  const file = `${c.dir}/regions.mdpa`;
  fs.writeFileSync(file, mdpa);
  const app = await c.launch(file);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      const overwrite = options.buttons?.indexOf('Overwrite') ?? -1;
      if (overwrite < 0) throw new Error(`Unexpected dialog: ${options.message}`);
      return { response: overwrite, checkboxChecked: false };
    };
  });
  const mesh = await c.page(app, 'mesh');
  await mesh.locator('#doc-chip-name').getByText('regions.mdpa', { exact: true }).waitFor();
  await mesh.locator('#toolbar [data-action="selection"]').click();
  const selection = mesh.locator('#selection-panel');
  await selection.getByRole('button', { name: 'Box', exact: true }).click();
  const canvas = await mesh.locator('#render-root canvas').first().boundingBox();
  await mesh.mouse.move(canvas.x + canvas.width * .35, canvas.y + canvas.height * .35);
  await mesh.mouse.down();
  await mesh.mouse.move(canvas.x + canvas.width * .65, canvas.y + canvas.height * .65, { steps: 5 });
  await mesh.mouse.up();
  await mesh.locator('#sel-seed-kind').selectOption('property');
  await mesh.locator('#sel-seed-prop').fill('1');
  await selection.getByRole('button', { name: 'Add set', exact: true }).click();
  await until(async () => (await selection.locator('.sel-set-name').last().textContent()).endsWith('— 1'), 'property seed selects one element');

  const exported = `${c.dir}/selection.mdpa`;
  await selectFile(app, exported, true);
  await selection.getByRole('button', { name: 'Export', exact: true }).click();
  const picker = await c.page(app, 'picker');
  await picker.getByRole('option').filter({ hasText: '.mdpa' }).click();
  await until(() => fs.existsSync(exported) && fs.readFileSync(exported, 'utf8').includes('End Elements'), 'selection export writes through the native dialog');
  const selectedText = fs.readFileSync(exported, 'utf8');
  assert.match(selectedText, /1\s+1\s+1\s+2\s+3\s+4/);
  assert.doesNotMatch(selectedText, /2\s+2\s+2\s+3\s+4\s+5/);
  assert.match(selectedText, /TEMPERATURE/);

  await mesh.locator('#sel-smp-name').fill('Selected');
  await selection.getByRole('button', { name: 'New SubModelPart', exact: true }).click();
  await until(async () => await mesh.locator('#sidebar option[value="Selected"]').count() > 0, 'selection creates a SubModelPart');
  await menu(app, 'Save');
  await until(() => fs.readFileSync(file, 'utf8').includes('Begin SubModelPart Selected'), 'SubModelPart persisted');
  await mesh.locator('#sel-seed-name').fill('Draft selection');
  const beforeDelete = await mesh.locator('#sb-count-model').textContent();
  await selection.getByRole('button', { name: 'Delete entities', exact: true }).click();
  await until(async () => await mesh.locator('#sb-count-model').textContent() !== beforeDelete, 'entity removed from model');
  await until(async () => (await selection.locator('.sel-set-name').last().textContent()).endsWith('— 0'), 'deleted selection becomes empty');
  assert.equal(await selection.getByRole('button', { name: 'Export', exact: true }).isDisabled(), true);
  assert.equal(await mesh.locator('#sel-seed-name').inputValue(), 'Draft selection');
  await mesh.locator('#sel-seed-name').focus();
  await menu(app, 'Undo Mesh Operation');
  await until(async () => await mesh.locator('#sb-count-model').textContent() === beforeDelete, 'undo restores model counts');
  await until(async () => (await selection.locator('.sel-set-name').last().textContent()).endsWith('— 1'), 'undo restores deleted entity');
  assert.equal(await selection.getByRole('button', { name: 'Export', exact: true }).isEnabled(), true);
  assert.equal(await mesh.locator('#sel-seed-name').inputValue(), 'Draft selection');
  assert.equal(await mesh.locator('#sel-seed-name').evaluate(el => document.activeElement === el), true);
  await menu(app, 'Redo Mesh Operation');
  await until(async () => (await selection.locator('.sel-set-name').last().textContent()).endsWith('— 0'), 'redo updates selection immediately');
  await menu(app, 'Undo Mesh Operation');
  await until(async () => (await selection.locator('.sel-set-name').last().textContent()).endsWith('— 1'), 'undo restores selection again');
  await menu(app, 'Reload from Disk');
  await until(async () => (await selection.locator('.sel-set-name').last().textContent()).endsWith('— 1'), 'reload preserves resolved selection');
  await selection.getByTitle('Close', { exact: true }).click();

  await mesh.locator('[data-action="advanced"]').click();
  await mesh.locator('[data-action="propertiesEditor"]').click();
  const density = mesh.locator('input[data-prop-id="1"][data-prop-name="DENSITY"]');
  await density.fill('2700');
  await density.press('Enter');
  await until(async () => await density.inputValue() === '2700', 'property edit rendered');
  await menu(app, 'Save');
  await until(() => /DENSITY\s+2700/.test(fs.readFileSync(file, 'utf8')), 'property edit persisted');
  await menu(app, 'Reload from Disk');
  await until(async () => await density.inputValue() === '2700', 'property value survives reload');

  // A second document exercises the VTK provider and per-frame probe requests.
  for (let step = 0; step < 2; step++) fs.writeFileSync(`${c.dir}/Probe_0_${step}.vtk`, vtk(step * 10));
  const shell = await c.page(app, 'shell');
  await selectFile(app, `${c.dir}/Probe_0_0.vtk`);
  await shell.locator('#open-btn').click();
  let series;
  await until(async () => {
    for (const p of app.windows().filter(p => p.url().includes('/renderer/mesh/'))) {
      if (await p.locator('#doc-chip-name').textContent().catch(() => '') === 'Probe_0_0.vtk') { series = p; return true; }
    }
    return false;
  }, 'probe fixture opens');
  await series.evaluate(() => {
    window.probeReplies = [];
    window.addEventListener('message', e => {
      if (e.data?.type === 'meshAnalysisResult' && e.data.kind === 'probe') window.probeReplies.push(e.data);
    });
  });
  await series.locator('#toolbar [data-action="reset"]').click();
  await menu(app, 'Toggle Node IDs');
  await series.locator('#labels .node-label').first().waitFor();
  await series.locator('#toolbar [data-action="inspect"]').click();
  await series.locator('#inspect-panel').getByRole('button', { name: 'Probe line', exact: true }).click();
  // Node labels expose the live camera projection. Some labels are behind the
  // front surface and therefore are not pickable; try projected vertices until
  // the actual vtk.js picker accepts two, rather than assuming every label is
  // visible from the default camera.
  const points = await series.locator('#labels .node-label').evaluateAll(labels => labels.map(el => {
      const parent = el.parentElement.getBoundingClientRect();
      return { id: el.textContent, x: parent.x + parseFloat(el.style.left), y: parent.y + parseFloat(el.style.top) };
  }));
  for (const point of points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'node projection is ready');
    await series.mouse.click(point.x, point.y);
    if (await series.locator('#probe-panel').isVisible()) break;
  }
  assert.equal(await series.locator('#probe-panel').isVisible(), true, 'vtk.js accepts two visible vertex picks');
  await until(async () => await series.evaluate(() => window.probeReplies.some(r => r.probe?.covered > 0)), 'probe sampled by the host').catch(async error => {
    const diagnostic = await series.evaluate(() => ({
      replies: window.probeReplies,
      panel: document.querySelector('#probe-panel')?.textContent,
      inspect: document.querySelector('#inspect-panel')?.textContent,
      labels: [...document.querySelectorAll('#labels .node-label')].map(label => ({ text: label.textContent, left: label.style.left, top: label.style.top })),
    }));
    throw new Error(`${error.message}; probe diagnostic: ${JSON.stringify(diagnostic)}`);
  });
  const first = await series.evaluate(() => window.probeReplies.at(-1).probe);
  assert.equal(first.rows.length, 101);
  assert.equal(first.uncovered, 0);
  for (const row of first.rows) {
    assert.ok(Math.abs(row.values[0] - row.position.reduce((sum, v) => sum + v, 0)) < 1e-5,
      'probe interpolates the known linear nodal field');
  }
  const csv = `${c.dir}/probe.csv`;
  await selectFile(app, csv, true);
  await series.locator('#probe-panel').getByRole('button', { name: 'CSV', exact: true }).click();
  await until(() => fs.existsSync(csv) && fs.readFileSync(csv, 'utf8').trim().split('\n').length === 102, 'probe CSV written');
  const lines = fs.readFileSync(csv, 'utf8').trim().split('\n');
  assert.equal(lines.length, 102);
  assert.match(lines[0], /distance,x,y,z,TEMPERATURE/);
  assert.ok(Math.abs(Number(lines[1].split(',').at(-1)) - first.rows[0].values[0]) < 1e-5);
  await series.locator('#tl-next').click();
  await until(async () => await series.evaluate(() => window.probeReplies.length >= 2 && window.probeReplies.at(-1).probe?.rows[0].values[0] >= 10), 'timeline resamples probe');
  const second = await series.evaluate(() => window.probeReplies.at(-1).probe);
  assert.equal(second.rows.length, first.rows.length);
  for (let i = 0; i < first.rows.length; i++) {
    assert.ok(Math.abs(second.rows[i].values[0] - first.rows[i].values[0] - 10) < 1e-5);
  }
  const probeBeforeStale = await series.locator('#probe-panel').textContent();
  await series.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { ...window.probeReplies[0], message: 'STALE REPLY MUST NOT RENDER' } })));
  assert.equal(await series.locator('#probe-panel').textContent(), probeBeforeStale, 'old probe reply cannot replace the current profile');
  await series.locator('#probe-panel').getByTitle('Close', { exact: true }).click();
  await series.locator('#tl-prev').click();
  await series.locator('#toolbar [data-action="selection"]').click();
  const timelineSelection = series.locator('#selection-panel');
  await timelineSelection.getByRole('button', { name: 'Box', exact: true }).click();
  const seriesCanvas = await series.locator('#render-root canvas').first().boundingBox();
  await series.mouse.move(seriesCanvas.x + seriesCanvas.width * .35, seriesCanvas.y + seriesCanvas.height * .35);
  await series.mouse.down();
  await series.mouse.move(seriesCanvas.x + seriesCanvas.width * .65, seriesCanvas.y + seriesCanvas.height * .65, { steps: 5 });
  await series.mouse.up();
  await series.locator('#sel-seed-kind').selectOption('field');
  await series.locator('#sel-seed-field').selectOption('TEMPERATURE');
  await series.locator('#sel-seed-lo').fill('0');
  await series.locator('#sel-seed-hi').fill('3');
  await timelineSelection.getByRole('button', { name: 'Add set', exact: true }).click();
  await until(async () => (await timelineSelection.locator('.sel-set-name').last().textContent()).endsWith('— 2'), 'field seed selects both cells');
  await series.locator('#sel-seed-name').fill('Timeline draft');
  await series.locator('#tl-next').click();
  await until(async () => (await timelineSelection.locator('.sel-set-name').last().textContent()).endsWith('— 0'), 'field seed refreshes on the next frame');
  assert.equal(await series.locator('#sel-seed-name').inputValue(), 'Timeline draft');
  assert.equal(await timelineSelection.getByRole('button', { name: 'Export', exact: true }).isDisabled(), true);
  const reopenedApp = await c.launch(file);
  const reopened = await c.page(reopenedApp, 'mesh');
  await reopened.locator('#doc-chip-name').getByText('regions.mdpa', { exact: true }).waitFor();
  await reopened.locator('[data-action="advanced"]').click();
  await reopened.locator('[data-action="propertiesEditor"]').click();
  await until(async () => await reopened.locator('input[data-prop-id="1"][data-prop-name="DENSITY"]').inputValue() === '2700',
    'fresh application reads the saved property value');

});
