import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { scenario, assert, until, quitApp, electronPath, softwareGL, root, selectFile } from './context.mjs';
import { kratosFixture } from './fixtures.mjs';
await scenario('session', async c => {
  const cad = c.copy('cad/examples/STP/block.stp');
  const second = c.copy('cad/examples/STP/block.stp', 'second.stp');
  const mesh = c.copy('mesh/example/MDPA/double_arch.mdpa');
  const fixture = kratosFixture(c.dir);
  let app = await c.launch(cad, { env: fixture.env }); let shell = await c.page(app, 'shell');
  await until(async () => (await shell.locator('.tab.active').textContent()).includes('block.stp'));
  await shell.locator('.tab-new').click(); await selectFile(app, second); await shell.locator('#open-btn').click();
  await until(async () => (await shell.locator('.tab.active').textContent()).includes('second.stp'));
  await shell.locator('#mode-mesh').click(); await selectFile(app, mesh); await shell.locator('#open-btn').click();
  await until(async () => (await shell.locator('.tab.active').textContent()).includes('double_arch.mdpa'));
  await shell.locator('#terminal-btn').click(); await shell.locator('#chat-btn').click();
  await quitApp(app);
  const statePath = path.join(c.profile, 'state.json'); const saved = JSON.parse(fs.readFileSync(statePath));
  assert.deepEqual(saved.session.cad.files, [cad, second]); assert.equal(saved.session.mesh.activeFile, mesh);
  assert.equal(saved.session.terminal, true); assert.equal(saved.session.chat, true);
  app = await c.launch(undefined, { restore: true, env: fixture.env }); shell = await c.page(app, 'shell');
  await until(async () => (await shell.locator('.tab.active').textContent()).includes('double_arch.mdpa'));
  assert.equal(await shell.locator('#mode-mesh').getAttribute('aria-selected'), 'true');
  for (const panel of ['terminal', 'chat']) assert.equal(await shell.locator(`#${panel}-btn`).getAttribute('aria-pressed'), 'true');
  await shell.locator('#mode-cad').click();
  assert.deepEqual(await shell.locator('.tab-label').allTextContents(), ['block.stp', 'second.stp']);
  assert.match(await shell.locator('.tab.active').textContent(), /second.stp/);
  await quitApp(app);
  // Pruning and launch-file precedence: launch CAD wins over a stored mesh screen.
  fs.unlinkSync(second); c.seed(saved);
  app = await c.launch(cad, { restore: true, env: fixture.env }); shell = await c.page(app, 'shell');
  await until(async () => await shell.locator('#mode-cad').getAttribute('aria-selected') === 'true');
  assert.ok(!(await shell.locator('.tab-label').allTextContents()).includes('second.stp'));
  assert.match(await shell.locator('.tab.active').textContent(), /block.stp/);
  await quitApp(app);
  c.seed(saved); app = await c.launch(undefined, { env: fixture.env }); shell = await c.page(app, 'shell');
  await c.page(app, 'home'); assert.equal(await shell.locator('#tab-strip').isVisible(), false);
  assert.equal(await shell.locator('#terminal-btn').getAttribute('aria-pressed'), 'false');
});
await scenario('single-instance', async c => {
  const file = c.copy('cad/examples/STP/block.stp');
  const app = await c.launch(undefined, { singleInstance: true });
  const shell = await c.page(app, 'shell');
  const child = spawn(electronPath, ['.', '--no-sandbox', '--enable-unsafe-swiftshader', ...softwareGL, `--user-data-dir=${c.profile}`, file], {
    cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '', KKSS_E2E: '1', KKSS_ALLOW_MULTIPLE_INSTANCES: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  try {
    await until(() => child.exitCode !== null, 'second process exits'); assert.equal(child.exitCode, 0);
    assert.match(output, /already running/);
    await until(async () => (await shell.locator('.tab.active').textContent()).includes('block.stp'), 'file forwarded');
    assert.equal(await shell.locator('.tab').count(), 1);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  // The assertion is about single-instance routing; SwiftShader's documented
  // ReadPixels stall can wedge graceful exit while the forwarded STEP redraws.
  await shell.locator('#home-btn').click();
  await until(async () => await shell.locator('#tab-strip').isHidden(), 'hide the CAD renderer before quit');
  await quitApp(app);
  const next = await c.launch(undefined, { singleInstance: true }); await c.page(next, 'home'); await quitApp(next);
});
