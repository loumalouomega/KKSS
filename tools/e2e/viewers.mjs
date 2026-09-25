import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, menu, selectFile, until } from './context.mjs';
await scenario('viewers-export', async c => {
  const cadFile = c.copy('cad/examples/STP/block.stp');
  const meshFile = c.copy('mesh/example/MDPA/double_arch.mdpa');
  const exported = path.join(c.dir, 'exported.mdpa');
  const app = await c.launch(meshFile); const shell = await c.page(app, 'shell');
  const mesh = await c.page(app, 'mesh');
  for (const id of ['app', 'toolbar', 'sidebar', 'viewport', 'menubar']) await mesh.locator(`#${id}`).waitFor();
  await mesh.locator('#doc-chip-name').getByText('double_arch.mdpa', { exact: true }).waitFor();
  // Native command -> shim -> extension -> viewer, with observable model reload.
  await mesh.locator('#sb-count-model').waitFor();
  const nodeCount = text => Number(text.split(' nodes')[0].replace(/\D/g, ''));
  const beforeReload = nodeCount(await mesh.locator('#sb-count-model').textContent());
  fs.writeFileSync(meshFile, fs.readFileSync(meshFile, 'utf8').replace('End Nodes', '999999 0 0 0\nEnd Nodes'));
  await menu(app, 'Reload from Disk');
  await until(async () => nodeCount(await mesh.locator('#sb-count-model').textContent()) === beforeReload + 1, 'shim reload updates rendered node count');
  await shell.locator('#mode-cad').click(); await selectFile(app, cadFile); await shell.locator('#open-btn').click();
  const cad = await c.page(app, 'cad');
  for (const id of ['app', 'toolbar', 'side', 'tree-panel']) await cad.locator(`#${id}`).waitFor();
  await cad.locator('#doc-chip-name').getByText('block.stp', { exact: true }).waitFor();
  await cad.locator('#tree-search').click(); await cad.locator('#tree-filter').waitFor();
  await cad.locator('#meshing-toggle').click();
  await cad.selectOption('#meshing-export-format', 'mdpaElements');
  await selectFile(app, exported, true);
  let exportedView;
  for (let i = 0; i < 2; i++) {
    await shell.locator('#mode-cad').click();
    const before = fs.existsSync(exported) ? fs.statSync(exported).mtimeMs : 0;
    const refreshed = exportedView?.waitForEvent('domcontentloaded', { timeout: 120_000 });
    refreshed?.catch(() => {});
    await cad.locator('#meshing-export').click();
    await until(() => fs.existsSync(exported) && fs.statSync(exported).mtimeMs > before && /End Nodes/.test(fs.readFileSync(exported, 'utf8')) && /End Elements/.test(fs.readFileSync(exported, 'utf8')), 'CAD exported complete mesh', 120_000);
    assert.match(fs.readFileSync(exported, 'utf8'), /Begin Nodes/);
    await until(async () => (await shell.locator('.tab.active').textContent()).includes('exported.mdpa'), 'export activates mesh');
    await refreshed;
    assert.equal(await shell.locator('.tab').count(), 2, 'repeat export must reuse the clean tab');
    await until(async () => {
      for (const p of app.windows().filter(p => p.url().includes('/renderer/mesh/'))) {
        if (await p.locator('#doc-chip-name').textContent().catch(() => '') === 'exported.mdpa' && await p.locator('#sb-count-model').isVisible()) { exportedView = p; return true; }
      }
      return false;
    }, 'exported document rendered');
    await shell.locator('.tab').first().click();
    assert.match(await shell.locator('.tab.active').textContent(), /double_arch.mdpa/);
  }
});
