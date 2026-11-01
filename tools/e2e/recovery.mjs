import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, until, quitApp } from './context.mjs';

// A pid no process holds, so the planted session folders read as orphans.
const DEAD_PID = 2147483000;

await scenario('recovery', async c => {
  const mesh = c.copy('mesh/example/MDPA/double_arch.mdpa', 'crash.mdpa');
  const notes = path.join(c.dir, 'notes.py'); fs.writeFileSync(notes, 'print("on disk")\n');
  const recoveryDir = path.join(c.profile, 'recovery');
  const sessionDirs = () => fs.existsSync(recoveryDir) ? fs.readdirSync(recoveryDir).filter(n => /^\d+-\d+$/.test(n)) : [];
  const checkpointFiles = () => sessionDirs().flatMap(d => fs.readdirSync(path.join(recoveryDir, d)).filter(f => f.endsWith('.ops.json')).map(f => path.join(recoveryDir, d, f)));

  console.log('recovery: checkpoint while running, then crash');
  let app = await c.launch(mesh); let shell = await c.page(app, 'shell');
  let meshPage = await c.page(app, 'mesh');
  await until(async () => /\d/.test(await meshPage.locator('#sb-count-model').textContent().catch(() => '')), 'mesh loaded');
  await meshPage.evaluate(() => window.__kkss.post({ type: 'applyOp', op: 'translate', dx: 1, dy: 0, dz: 0 }));
  await shell.locator('.tab.active .ui-dot').waitFor();
  await until(() => checkpointFiles().length === 1, 'operation recipe checkpointed');
  const before = fs.readFileSync(mesh, 'utf8');
  const child = app.process(); // the Playwright handle is unusable once the process is gone
  child.kill('SIGKILL'); // a crash never reaches the quit path
  await until(() => child.exitCode !== null || child.signalCode !== null, 'killed');
  assert.equal(fs.readFileSync(mesh, 'utf8'), before, 'the crash left the file untouched');
  assert.equal(sessionDirs().length, 1, 'the dead session keeps its checkpoint');
  const crashed = sessionDirs()[0];

  console.log('recovery: plant an editor buffer and a changed-source entry');
  const planted = path.join(recoveryDir, `${DEAD_PID}-1000`); fs.mkdirSync(planted, { recursive: true });
  const entry = (id, kind, extra) => fs.writeFileSync(path.join(planted, `${id}.json`), JSON.stringify({ version: 1, id, kind, savedAt: Date.now(), sourceMtimeMs: null, sourceSize: null, ...extra }));
  entry('editor', 'editor', { originalPath: notes, content: 'print("recovered")\n', task: 'kratosRun' });
  entry('gone', 'editor', { originalPath: path.join(c.dir, 'deleted.py'), content: 'x', sourceMtimeMs: 1, sourceSize: 1 });

  console.log('recovery: offered on Home, nothing applied');
  app = await c.launch(); shell = await c.page(app, 'shell');
  await shell.locator('#home-btn').click(); const home = await c.page(app, 'home');
  await home.locator('#recovery').waitFor({ state: 'visible' });
  assert.equal(await home.locator('.recovery-row').count(), 3);
  assert.equal(await shell.locator('.tab .ui-dot').count(), 0, 'no tab was opened by the offer');
  const rows = home.locator('.recovery-row');
  const meshRow = rows.filter({ hasText: 'crash.mdpa' });
  const goneRow = rows.filter({ hasText: 'deleted.py' });
  assert.equal(await goneRow.locator('button', { hasText: 'Restore' }).isDisabled(), true, 'a missing source cannot be restored');
  assert.match(await rows.filter({ hasText: 'notes.py' }).textContent(), /Kratos run/);

  console.log('recovery: restore the mesh operations into a new tab');
  await meshRow.locator('button', { hasText: 'Restore into a new tab' }).click();
  await shell.locator('.tab.active .ui-dot').waitFor();
  await until(async () => (await shell.locator('.tab.active').textContent()).includes('crash.mdpa'), 'restored tab is active');
  // The old entry goes only once the restored tab has re-checkpointed the same work.
  await until(() => !fs.existsSync(path.join(recoveryDir, crashed)), 'crashed session discarded after re-checkpoint');
  assert.equal(checkpointFiles().length, 1, 'the live tab now holds the checkpoint');
  assert.match(fs.readFileSync(checkpointFiles()[0], 'utf8'), /translate/, 'the recovered operation was replayed, not just the tab opened');

  console.log('recovery: restore the editor buffer, discard the rest');
  await shell.locator('#home-btn').click();
  await home.locator('.recovery-row').filter({ hasText: 'notes.py' }).locator('button', { hasText: 'Restore into the text editor' }).click();
  const editor = await c.page(app, 'editor');
  await until(async () => (await editor.locator('.cm-content').textContent()).includes('recovered'), 'recovered buffer shown');
  assert.equal(fs.readFileSync(notes, 'utf8'), 'print("on disk")\n', 'restore never writes the user file');
  await shell.locator('#home-btn').click();
  await home.locator('.recovery-row').filter({ hasText: 'deleted.py' }).locator('button', { hasText: 'Discard' }).click();
  await until(async () => await home.locator('.recovery-row').filter({ hasText: 'deleted.py' }).count() === 0, 'discard removes the row');
  assert.equal(fs.existsSync(path.join(planted, 'gone.json')), false);

  console.log('recovery: a clean quit leaves no session folder of its own');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (...args) => ({ response: args.at(-1).buttons?.indexOf("Don't Save") ?? 1, checkboxChecked: false }); });
  await quitApp(app);
  assert.deepEqual(sessionDirs(), [], 'own session folder removed and every offered entry resolved');
});
