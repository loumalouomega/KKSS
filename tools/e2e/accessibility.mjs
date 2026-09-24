import fs from 'node:fs';
import axe from 'axe-core';
import { scenario, assert, menu, until, quitApp, selectFile } from './context.mjs';
import { kratosFixture } from './fixtures.mjs';
const spanish = JSON.parse(fs.readFileSync(new URL('../../app/shared/i18n/es.json', import.meta.url)));
for (const language of ['en', 'es']) await scenario(`accessibility-${language}`, async c => {
  const text = value => language === 'es' ? spanish[value] ?? value : value;
  const fixture = kratosFixture(c.dir);
  c.seed({ uiLanguage: language, uiTheme: 'dark' });
  const app = await c.launch(undefined, { env: fixture.env });
  const home = await c.page(app, 'home');
  const shell = await c.page(app, 'shell');
  const scan = async (page, name) => {
    assert.equal(await page.locator('html').getAttribute('lang'), language, `${name} language`);
    await page.evaluate(axe.source);
    const result = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.map(v => ({id: v.id, targets: v.nodes.map(n => n.target)})));
    console.log(`SCAN ${language} ${name}`);
    assert.deepEqual(result, [], `${language} ${name}: ${JSON.stringify(result)}`);
  };
  // CDP keyboard events bypass Electron's before-input-event and native menus.
  // Deliver real Electron input to the currently focused view instead.
  const key = async sequence => app.evaluate(({webContents}, sequence) => {
    const parts = sequence.split('+'); const keyCode = parts.pop();
    const modifiers = parts.map(p => p.toLowerCase());
    const wc = webContents.getFocusedWebContents();
    if (!wc) throw new Error('No focused view for ' + sequence);
    wc.sendInputEvent({type: 'keyDown', keyCode, modifiers});
    wc.sendInputEvent({type: 'keyUp', keyCode, modifiers});
    return {focused: wc.getURL(), windows: webContents.getAllWebContents().map(w => w.getURL()), hit: webContents.getFocusedWebContents()?.getURL()};
  }, sequence);
  const focusedView = async () => app.evaluate(({webContents}) => webContents.getAllWebContents().find(w => w.isFocused())?.getURL());
  await home.getByRole('button', {name: new RegExp(text('Text Editor'))}).waitFor();
  // Start at the actual focused Home control; enter the editor using only keys.
  await app.evaluate(({BaseWindow}) => BaseWindow.getAllWindows()[0].focus());
  await key('F6');
  await until(async () => /\/home\//.test(await focusedView() ?? ''), 'Home focus');
  for (let i = 0; i < 12; i++) {
    if (await home.evaluate(() => document.activeElement?.matches('#menu button:nth-child(3)'))) break;
    await home.keyboard.press('Tab');
  }
  assert.equal(await home.evaluate(() => document.activeElement?.matches('#menu button:nth-child(3)')), true);
  await selectFile(app, c.copy("package.json", "Save.json"));
  await home.locator('#menu button:nth-child(3)').press('Enter');
  const editor = await c.page(app, 'editor');
  await until(async () => /\/editor\//.test(await focusedView() ?? ''), 'keyboard Home → editor');
  await editor.locator('#editor-path').filter({hasText: 'Save.json'}).waitFor();
  await key('F6');
  await until(async () => /\/shell\//.test(await focusedView() ?? ''), 'focus transition');
  await key('Shift+F6');
  await until(async () => /\/editor\//.test(await focusedView() ?? ''), 'focus transition');
  for (let i = 0; i < 16 && await shell.evaluate(() => document.activeElement?.id) !== 'terminal-btn'; i++) await shell.keyboard.press('Tab');
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'terminal-btn');
  await shell.locator('#terminal-btn').press('Enter');
  const terminal = await c.page(app, 'terminal');
  await until(async () => /\/terminal\//.test(await focusedView() ?? ''), 'terminal focus');
  await key('Shift+F6');
  await until(async () => /\/editor\//.test(await focusedView() ?? ''), 'terminal to editor');
  await key('Shift+F6');
  await until(async () => /\/shell\//.test(await focusedView() ?? ''), 'editor to shell');
  for (let i = 0; i < 16 && await shell.evaluate(() => document.activeElement?.id) !== 'terminal-btn'; i++) await shell.keyboard.press('Tab');
  await shell.locator('#terminal-btn').press('Enter');
  await until(async () => /\/shell\//.test(await focusedView() ?? ''), 'terminal restores shell');
  await key('F6');
  await until(async () => /\/editor\//.test(await focusedView() ?? ''), 'shell to editor');
  await key('F6');
  await until(async () => /\/shell\//.test(await focusedView() ?? ''), 'editor to shell');
  for (let i = 0; i < 16 && await shell.evaluate(() => document.activeElement?.id) !== 'chat-btn'; i++) await shell.keyboard.press('Tab');
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'chat-btn');
  await shell.locator('#chat-btn').press('Enter');
  const chat = await c.page(app, 'chat');
  await until(async () => /\/chat\//.test(await focusedView() ?? ''), 'chat focus');
  await key('Shift+F6'); await until(async () => /\/editor\//.test(await focusedView() ?? ''), 'focus transition');
  await key('F6'); await until(async () => /\/chat\//.test(await focusedView() ?? ''), 'focus transition');
  await key('Shift+F6');
  await until(async () => /\/editor\//.test(await focusedView() ?? ''), 'chat to editor');
  await key('Shift+F6');
  await until(async () => /\/shell\//.test(await focusedView() ?? ''), 'editor to shell');
  await shell.locator('#chat-btn').press('Enter');
  await until(async () => /\/shell\//.test(await focusedView() ?? ''), 'chat restores shell');
  // Jobs has a toolbar route. Reach it with the shell's Tab order.

  for (let i = 0; i < 16 && await shell.evaluate(() => document.activeElement?.id) !== 'jobs-btn'; i++) await key('Tab');
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'jobs-btn');
  await shell.locator('#jobs-btn').press('Enter');
  const jobs = await c.page(app, 'jobs');
  await until(async () => /\/jobs\//.test(await focusedView() ?? ''), 'jobs focus');
  await scan(jobs, 'jobs'); await key('Escape');
  await until(async () => /\/shell\//.test(await focusedView() ?? ''), 'jobs restores shell');
  // Native menu actions open auxiliary windows; their content remains keyboard accessible.
  await menu(app, text('Open Settings…'));
  const settings = await c.page(app, 'settings');
  await settings.locator('[data-id="general.language"]').waitFor();
  assert.equal(await settings.locator('[data-id="general.language"] select').inputValue(), language);
  assert.match(await settings.locator('[data-id="general.language"]').textContent(), new RegExp(text('Applies on the next start')));
  const themeNames = ['Dark', 'Light', 'High contrast (dark)', 'High contrast (light)'];
  for (const theme of themeNames) {
    await menu(app, text(theme));
    for (const [name, page] of [['home', home], ['shell', shell], ['editor', editor], ['chat', chat], ['settings', settings]]) await scan(page, `${name}/${theme}`);
  }
  await menu(app, text('About KKSS…')); const about = await c.page(app, 'about'); await scan(about, 'about');
  await key('Escape');
  await menu(app, text("What's New…")); const news = await c.page(app, 'whatsnew'); await scan(news, 'whatsnew'); await key('Escape');
  // Persist a different locale, with no live mutation, then verify it after restart.
  const next = language === 'en' ? 'es' : 'en';
  await settings.locator('[data-id="general.language"] select').selectOption(next);
  assert.equal(await settings.locator('html').getAttribute('lang'), language);
  await quitApp(app);
  const restarted = await c.launch(undefined, { env: fixture.env });
  const restartedHome = await c.page(restarted, 'home');
  await until(async () => await restartedHome.locator('html').getAttribute('lang') === next, 'persisted language after restart');
});
