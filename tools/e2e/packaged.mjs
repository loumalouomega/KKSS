/**
 * Release-artifact self-test: launches the PACKAGED app — not out/ — headless, opens a fixture in
 * each mode, checks the native menu, audits app-owned pages for clipped or unnamed controls at three window widths, records the
 * environment a shell hands to user programs, and requires a natural graceful quit.
 *
 *   KKSS_PACKAGED_BIN=release/linux-unpacked/kkss xvfb-run -a node tools/e2e/packaged.mjs
 *
 * Without KKSS_PACKAGED_BIN the unpacked directory electron-builder leaves in release/ is looked up. `npm run e2e` does not
 * include this file: it needs a built package, so release.yml runs it per runner after "Package installers".
 */
import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, until, quitApp, root, waitForMarkers } from './context.mjs';
import { softwareGL } from '../e2eShared.mjs';
import { auditPages } from './layoutAudit.mjs';

/** Where electron-builder leaves each platform's unpacked app (productName KKSS; Linux uses the lowercase package name). */
function candidates() {
  const r = path.join(root, 'release');
  return [
    ['linux-unpacked', 'kkss'], ['linux-arm64-unpacked', 'kkss'],
    ['win-unpacked', 'KKSS.exe'], ['win-arm64-unpacked', 'KKSS.exe'],
    ['mac-arm64', 'KKSS.app/Contents/MacOS/KKSS'], ['mac', 'KKSS.app/Contents/MacOS/KKSS'],
  ].map(([dir, bin]) => path.join(r, dir, ...bin.split('/')));
}
const binary = process.env.KKSS_PACKAGED_BIN ? path.resolve(process.env.KKSS_PACKAGED_BIN) : candidates().find((f) => fs.existsSync(f));
if (!binary || !fs.existsSync(binary)) {
  console.error(`FAIL packaged: no packaged app found (set KKSS_PACKAGED_BIN; looked in ${candidates().join(', ')}).`);
  process.exit(1);
}
console.log(`packaged binary: ${binary}`);

/** Output of the app's own stdout/stderr from now on (launchApp keeps its own copy, but does not expose it through c.launch). */
function tail(app) {
  let text = '';
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', (d) => { text += d; });
  return () => text;
}

await scenario(`packaged-${process.platform}-${process.arch}`, async (c) => {
  c.seed({ uiTheme: 'dark' });
  // The shared software-GL flags force SwiftShader (Vulkan), whose ANGLE init fails on the macOS arm64 runners
  // ("Internal Vulkan error"), leaving both viewers without WebGL. macOS uses its native Metal backend instead.
  const extraArgs = process.platform === 'darwin' ? ['--use-angle=metal'] : softwareGL;
  const launch = (file, env = {}) => c.launch(file, { executablePath: binary, timeout: 150_000, env, extraArgs });

  // --- A packaged app, in each mode -----------------------------------------------------------------------------
  const cad = await launch(c.copy('cad/examples/STP/block.stp'));
  assert.equal(await cad.evaluate(({ app }) => app.isPackaged), true, 'the binary under test must be a packaged app');
  const cadOut = tail(cad);
  await c.page(cad, 'cad');
  await waitForMarkers(cadOut, ['[cad] host → webview: geometry'], Date.now() + 150_000);
  await quitApp(cad);

  const mesh = await launch(c.copy('mesh/example/MDPA/double_arch.mdpa'));
  const meshOut = tail(mesh);
  await c.page(mesh, 'mesh');
  await waitForMarkers(meshOut, ['[mesh] host → webview: model'], Date.now() + 150_000);
  await quitApp(mesh);

  // --- Home: menu, layout, environment ---------------------------------------------------------------------------
  // Packager variables a real AppImage/loader would set. The packaged main process must still see them (so the test is not
  // vacuous) while nothing a shell starts inherits them.
  const appDir = path.join(c.dir, 'AppDir');
  fs.mkdirSync(path.join(appDir, 'usr', 'bin'), { recursive: true });
  const injected = {
    APPDIR: appDir, APPIMAGE: path.join(c.dir, 'KKSS.AppImage'), ARGV0: 'kkss', OWD: c.dir,
    LD_LIBRARY_PATH: path.join(appDir, 'usr', 'lib'), GSETTINGS_SCHEMA_DIR: path.join(appDir, 'schemas'),
    PATH: `${path.join(appDir, 'usr', 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const app = await launch(undefined, process.platform === 'win32' ? {} : injected);
  const home = await c.page(app, 'home');
  const shell = await c.page(app, 'shell');
  await home.locator('#menu').waitFor();

  // Every native-menu item must be reachable or say why not: the same rule tools/smoke.e2e.mjs applies to out/.
  const menuReport = await app.evaluate(({ Menu }) => {
    const explained = [/\([^)]+\)\s*$/, /\s—\s.+$/];
    const leaves = [], bad = [];
    const walk = (items, trail) => { for (const item of items) {
      if (item.type === 'separator') continue;
      const label = (item.label ?? '').replace(/&/g, ''), here = [...trail, label || item.role || '?'];
      if (item.submenu) { walk(item.submenu.items, here); continue; }
      leaves.push(here.join(' > '));
      if (item.enabled === false && !String(item.id ?? '').startsWith('info:') && !explained.some((re) => re.test(label))) bad.push(here.join(' > '));
    } };
    const top = Menu.getApplicationMenu().items.map((i) => (i.label ?? '').replace(/&/g, ''));
    walk(Menu.getApplicationMenu().items, []);
    return { top, leaves, bad };
  });
  assert.deepEqual(menuReport.bad, [], `disabled menu items with no reason: ${menuReport.bad.join('; ')}`);
  for (const wanted of ['File', 'View', 'Settings', 'Help']) assert.ok(menuReport.top.includes(wanted), `top-level menu ${wanted} is missing (${menuReport.top.join(', ')})`);
  for (const wanted of ['Open Settings…', 'About KKSS…', 'Pre-Processing (CAD)', 'Post-Processing (Mesh)']) {
    assert.ok(menuReport.leaves.some((l) => l.endsWith(wanted) || l.includes(`${wanted} (`)), `menu item ${wanted} is missing`);
  }
  assert.ok(menuReport.leaves.length >= 30, `only ${menuReport.leaves.length} menu items`);

  // Negative control: the audit must flag an off-page, unnamed button, or a clean run proves nothing.
  await home.evaluate(() => {
    const bad = document.createElement('button'); bad.id = 'selftest-bad';
    bad.style.cssText = 'position:fixed;left:-500px;top:0;width:40px;height:20px';
    document.body.append(bad);
  });
  const control = (await auditPages(app, [{ name: 'home', page: home }], [1280])).join('\n');
  assert.match(control, /clipped horizontally: button#selftest-bad/, 'the layout audit missed an off-page control');
  assert.match(control, /button-name/, 'the layout audit missed an unnamed button');
  await home.evaluate(() => document.getElementById('selftest-bad')?.remove());

  // Clipped or unnamed controls at three widths, on the pages the app itself owns.
  await shell.locator('#chat-btn').click();
  const chat = await c.page(app, 'chat');
  const problems = await auditPages(app, [{ name: 'home', page: home }, { name: 'shell', page: shell }, { name: 'chat', page: chat }]);
  assert.deepEqual(problems, [], `layout problems in the packaged app:\n${problems.join('\n')}`);
  await shell.locator('#chat-btn').click();

  // Item 17: record the environment a shell hands to a user program, and assert nothing packager-shaped reaches it.
  const record = { platform: process.platform, arch: process.arch, binary: path.basename(binary), packaged: true, child: 'skipped on Windows (no POSIX env)' };
  if (process.platform !== 'win32') {
    // An AppImage's AppRun sets its own APPDIR/APPIMAGE/ARGV0/OWD, so only presence is asserted; the real APPDIR drives the PATH check.
    for (const name of Object.keys(injected)) assert.ok(await app.evaluate((_, key) => process.env[key], name), `the main process lost ${name}`);
    const mountDir = await app.evaluate(() => process.env.APPDIR);
    await shell.locator('#terminal-btn').click();
    const terminal = await c.page(app, 'terminal');
    const out = path.join(c.dir, 'child-env.txt');
    await terminal.locator('.xterm').first().click();
    await terminal.keyboard.type(`env | sort > '${out}'`);
    await terminal.keyboard.press('Enter');
    await until(async () => fs.existsSync(out) && fs.statSync(out).size > 0, 'the terminal shell wrote its environment', 60_000);
    // `env` ends with the newline the redirection flushes; give a partially written file one more poll.
    await new Promise((r) => setTimeout(r, 500));
    const lines = fs.readFileSync(out, 'utf8').split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l));
    const names = lines.map((l) => l.slice(0, l.indexOf('=')));
    const leaked = names.filter((n) => ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'GSETTINGS_SCHEMA_DIR', 'PYTHONHOME'].includes(n) || n.startsWith('ELECTRON_'));
    assert.deepEqual(leaked, [], `packager or Electron variables reached a child process: ${leaked.join(', ')}`);
    const pathValue = lines.find((l) => l.startsWith('PATH='))?.slice(5) ?? '';
    assert.ok(!pathValue.split(path.delimiter).some((e) => e.startsWith(mountDir)), 'a PATH entry inside the AppImage mount reached a child process');
    Object.assign(record, { child: 'recorded', stripped: Object.keys(injected).filter((n) => !names.includes(n)).sort(), remaining: [...new Set(names)].sort() });
  }
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test-results', `packaged-env-${process.platform}-${process.arch}.json`), JSON.stringify(record, null, 2));

  await quitApp(app);
});
