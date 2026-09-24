import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, menu, selectFile, until } from './context.mjs';
await scenario('workspace', async c => {
  const cad = c.copy('cad/examples/STP/block.stp');
  const mesh = c.copy('mesh/example/MDPA/double_arch.mdpa');
  const text = path.join(c.dir, 'edit.json'); fs.writeFileSync(text, '{"before":true}\n');
  const app = await c.launch(); const shell = await c.page(app, 'shell');
  const cloud = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(i => i.submenu?.items ?? []).filter(i => i.label.startsWith('Open from Cloud')).map(i => ({ enabled: i.enabled, label: i.label })));
  assert.equal(cloud.length, 1); assert.equal(cloud[0].enabled, false);
  await selectFile(app, text); await menu(app, 'Open in Text Editor…');
  const editor = await c.page(app, 'editor'); await editor.locator('.cm-content').click();
  await editor.keyboard.press('Control+a'); await editor.keyboard.insertText('{"after":true}\n');
  await editor.locator('#editor-path .ui-dot').waitFor();
  await menu(app, 'Save');
  await until(() => fs.readFileSync(text, 'utf8') === '{"after":true}\n', 'editor saved bytes');
  await editor.locator('#editor-path .ui-dot').waitFor({ state: 'detached' });
  await shell.locator('#terminal-btn').click(); const terminal = await c.page(app, 'terminal');
  await terminal.evaluate(() => { window.e2eOutput = ''; window.termApi.onMessage(m => { if (m.type === 'data') window.e2eOutput += m.data; }); });
  await terminal.locator('.xterm-helper-textarea').focus();
  await terminal.keyboard.type("printf 'KKSS_%s\\n' PTY_OK"); await terminal.keyboard.press('Enter');
  await terminal.waitForFunction(() => window.e2eOutput.includes('KKSS_PTY_OK'));
  await terminal.locator('#hide-btn').click();
  await until(async () => await shell.locator('#terminal-btn').getAttribute('aria-pressed') === 'false');
  await shell.locator('#terminal-btn').click(); assert.equal(await terminal.locator('.xterm').count(), 1);
  for (const [mode, file] of [['cad', cad], ['mesh', mesh]]) {
    await shell.locator(`#mode-${mode}`).click(); await selectFile(app, file); await shell.locator('#open-btn').click();
    await until(async () => (await shell.locator('.tab.active').textContent()).includes(path.basename(file)), 'tab title');
    await shell.selectOption('#zoom-select', '1.25');
    await shell.locator('.tab-new').click(); await until(async () => await shell.locator('.tab').count() === 2, 'new tab');
    await until(async () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getURL().startsWith('kkss://')).every(w => Math.abs(w.getZoomFactor() - 1.25) < 0.01)), 'all views inherit scale');
    await shell.locator('.tab').first().click(); assert.ok((await shell.locator('.tab.active').textContent()).includes(path.basename(file)));
    await shell.locator('.tab').last().locator('.tab-close').click(); await until(async () => await shell.locator('.tab').count() === 1);
  }
  await menu(app, 'Reset Zoom'); await until(async () => await shell.locator('#zoom-select').inputValue() === '1');
  await until(async () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getURL().startsWith('kkss://')).every(w => Math.abs(w.getZoomFactor() - 1) < 0.01)), 'reset applies to every view');
});
