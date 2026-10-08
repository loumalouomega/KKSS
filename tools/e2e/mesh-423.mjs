import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scenario, assert, selectFile, until, menu, root, softwareGL } from './context.mjs';
import { clickPickerOption } from './picker.mjs';

// A unit-area duct, constant +X velocity, outward-wound inlet/outlet faces.
// Imports deliberately overlap it: Import is NOT an implicit weld.
const duct = `Begin Nodes
1 0 0 0
2 4 0 0
3 4 1 0
4 0 1 0
5 0 0 1
6 4 0 1
7 4 1 1
8 0 1 1
End Nodes
Begin Elements Element3D4N
1 0 1 2 3 7
2 0 1 3 4 7
3 0 1 4 8 7
4 0 1 8 5 7
5 0 1 5 6 7
6 0 1 6 2 7
End Elements
Begin Conditions Condition3D3N
1 0 1 5 8
2 0 1 8 4
3 0 2 3 7
4 0 2 7 6
End Conditions
${['Inlet', 'Outlet'].map((name, i) => `Begin SubModelPart ${name}
Begin SubModelPartNodes
${i ? '2\n3\n6\n7' : '1\n4\n5\n8'}
End SubModelPartNodes
Begin SubModelPartConditions
${i ? '3\n4' : '1\n2'}
End SubModelPartConditions
End SubModelPart`).join('\n')}
Begin NodalData VELOCITY
${Array.from({ length: 8 }, (_, i) => `${i + 1} 0 (1,0,0)`).join('\n')}
End NodalData
Begin NodalData PRESSURE
${Array.from({ length: 8 }, (_, i) => `${i + 1} 0 ${[10, 2, 2, 10, 10, 2, 2, 10][i]}`).join('\n')}
End NodalData
`;

async function fixtureTools(dir, run) {
  const client = new Client({ name: 'kkss-acceptance-fixtures', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'out/mcpServer.js')], cwd: dir });
  try {
    await client.connect(transport);
    await run(async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result.content));
    });
  } finally { await client.close(); }
}

async function openDocument(c, app, file) {
  // Generate opens ProjectParameters in the text editor; switch back before
  // using the mode-specific Open menu.
  const shell = await c.page(app, 'shell');
  await shell.locator('#mode-mesh').click();
  // Keep prior documents/history: Open normally replaces the active tab and
  // would correctly prompt before discarding its unsaved operation history.
  await menu(app, 'New Mesh Tab');
  await selectFile(app, file);
  await menu(app, 'Open…');
  let page;
  await until(async () => {
    for (const candidate of app.windows().filter(p => p.url().includes('/renderer/mesh/'))) {
      if (await candidate.locator('#doc-chip-name').textContent().catch(() => '') === path.basename(file)) {
        page = candidate; return true;
      }
    }
    return false;
  }, `open ${file}`);
  return page;
}

async function advanced(page, action) {
  await page.locator('#toolbar [data-action="advanced"]').click();
  await page.locator(`#advanced-popup [data-action="${action}"]`).click();
}

export const mesh423Scenario = (screenshotDir) => scenario('mesh-423', async c => {
  const capture = async (page, name, selector) => {
    if (!screenshotDir) return;
    await page.mouse.move(0, 0);
    await page.locator(selector).screenshot({ path: path.join(screenshotDir, name) });
  };
  const file = path.join(c.dir, 'duct.mdpa');
  fs.writeFileSync(file, duct);
  const imported = [1, 2].map(i => path.join(c.dir, `import-${i}.mdpa`));
  for (const f of imported) fs.writeFileSync(f, duct);
  // MDPA numbered series retain the boundary SubModelParts needed for flow
  // sections; VTU intentionally cannot carry those names as native sets.
  const seriesFiles = [0, 1].map(i => path.join(c.dir, `Flow_0_${i}.mdpa`));
  for (const f of seriesFiles) fs.writeFileSync(f, duct);
  const foamDir = path.join(c.dir, 'foam');
  fs.mkdirSync(foamDir);
  const foam = path.join(foamDir, 'case.foam');
  await fixtureTools(c.dir, async call => {
    await call('mesh_convert', { path: file, outputPath: foam });
  });
  fs.mkdirSync(path.join(foamDir, '0'));
  for (const [name, dims, value] of [['p', '0 2 -2 0 0 0 0', 1], ['rho', '1 -3 0 0 0 0 0', 1000]]) {
    fs.writeFileSync(path.join(foamDir, '0', name), `FoamFile { version 2.0; format ascii; class volScalarField; object ${name}; }
dimensions [${dims}];
internalField uniform ${value};
`);
  }
  c.seed({ 'kratos.export.provenance': 'sidecar', meshExportOverwriteWarned: true });
  const app = await c.launch(file, screenshotDir ? { extraArgs: [...softwareGL, '--force-device-scale-factor=2'] } : {});
  // Native dialogs are outside Playwright's DOM; choose only expected actions.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      const response = options.buttons.findIndex(b => b === 'Show report' || b === 'Overwrite');
      if (response < 0) throw new Error(`Unexpected native dialog: ${options.message}`);
      return { response, checkboxChecked: false };
    };
  });
  const mesh = await c.page(app, 'mesh');
  const errors = [];
  const observe = page => {
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|vscodeShim|streamlineWorker/.test(m.text())) errors.push(m.text()); });
  };
  observe(mesh);
  await mesh.locator('#doc-chip-name').getByText('duct.mdpa', { exact: true }).waitFor();
  const originalCounts = await mesh.locator('#sb-count-model').textContent();
  const nativeMenu = () => app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu().items.find(i => i.label === '&File').submenu;
    const imports = file.items.find(i => i.label === 'Import Mesh…');
    const exports = file.items.find(i => i.label === 'Export Mesh As');
    return { importEnabled: imports.enabled, exportEnabled: exports.enabled,
      groups: exports.submenu.items.map(i => i.label),
      shortcut: file.items.find(i => i.label === 'Export…').accelerator };
  });
  assert.deepEqual((await nativeMenu()).groups, ['Structural CAE', 'Kratos', 'VTK', 'Surface', 'Solvers', 'HDF5 / netCDF', 'Fields', 'Figures']);
  assert.equal((await nativeMenu()).shortcut, 'CmdOrCtrl+E');
  const shell = await c.page(app, 'shell');
  await shell.locator('#home-btn').click();
  await until(async () => !(await nativeMenu()).importEnabled && !(await nativeMenu()).exportEnabled, 'mesh-only native actions disabled on Home');
  await menu(app, 'Post-Processing (Mesh)');
  await until(async () => (await nativeMenu()).importEnabled && (await nativeMenu()).exportEnabled, 'native actions enabled on active mesh');
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await menu(app, 'Import Mesh…');
  assert.equal(await mesh.locator('#sb-count-model').textContent(), originalCounts, 'cancelled import changes nothing');
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1);
      if (!options.properties.includes('multiSelections')) throw new Error('Import must allow multiple files');
      return { canceled: false, filePaths: files };
    };
  }, imported);
  await menu(app, 'Import Mesh…');
  await until(async () => /24 nodes/.test(await mesh.locator('#sb-count-model').textContent()), 'both files imported without welding');
  assert.match(await mesh.locator('#doc-chip-unsaved').textContent(), /1 unsaved edit/);
  await menu(app, 'Undo Mesh Operation');
  await until(async () => await mesh.locator('#sb-count-model').textContent() === originalCounts, 'one undo removes both imports');
  await menu(app, 'Redo Mesh Operation');
  await until(async () => /24 nodes/.test(await mesh.locator('#sb-count-model').textContent()), 'redo restores imports');
  await menu(app, 'Undo Mesh Operation');
  await until(async () => await mesh.locator('#sb-count-model').textContent() === originalCounts, 'restore original duct');
  assert.equal(fs.readFileSync(file, 'utf8'), duct);

  await advanced(mesh, 'streamlines');
  const streams = mesh.locator('#streamline-panel');
  await streams.getByTitle('The Nodal vector field to follow').selectOption('VELOCITY');
  await streams.locator('[data-streamline-field="points"]').fill('0.5 0.5 0.5');
  await streams.getByRole('button', { name: 'Trace', exact: true }).click();
  await until(async () => /1 streamline of/.test(await streams.textContent()), 'host traces through staged worker');
  await streams.getByTitle('Lines draw polylines; Tubes draw a surface around each line').selectOption('tubes');
  assert.equal(await streams.getByTitle("Tube radius as a share of the model's bounding-box diagonal").isVisible(), true);
  await capture(mesh, 'mesh-streamlines.png', '#streamline-panel');
  await streams.getByTitle('Where the streamlines start').selectOption('plane');
  await streams.getByRole('button', { name: 'Use clip plane', exact: true }).click();
  const rowInput = label => streams.locator('.series-toolbar').filter({ has: mesh.getByText(label, { exact: true }) }).locator('input');
  assert.notEqual(await rowInput('Origin').inputValue(), '');
  await streams.getByTitle('Where the streamlines start').selectOption('line');
  await rowInput('From').fill('0.5 0.2 0.5');
  await rowInput('To').fill('0.5 0.8 0.5');
  await streams.getByTitle('Equidistant seeds, both ends included').fill('1000');
  await streams.getByTitle('Step as a fraction of the containing cell (blank = 0.25)').fill('0.001');
  await streams.getByRole('button', { name: 'Trace', exact: true }).click();
  // Per-seed progress rebuilds the panel faster than Playwright's two-frame
  // stability check. Dispatch the click to the current real control/handler.
  await streams.getByRole('button', { name: 'Cancel', exact: true }).dispatchEvent('click');
  await until(async () => /cancelled; partial result/.test(await streams.textContent()), 'cancellation keeps an honest partial trace');
  await streams.getByTitle('Close', { exact: true }).click();

  const exported = path.join(c.dir, 'exported.mdpa');
  await selectFile(app, exported, true);
  await menu(app, 'Kratos MDPA (.mdpa)');
  const report = mesh.locator('#export-report-panel');
  await report.waitFor({ state: 'visible' });
  assert.match(await report.textContent(), /exported.mdpa/);
  assert.match(await report.textContent(), /Provenance: embedded/);
  await capture(mesh, 'mesh-export-report.png', '#export-report-panel');
  await until(() => fs.existsSync(exported + '.kratosexport.json'), 'export sidecar');
  assert.match(fs.readFileSync(exported, 'utf8'), /^\/\/ Kratos provenance:/);
  await report.getByRole('button', { name: 'Close export report' }).click();
  await advanced(mesh, 'exportReport');
  assert.match(await report.textContent(), /exported.mdpa/);
  await report.getByRole('button', { name: 'Close export report' }).click();

  // Fluid validation runs before publication and does not need a solver install.
  await mesh.locator('#pt-select').selectOption('fluid');
  const dt = mesh.locator('[data-field="timeStep"] input');
  await dt.fill('0'); await dt.blur();
  await mesh.locator('#pt-generate').click();
  await until(async () => /Time step must be a positive number/.test(await mesh.locator('#pt-status').textContent()), 'invalid fixed step is refused');
  assert.equal(fs.existsSync(path.join(c.dir, 'ProjectParameters.json')), false);
  await dt.fill('0.01'); await dt.blur();
  await mesh.locator('[data-field="timeStepMode"] select').selectOption('adaptive');
  const min = mesh.locator('[data-field="minDeltaTime"] input');
  await min.fill('1'); await min.blur();
  await mesh.locator('#pt-generate').click();
  await until(async () => /Min. time step exceeds Max. time step/.test(await mesh.locator('#pt-status').textContent()), 'invalid adaptive interval is refused');
  await min.fill('0.0001'); await min.blur();
  await mesh.locator('#pt-generate').click();
  await until(() => fs.existsSync(path.join(c.dir, 'ProjectParameters.json')), 'valid adaptive case generated');
  const stepping = JSON.parse(fs.readFileSync(path.join(c.dir, 'ProjectParameters.json'), 'utf8')).solver_settings.time_stepping;
  assert.deepEqual(stepping, { automatic_time_step: true, CFL_number: 1, minimum_delta_time: 0.0001, maximum_delta_time: 0.1, time_step: 0.01 });

  const series = await openDocument(c, app, seriesFiles[0]);
  observe(series);
  await advanced(series, 'flowBalance');
  const flow = series.locator('#flow-panel');
  await flow.getByTitle('The Nodal vector field whose flux is integrated').selectOption('VELOCITY');
  const sectionTitle = 'A SubModelPart whose Conditions (and those of its children) form this section';
  await flow.getByTitle(sectionTitle).first().selectOption('Inlet');
  if (await flow.getByTitle(sectionTitle).count() < 2) await flow.getByRole('button', { name: 'Add section', exact: true }).click();
  await flow.getByTitle(sectionTitle).last().selectOption('Outlet');
  await flow.getByRole('button', { name: 'All steps', exact: true }).click();
  await until(async () => /2 of 2 steps balanced/.test(await flow.textContent()), 'all-step flow balance');
  await capture(series, 'mesh-flow-balance.png', '#flow-panel');
  const csv = path.join(c.dir, 'flow.csv');
  await selectFile(app, csv, true);
  await flow.getByRole('button', { name: 'Export series CSV' }).click();
  await until(() => fs.existsSync(csv), 'series CSV export');
  assert.match(fs.readFileSync(csv, 'utf8'), /Inlet/);
  assert.match(fs.readFileSync(csv, 'utf8'), /Outlet/);
  const rows = fs.readFileSync(csv, 'utf8').trim().split('\n').slice(1).map(row => row.split(',').slice(1, 4).map(Number));
  assert.equal(rows.length, 2);
  for (const [inlet, outlet, net] of rows) {
    assert.ok(Math.abs(inlet + 1) < 1e-6 && Math.abs(outlet - 1) < 1e-6 && Math.abs(net) < 1e-6, 'unit-area duct balances quantitatively');
  }
  await flow.getByTitle('Show this step').last().click();
  await until(async () => /frame 2 \/ 2/.test(await series.locator('#sb-count-frame').textContent()), 'row click jumps the live timeline');

  const packed = path.join(c.dir, 'packed.pvd');
  await selectFile(app, packed, true);
  await menu(app, 'Pack Time Series Into One File…');
  const picker = await c.page(app, 'picker');
  await clickPickerOption(picker.getByRole('option').filter({ hasText: 'ParaView collection' }));
  let staticReport;
  await until(async () => {
    staticReport = app.windows().find(p => p.url().startsWith('data:text/html'));
    return !!staticReport;
  }, 'packing Show report opens a separate window');
  await staticReport.getByRole('heading', { name: 'Export report' }).waitFor();
  assert.match(await staticReport.locator('body').textContent(), /retained/);
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('data:text/html')).webContents.getLastWebPreferences());
  assert.equal(preferences.javascript, false);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  await until(() => fs.existsSync(packed + '.kratosexport.json'), 'one collection sidecar');
  const packedPage = await openDocument(c, app, packed);
  observe(packedPage);
  await packedPage.locator('#tl-next').click();
  await until(async () => /frame 2 \/ 2/.test(await packedPage.locator('#sb-count-frame').textContent()), 'packed collection reopens as timeline');

  const units = await openDocument(c, app, foam);
  observe(units);
  await units.locator('#toolbar [data-action="field"]').click();
  const fields = units.locator('#field-panel');
  await fields.locator('select').first().selectOption({ label: 'p [m²/s²] (Elemental, scalar)' });
  const unit = fields.getByTitle('Display unit (view-only; samples are unchanged)');
  await unit.selectOption('mm²/s²');
  await until(async () => Number(await fields.locator('.field-range-input').first().inputValue()) === 1e6, 'unit divisor is correct in live Field panel');
  await capture(units, 'mesh-field-units.png', '#field-panel');
  await unit.selectOption('m²/s²');
  await until(async () => Number(await fields.locator('.field-range-input').first().inputValue()) === 1, 'display switching leaves stored samples unchanged');
  await units.locator('[data-subsection="fields"] > .sb-subsection-header').click();
  await units.locator('#cvt-form .edit-form-title').click();
  await units.locator('#cvt-field').selectOption('Elemental:p');
  await units.locator('#cvt-density-field').selectOption('Elemental:rho');
  await units.locator('#cvt-density').fill('7'); // A field explicitly supersedes this constant.
  await units.locator('#cvt-form [data-op="convertFieldUnits"]').click();
  await until(async () => await fields.locator('option').filter({ hasText: 'p_Pa [Pa]' }).count() === 1, 'density field writes a new Pa field');
  await fields.locator('select').first().selectOption({ label: 'p_Pa [Pa] (Elemental, scalar)' });
  await until(async () => Number(await fields.locator('.field-range-input').first().inputValue()) === 1000, 'pressure uses per-entity density, not the constant');
  await menu(app, 'Undo Mesh Operation');
  await until(async () => await fields.locator('option').filter({ hasText: 'p_Pa [Pa]' }).count() === 0, 'pressure conversion is undoable');
  assert.equal(fs.readFileSync(path.join(foamDir, '0', 'p'), 'utf8').includes('internalField uniform 1;'), true);
  assert.deepEqual(errors, [], 'no renderer, shim or CSP failures');
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await mesh423Scenario();
