import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, menu, selectFile, until, appWindow } from './context.mjs';

async function checkGuard(app, page, label, getOutput, navUrl = 'https://example.com/') {
  const beforeUrl = page.url();
  const globals = await page.evaluate(() => ({
    hasProcess: typeof process !== 'undefined',
    hasRequire: typeof require !== 'undefined',
  }));
  assert.equal(globals.hasProcess, false, `${label}: renderer must not expose process`);
  assert.equal(globals.hasRequire, false, `${label}: renderer must not expose require`);

  // 1. Disallowed navigation is refused and logged.
  const navStart = getOutput().length;
  await page.evaluate((url) => {
    try { window.location.href = url; } catch {}
  }, navUrl);
  const expectedHost = new URL(navUrl);
  await until(() => getOutput().slice(navStart).includes(`Blocked navigation to ${expectedHost.protocol}//${expectedHost.host}`), `${label}: blocked navigation logged`);
  assert.equal(page.url(), beforeUrl, `${label}: URL must remain unchanged after blocked navigation`);

  // 2. Unlisted permission request is denied and logged.
  const permStart = getOutput().length;
  const permResult = await page.evaluate(() => new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve('granted'),
      (err) => resolve(`denied:${err.code}`),
    );
  }));
  assert.notEqual(permResult, 'granted', `${label}: geolocation permission must be denied`);
  await until(() => getOutput().slice(permStart).includes('Denied permission request: geolocation'), `${label}: denied permission logged`);

  // 3. Disallowed window.open (e.g. ssh:) is denied and logged.
  const openStart = getOutput().length;
  const opened = await page.evaluate(() => window.open('ssh://host', '_blank'));
  assert.equal(opened, null, `${label}: window.open(ssh:) must return null`);
  await until(() => getOutput().slice(openStart).includes('Blocked window.open to ssh://host'), `${label}: blocked window.open logged`);
}

await scenario('web-guard', async (c) => {
  const cad = c.copy('cad/examples/STP/block.stp');
  const mesh = c.copy('mesh/example/MDPA/double_arch.mdpa');
  const text = path.join(c.dir, 'notes.txt');
  fs.writeFileSync(text, 'hello\n');

  let captured = '';
  const app = await c.launch(undefined);
  app.process().stdout?.on('data', (d) => (captured += d.toString()));
  app.process().stderr?.on('data', (d) => (captured += d.toString()));
  const getOutput = () => captured;

  // Main views: home first, shell after its clicks (a cancelled will-navigate
  // leaves Playwright's frame tracker thinking a navigation is pending).
  const shell = await c.page(app, 'shell');
  const home = await c.page(app, 'home');
  await checkGuard(app, home, 'home', getOutput);

  // Sidebars: terminal, chat, jobs, study
  await shell.locator('#terminal-btn').click();
  await checkGuard(app, await c.page(app, 'terminal'), 'terminal', getOutput);

  await shell.locator('#chat-btn').click();
  await checkGuard(app, await c.page(app, 'chat'), 'chat', getOutput);

  await shell.locator('#jobs-btn').click();
  await checkGuard(app, await c.page(app, 'jobs'), 'jobs', getOutput);

  await shell.locator('#study-btn').click();
  await checkGuard(app, await c.page(app, 'study'), 'study', getOutput);

  // Editor
  await selectFile(app, text);
  await menu(app, 'Open in Text Editor…');
  await checkGuard(app, await c.page(app, 'editor'), 'editor', getOutput);

  // Mode views: cad and mesh
  await shell.locator('#mode-cad').click();
  await selectFile(app, cad);
  await shell.locator('#open-btn').click();
  const cadPage = await c.page(app, 'cad');
  await cadPage.waitForSelector('#app', { state: 'attached', timeout: 30_000 });
  await checkGuard(app, cadPage, 'cad', getOutput);

  await shell.locator('#mode-mesh').click();
  await selectFile(app, mesh);
  await shell.locator('#open-btn').click();
  const meshPage = await c.page(app, 'mesh');
  await meshPage.waitForSelector('#app', { state: 'attached', timeout: 30_000 });
  await checkGuard(app, meshPage, 'mesh', getOutput);

  // Dialog windows: about, license, whatsNew, settings, manual, quickPick
  await menu(app, 'About KKSS…');
  const aboutPage = await c.page(app, 'about');
  await checkGuard(app, aboutPage, 'about', getOutput);
  await aboutPage.close();

  await menu(app, 'License…');
  const licensePage = await c.page(app, 'license');
  await checkGuard(app, licensePage, 'license', getOutput);
  await licensePage.close();

  await menu(app, "What's New…");
  const whatsNewPage = await c.page(app, 'whatsnew');
  await checkGuard(app, whatsNewPage, 'whatsNew', getOutput);
  await whatsNewPage.close();

  await menu(app, 'Open Settings…');
  const settingsPage = await c.page(app, 'settings');
  await checkGuard(app, settingsPage, 'settings', getOutput);
  await settingsPage.close();

  await menu(app, 'KKSS Manual…');
  const manualPage = await appWindow(app, 'kkss://docs/', Date.now() + 30_000);
  // manual.ts uses setWindowOpenHandler? No, webGuard's setWindowOpenHandler handles file:,
  // and manual.ts's will-navigate calls shell.openExternal on non-docs URLs while webGuard logs it.
  await checkGuard(app, manualPage, 'manual', getOutput, 'ssh://host');
  await manualPage.close();

  await menu(app, 'Export…');
  const pickerPage = await c.page(app, 'picker');
  await checkGuard(app, pickerPage, 'quickPick', getOutput);
  await pickerPage.close();

  await checkGuard(app, shell, 'shell', getOutput);
});
