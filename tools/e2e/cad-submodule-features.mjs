import fs from 'node:fs';
import { scenario, assert, selectFile, until } from './context.mjs';

await scenario('cad-submodule-features', async c => {
  const cadFile = c.copy('cad/examples/STP/hose-fitting.stp');
  const sweepFile = c.copy('cad/examples/STP/block.stp');
  const sweepOutputDir = `${c.dir}/sweep-output`;
  fs.mkdirSync(sweepOutputDir);
  const app = await c.launch(cadFile);
  const shell = await c.page(app, 'shell');
  const cad = await c.page(app, 'cad');
  await cad.locator('#doc-chip-name').getByText('hose-fitting.stp', { exact: true }).waitFor();

  await cad.locator('#parts-copy-holes').click();
  await until(async () => (await cad.locator('#status').textContent()).includes('Hole table copied'), 'hole table copied from the B-rep host');

  await selectFile(app, sweepFile);
  await shell.locator('#open-btn').click();
  await cad.locator('#doc-chip-name').getByText('block.stp', { exact: true }).waitFor();

  await cad.locator('#meshing-toggle').click();
  await cad.locator('#meshing-sweep .meshing-section-header').click();
  await cad.locator('#meshing-sweep-sizes').fill('10, 5');
  await cad.locator('#meshing-sweep-write').check();
  await selectFile(app, sweepOutputDir);
  await cad.locator('#meshing-sweep-run').click();
  await until(async () => await cad.locator('#meshing-sweep-table tr').count() === 3, 'refinement sweep returns both rows', 120_000);
  await until(async () => (await cad.locator('#meshing-sweep-status').textContent()).includes('2 of 2 runs meshed'), 'both refinement sizes mesh successfully', 120_000);
  await until(() => fs.existsSync(`${sweepOutputDir}/block-size-10.msh`) && fs.existsSync(`${sweepOutputDir}/block-size-5.msh`), 'sweep writes one mesh per size');
  await cad.locator('#meshing-sweep-copy').click();
  await until(async () => (await cad.locator('#status').textContent()).includes('Sweep table copied'), 'refinement rows copy as TSV');

  const annotationsPath = `${sweepFile}.annotations.json`;
  await cad.evaluate(() => window.__kkss.post({
    type: 'annotationsChanged',
    annotations: [{
      id: 'e2e-note', tool: 'note', text: 'Persisted note', anchorPoint: [0, 0, 0], linePoints: [],
      volumes: [], surfaces: [], lines: [], points: [],
    }],
  }));
  await until(() => fs.existsSync(annotationsPath) && fs.readFileSync(annotationsPath, 'utf8').includes('Persisted note'), 'note saved to the existing annotations sidecar');
  await cad.reload();
  await cad.locator('#doc-chip-name').getByText('block.stp', { exact: true }).waitFor();
  await until(async () => (await cad.locator('#annotations-list').textContent()).includes('Note: Persisted note'), 'note restored to the viewer');

  const meshFile = c.copy('mesh/example/VTK/Main_MovingNodes_0_2.vtk');
  await shell.locator('#mode-mesh').click();
  await selectFile(app, meshFile);
  await shell.locator('#open-btn').click();
  const mesh = await c.page(app, 'mesh');
  await mesh.locator('#doc-chip-name').getByText('Main_MovingNodes_0_2.vtk', { exact: true }).waitFor();
  await mesh.locator('#toolbar [data-action="field"]').click();
  await mesh.getByRole('button', { name: /Deformed/ }).click();
  const warpScale = mesh.locator('#field-panel input.field-slider');
  await warpScale.waitFor();
  assert.equal(await warpScale.getAttribute('max'), '1000');
  await warpScale.evaluate(el => { el.value = '1000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await mesh.locator('#field-panel').getByText('1000.0×', { exact: true }).waitFor();
});
