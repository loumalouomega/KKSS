import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, menu, until, quitApp } from './context.mjs';
import { clickPickerOption } from './picker.mjs';
for (const mode of ['success', 'fail', 'stall']) await scenario(`cloud-${mode}`, async c => {
  c.copy('mesh/example/MDPA/double_arch.mdpa', 'source.mdpa'); fs.writeFileSync(path.join(c.dir, 'mode'), mode);
  const app = await c.launch(undefined, { env: { KKSS_E2E_CLOUD_DIR: c.dir } });
  await menu(app, 'Open from Cloud…');
  const picker = await c.page(app, 'picker');
  await clickPickerOption(picker.getByRole('option', { name: 'cloud.mdpa', exact: true }));
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
  // This scenario asserts the main-process upload drain, not viewport redraw.
  // Parking on Home avoids SwiftShader's documented ReadPixels stall wedging
  // Electron shutdown after the mesh handshake has already completed.
  await shell.locator('#home-btn').click();
  await until(async () => await shell.locator('#tab-strip').isHidden(), 'hide the mesh renderer before quit');
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

// Session restore re-downloads a cloud document the staging cache has evicted:
// open from the cloud, quit, wipe the cache (what an eviction or "Clear Cloud
// Cache" leaves behind — the file *and* its manifest entry), relaunch with
// restore, and expect the document to come back into its saved tab.
await scenario('cloud-restore-evicted', async c => {
  c.copy('mesh/example/MDPA/double_arch.mdpa', 'source.mdpa'); fs.writeFileSync(path.join(c.dir, 'mode'), 'success');
  const env = { KKSS_E2E_CLOUD_DIR: c.dir };
  const cacheDir = path.join(c.profile, 'cloud-cache');
  const manifestPath = path.join(cacheDir, 'manifest.json');
  const statePath = path.join(c.profile, 'state.json');
  const app = await c.launch(undefined, { env });
  await menu(app, 'Open from Cloud…');
  const picker = await c.page(app, 'picker');
  await clickPickerOption(picker.getByRole('option', { name: 'cloud.mdpa', exact: true }));
  const shell = await c.page(app, 'shell');
  await until(async () => (await shell.locator('.tab.active').textContent()).includes('cloud.mdpa'));
  await until(() => fs.existsSync(manifestPath));
  const key = Object.keys(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries)[0];
  const staged = path.join(cacheDir, key);
  // The session must carry the cloud origin: once the cache evicts the document
  // its manifest entry goes with it and nothing else can say where it came from.
  const session = () => JSON.parse(fs.readFileSync(statePath, 'utf8')).session;
  await until(() => { try { return !!session()?.mesh?.cloud?.[staged]; } catch { return false; } }, 'session records the cloud ref');
  // Same quit routine as the upload scenarios: park on Home so SwiftShader cannot wedge shutdown.
  await shell.locator('#home-btn').click();
  await until(async () => await shell.locator('#tab-strip').isHidden(), 'hide the mesh renderer before quit');
  await quitApp(app, 20_000);
  assert.ok(session().mesh.cloud[staged], 'the ref survives the quit');

  fs.rmSync(cacheDir, { recursive: true, force: true }); // evicted: file and manifest entry both gone
  assert.equal(fs.existsSync(staged), false);

  const relaunched = await c.launch(undefined, { env, restore: true });
  // Restore itself is synchronous; the download follows in the background.
  await until(() => fs.existsSync(staged), 'the evicted document is downloaded again');
  await until(() => fs.existsSync(manifestPath) && Object.keys(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).entries).includes(key), 'the manifest entry is rebuilt');
  assert.ok(session().mesh.files.includes(staged), 'the document is back in its saved tab');
  const shell2 = await c.page(relaunched, 'shell');
  await shell2.locator('#home-btn').click();
  await until(async () => await shell2.locator('#tab-strip').isHidden(), 'hide the mesh renderer before quit');
  await quitApp(relaunched, 20_000);
});
