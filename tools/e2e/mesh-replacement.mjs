import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, selectFile, until, menu } from './context.mjs';

await scenario('mesh-replacement', async c => {
  const first = c.copy('mesh/example/MDPA/double_arch.mdpa', 'first.mdpa');
  const second = c.copy('mesh/example/MDPA/double_arch.mdpa', 'second.mdpa');
  const original = fs.readFileSync(first, 'utf8');
  console.log('mesh replacement: launch');
  const app = await c.launch(first); const shell = await c.page(app, 'shell');
  let mesh = await c.page(app, 'mesh');
  const ready = async name => {
    await until(async () => {
      for (const page of app.windows().filter(page => page.url().includes('/renderer/mesh/'))) {
        if (await page.locator('#doc-chip-name').textContent().catch(() => '') === name && /\d/.test(await page.locator('#sb-count-model').textContent().catch(() => ''))) { mesh = page; return true; }
      }
      return false;
    }, `loaded ${name}`);
  };
  const dirty = async () => {
    await mesh.evaluate(() => window.__kkss.post({ type: 'applyOp', op: 'translate', dx: 1, dy: 0, dz: 0 }));
    await shell.locator('.tab.active .ui-dot').waitFor();
  };
  const decision = async response => app.evaluate(({ dialog }, response) => {
    globalThis.replacementDialogs = [];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1); globalThis.replacementDialogs.push(options);
      return { response, checkboxChecked: false };
    };
  }, response);
  const count = () => app.evaluate(() => globalThis.replacementDialogs.length);
  await ready('first.mdpa'); await dirty(); await decision(2);
  await selectFile(app, second); await menu(app, 'Open…');
  await until(async () => await count() === 1, 'menu replacement asks');
  await shell.locator('.tab.active .ui-dot').waitFor();
  assert.equal(fs.readFileSync(first, 'utf8'), original);
  assert.equal(await mesh.locator('#doc-chip-name').textContent(), 'first.mdpa');
  await decision(2); await shell.locator('#open-btn').click();
  await until(async () => await count() === 1, 'toolbar replacement asks');
  // Two opens during one pending decision cannot replace the newly loaded file.
  await app.evaluate(({ dialog }) => {
    globalThis.replacementDialogs = [];
    dialog.showMessageBox = async (...args) => {
      globalThis.replacementDialogs.push(args.at(-1));
      return new Promise(resolve => { globalThis.resolveReplacement = () => resolve({ response: 1, checkboxChecked: false }); });
    };
  });
  await shell.locator('#open-btn').click(); await shell.locator('#open-btn').click();
  await until(async () => await count() === 1, 'one outstanding replacement decision');
  await app.evaluate(() => globalThis.resolveReplacement()); await ready('second.mdpa');
  assert.equal(await count(), 1);
  await selectFile(app, first); await shell.locator('#open-btn').click(); await ready('first.mdpa'); await dirty();
  await selectFile(app, second);
  // A native file input gives Electron a real File with an OS path for the drop.
  await decision(2);
  await mesh.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'e2e-drop'; input.hidden = true; document.body.append(input); });
  await mesh.locator('#e2e-drop').setInputFiles(second);
  await mesh.evaluate(() => {
    const dataTransfer = new DataTransfer(); dataTransfer.items.add(document.getElementById('e2e-drop').files[0]);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  });
  await until(async () => await count() === 1, 'drop replacement asks');
  console.log('mesh replacement: save');
  await decision(0); await shell.locator('#open-btn').click();
  await ready('second.mdpa');
  assert.notEqual(fs.readFileSync(first, 'utf8'), original, 'Save writes edits before replacing');
  console.log('mesh replacement: recents');
  await dirty(); await decision(2);
  await shell.locator('#home-btn').click(); const home = await c.page(app, 'home');
  await home.locator('.recent-btn').filter({ hasText: 'first.mdpa' }).click();
  await until(async () => await count() === 1, 'recent replacement asks');
  assert.equal(await home.isVisible('body'), true);
  await decision(1); await home.locator('.recent-btn').filter({ hasText: 'first.mdpa' }).click();
  await ready('first.mdpa');
  assert.equal(fs.readFileSync(second, 'utf8'), original, 'Don’t Save leaves old bytes untouched');
  // Force a real atomic-write failure by replacing the destination with a directory.
  console.log('mesh replacement: failed-save');
  await dirty(); fs.unlinkSync(first); fs.mkdirSync(first);
  await decision(0); await selectFile(app, second); await shell.locator('#open-btn').click();
  await until(async () => await count() >= 1, 'save failure attempted');
  await shell.locator('.tab.active .ui-dot').waitFor();
  await until(async () => (await shell.locator('body').textContent()).includes('EISDIR') || (await shell.locator('body').textContent()).includes('directory'), 'save failure surfaced');
  assert.equal(await mesh.locator('#doc-chip-name').textContent(), 'first.mdpa');
  console.log('mesh replacement: restore-file');
  fs.rmdirSync(first); fs.writeFileSync(first, original);
  await decision(1); await shell.locator('#open-btn').click(); await ready('second.mdpa');
  // A clean replacement needs no dialog, and an explicit new tab keeps the old one.
  console.log('mesh replacement: clean-open');
  await decision(2); await selectFile(app, first); await shell.locator('#open-btn').click(); await ready('first.mdpa'); assert.equal(await count(), 0);
  console.log('mesh replacement: new-tab');
  await shell.locator('.tab-new').click(); await selectFile(app, second); await shell.locator('#open-btn').click(); await ready('second.mdpa');
  assert.equal(await shell.locator('.tab').count(), 2); assert.equal(await count(), 0);
});
