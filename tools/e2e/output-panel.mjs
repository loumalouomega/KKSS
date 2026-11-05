/**
 * The bottom Output panel: several terminals side by side, the Messages / Progress /
 * Log tabs fed by real app activity, and the memory footer. With
 * KKSS_OUTPUT_SHOT_DIR set it also writes the four documentation captures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, until, selectFile } from './context.mjs';
await scenario('output-panel', async c => {
  const shotDir = process.env.KKSS_OUTPUT_SHOT_DIR;
  const cadFile = c.copy('cad/examples/STP/bull.stp');
  const meshFile = c.copy('mesh/example/MDPA/double_arch.mdpa');
  // A plain POSIX shell for the captures: no personal prompt or banner in the committed images.
  if (shotDir && process.platform !== 'win32') c.seed({ terminalShell: '/bin/sh' });
  const app = await c.launch(cadFile);
  const shell = await c.page(app, 'shell');
  if (shotDir) await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1760, 1100));
  const cad = await c.page(app, 'cad');
  await cad.waitForSelector('#app', { state: 'attached' });
  await until(async () => (await shell.locator('.tab.active').textContent())?.includes('bull'), 'the model opens');

  await shell.locator('#terminal-btn').click();
  const panel = await c.page(app, 'terminal');
  await panel.locator('.xterm').first().waitFor();
  const shot = async (name) => { if (shotDir) { fs.mkdirSync(shotDir, { recursive: true }); await panel.screenshot({ path: path.join(shotDir, name) }); } };

  // Four tabs, Terminal first and selected.
  assert.deepEqual(await panel.locator('#tabs button').evaluateAll(b => b.map(x => x.dataset.tab)), ['terminal', 'messages', 'progress', 'log']);
  assert.equal(await panel.locator('#tab-terminal').getAttribute('aria-selected'), 'true');

  // Several terminals: each has its own shell, output stays with its own session.
  await panel.evaluate(() => { window.e2eOut = {}; window.termApi.onMessage(m => { if (m.type === 'data') window.e2eOut[m.id] = (window.e2eOut[m.id] ?? '') + m.data; }); });
  assert.equal(await panel.locator('#term-list').isHidden(), true, 'a single terminal shows no list');
  await panel.locator('#term-new').click();
  await until(async () => await panel.locator('.term-item').count() === 2, 'second terminal');
  assert.equal(await panel.locator('#term-list').isVisible(), true);
  assert.equal(await panel.locator('.term-host:not([hidden])').count(), 1, 'one terminal visible');
  const type = async (text) => { await panel.locator('.term-host:not([hidden]) .xterm-helper-textarea').focus(); await panel.keyboard.type(text); await panel.keyboard.press('Enter'); };
  await type("printf 'KKSS_%s\\n' SECOND");
  await until(async () => (await panel.evaluate(() => window.e2eOut[2] ?? '')).includes('KKSS_SECOND'), 'second terminal output');
  await panel.locator('.term-item').first().click();
  await type("printf 'KKSS_%s\\n' FIRST");
  await until(async () => (await panel.evaluate(() => window.e2eOut[1] ?? '')).includes('KKSS_FIRST'), 'first terminal output');
  assert.equal((await panel.evaluate(() => window.e2eOut[2])).includes('KKSS_FIRST'), false, 'sessions do not share input');
  await type('ls bull.stp');
  await shot('output-terminal.png');

  // Switching tabs never kills a shell, and a reloaded panel reattaches instead of respawning.
  await panel.locator('#tab-messages').click();
  await panel.locator('#tab-terminal').click();
  await panel.reload();
  await until(async () => await panel.locator('.term-item').count() === 2, 'sessions come back after a reload');
  await until(async () => (await panel.locator('.xterm-rows').allTextContents()).join('').includes('KKSS_FIRST'), 'scrollback is replayed');

  // Messages: what the app did, read back.
  await panel.locator('#tab-messages').click();
  await until(async () => (await panel.locator('#messages').textContent())?.includes('Opened bull.stp'), 'open is logged');
  // Real CAD work: two meshing jobs show on the Progress tab while they run (the second waits its turn).
  await cad.evaluate(() => { for (const n of [1, 2]) window.__kkss.post({ type: 'meshingGenerate', requestId: `e2e-output-${n}`, options: { sizeMax: 4 } }); });
  await panel.locator('#tab-progress').click();
  await until(async () => await panel.locator('.prog-row').count() === 2, 'both meshing jobs are listed');
  assert.match(await panel.locator('.prog-row').first().textContent(), /Generating FE mesh/);
  assert.equal(await panel.locator('.prog-row button').count() >= 1, true, 'a running CAD job can be cancelled');
  await shot('output-progress.png');
  await until(async () => (await panel.locator('.prog-row').allTextContents()).every(t => /Done|Failed/.test(t)), 'the jobs finish', 120_000);
  assert.equal((await panel.locator('.prog-row').allTextContents()).some(t => /Failed/.test(t)), false);
  await panel.locator('#progress-clear').click();
  await until(async () => await panel.locator('.prog-row').count() === 0, 'Clear finished empties the list');
  // Opening a second document in the other mode is logged too.
  await shell.locator('#mode-mesh').click(); await selectFile(app, meshFile); await shell.locator('#open-btn').click();
  await until(async () => (await panel.locator('#tab-messages').click(), (await panel.locator('#messages').textContent())?.includes('Opened double_arch.mdpa')), 'second open is logged');
  assert.match(await panel.locator('#messages').textContent(), /Mesh generated: \d+ nodes, \d+ elements/);

  // The renderer's own progress rendering, with a cancellable, determinate item.
  await app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find(w => w.getURL().includes('/renderer/terminal/'));
    wc.send('out:toWebview', { type: 'progress', items: [{ id: 9001, source: 'solver', label: 'case_cantilever · step 120', state: 'running', fraction: 0.4, startedAt: Date.now() - 5400, cancellable: true }] });
  });
  await until(async () => (await panel.locator('.prog-row').first().textContent())?.includes('40%'), 'determinate progress');
  assert.equal(await panel.locator('.prog-row button').count(), 1, 'a cancellable item has Cancel');
  assert.equal(await panel.locator('#tab-progress .badge').textContent(), '1');
  await app.evaluate(({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().includes('/renderer/terminal/')).send('out:toWebview', { type: 'progress', items: [] }));
  await until(async () => await panel.locator('#tab-progress .badge').isHidden(), 'badge clears with the running count');

  // Log: console output reaches the tab live.
  await app.evaluate(() => { console.warn('e2e output-panel warning line'); });
  await panel.locator('#tab-log').click();
  await until(async () => (await panel.locator('#log').textContent())?.includes('e2e output-panel warning line'), 'log line');

  // Messages: the level filter and Clear.
  await panel.locator('#tab-messages').click();
  await panel.locator('#level-filter').selectOption('error');
  assert.equal(await panel.locator('#messages .out-row').count(), 0);
  await panel.locator('#level-filter').selectOption('all');
  assert.ok(await panel.locator('#messages .out-row').count() > 0);
  await shot('output-messages.png');
  await panel.locator('#messages-clear').click();
  await until(async () => await panel.locator('#messages .out-row').count() === 0, 'Clear empties Messages');

  // Memory footer: application and system use.
  await until(async () => /App \d+\.\d\d GB \| System \d+\.\d\d \/ \d+\.\d\d GB/.test(await panel.locator('#memory').textContent() ?? ''), 'memory readout');

  // Killing a terminal removes it; the last one leaves an empty state, not a dead pane.
  await panel.locator('#tab-terminal').click();
  await panel.locator('.term-item').last().locator('.term-item-close').click();
  await until(async () => await panel.locator('.term-item').count() === 1, 'terminal killed');
  await panel.locator('#term-kill').click();
  await until(async () => await panel.locator('#term-empty').isVisible(), 'empty state');
  await panel.locator('#term-empty-new').click();
  await panel.locator('.xterm').first().waitFor();
});
