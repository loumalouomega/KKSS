import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, menu, until, quitApp } from './context.mjs';
for (const mode of ['success', 'fail', 'stall']) await scenario(`cloud-${mode}`, async c => {
  c.copy('mesh/example/MDPA/double_arch.mdpa', 'source.mdpa'); fs.writeFileSync(path.join(c.dir, 'mode'), mode);
  const app = await c.launch(undefined, { env: { KKSS_E2E_CLOUD_DIR: c.dir } });
  await menu(app, 'Open from Cloud…');
  const picker = await c.page(app, 'picker'); await picker.getByText('cloud.mdpa', { exact: true }).click();
  const shell = await c.page(app, 'shell');
  await until(async () => (await shell.locator('.tab.active').textContent()).includes('cloud.mdpa'));
  const manifestPath = path.join(c.profile, 'cloud-cache', 'manifest.json');
  const entries = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries;
  await until(() => fs.existsSync(manifestPath));
  const key = Object.keys(entries())[0]; const local = path.join(c.profile, 'cloud-cache', key);
  const bytes = fs.readFileSync(local, 'utf8') + '\n// e2e local edit\n';
  // Let the real staging watcher see a disk edit, as it would a submodule save.
  fs.writeFileSync(local, bytes);
  await until(() => entries()[key].dirty === true, 'watcher persists dirty state');
  let exited = false; app.process().once('exit', () => { exited = true; });
  const quittingAt = Date.now();
  const quit = quitApp(app, 20_000); quit.catch(() => {});
  await until(() => fs.existsSync(path.join(c.dir, 'started')), 'quit starts upload');
  if (mode === 'success') {
    assert.equal(exited, false, 'quit must wait for the upload barrier');
    fs.writeFileSync(path.join(c.dir, 'release'), 'release');
  }
  await quit;
  if (mode === 'stall') assert.ok(Date.now() - quittingAt >= 9000, 'stalled drain must wait for the real timeout');
  if (mode === 'success') {
    assert.equal(fs.readFileSync(path.join(c.dir, 'uploaded.mdpa'), 'utf8'), bytes);
    assert.notEqual(entries()[key].dirty, true);
  } else {
    assert.equal(entries()[key].dirty, true); assert.equal(fs.readFileSync(local, 'utf8'), bytes);
    // Reopen the staged document through its normal launch path and retry Save.
    fs.writeFileSync(path.join(c.dir, 'mode'), 'success'); fs.writeFileSync(path.join(c.dir, 'release'), 'release');
    const recovered = await c.launch(local, { env: { KKSS_E2E_CLOUD_DIR: c.dir } });
    await c.page(recovered, 'mesh'); await menu(recovered, 'Save');
    await until(() => entries()[key].dirty !== true, 'retry clears dirty state');
    assert.equal(fs.readFileSync(path.join(c.dir, 'uploaded.mdpa'), 'utf8'), bytes);
    await quitApp(recovered);
  }
});
