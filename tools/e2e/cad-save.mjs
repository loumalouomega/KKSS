import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { scenario, assert, selectFile, until, menu, quitApp } from './context.mjs';

// File ▸ Save in CAD mode bakes the unbaked edit tail into the source file
// (roadmap "Interactive bake"): confirmation, one-deep .bak, atomic replace,
// the watermark, the tab's dirty dot and the Save / Don't Save / Cancel prompt.
await scenario('cad-save', async c => {
  const step = c.copy('cad/examples/STP/block.stp', 'part.stp');
  const stl = c.copy('cad/examples/STL/cube.stl', 'cube.stl');
  const stepOriginal = fs.readFileSync(step);
  const stlOriginal = fs.readFileSync(stl, 'utf8');
  const sidecar = file => JSON.parse(fs.readFileSync(`${file}.edits.json`, 'utf8'));

  const app = await c.launch(step);
  const shell = await c.page(app, 'shell');
  const cad = await c.page(app, 'cad');
  await cad.locator('#doc-chip-name').getByText('part.stp', { exact: true }).waitFor();

  // Answers every native message box by the label of its first button, and
  // logs what was asked so the scenario can assert on prompts, not just outcomes.
  const answer = answers => app.evaluate(({ dialog }, answers) => {
    globalThis.dialogLog = [];
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.dialogLog.push(options.buttons.join('|'));
      const response = answers[options.buttons[0]] ?? options.cancelId ?? options.buttons.length - 1;
      return { response, checkboxChecked: false };
    };
  }, answers);
  const asked = () => app.evaluate(() => globalThis.dialogLog);
  const edit = (page, ops) => page.evaluate(ops => window.__kkss.post({ type: 'editsChanged', ops, variables: [] }), ops);
  const move = (target, x) => ({ op: 'translate', targets: [target], vec: [x, 0, 0] });
  const dot = () => shell.locator('.tab.active .ui-dot');

  console.log('cad save: first save asks, then bakes');
  await edit(cad, [move('solid-0', 10)]);
  await dot().waitFor();
  assert.match(await cad.locator('#doc-chip-unsaved').textContent(), /1 unsaved edit/);

  await answer({ 'Save in place': 1 });
  await menu(app, 'Save');
  await until(async () => (await asked()).includes('Save in place|Cancel'), 'first save asks for confirmation');
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(fs.readFileSync(step), stepOriginal, 'Cancel writes nothing');
  assert.equal(fs.existsSync(`${step}.bak`), false, 'Cancel makes no backup');
  await dot().waitFor();

  await answer({ 'Save in place': 0 });
  await menu(app, 'Save');
  await dot().waitFor({ state: 'detached' });
  assert.notDeepEqual(fs.readFileSync(step), stepOriginal, 'the source now holds the edit');
  assert.deepEqual(fs.readFileSync(`${step}.bak`), stepOriginal, 'the one-deep backup holds the pre-save bytes');
  assert.equal(fs.readdirSync(c.dir).some(name => name.includes('.save-tmp.')), false, 'no temp sibling left behind');
  assert.equal(sidecar(step).bakedThrough, 1);
  await until(async () => (await cad.locator('#doc-chip-unsaved').textContent()).trim() === '', 'chip clears');

  console.log('cad save: a later save does not ask or re-back-up');
  const afterFirst = fs.readFileSync(step);
  await answer({});
  await edit(cad, [move('solid-0', 10), move('solid-0', 5)]);
  await dot().waitFor();
  await menu(app, 'Save');
  await dot().waitFor({ state: 'detached' });
  assert.deepEqual(await asked(), [], 'no confirmation after the first save of the session');
  assert.deepEqual(fs.readFileSync(`${step}.bak`), stepOriginal, 'the backup stays one-deep');
  assert.notDeepEqual(fs.readFileSync(step), afterFirst);
  assert.equal(sidecar(step).bakedThrough, 2);

  console.log('cad save: closing a dirty tab prompts');
  await edit(cad, [move('solid-0', 10), move('solid-0', 5), move('solid-0', 1)]);
  await dot().waitFor();
  await answer({ Save: 2 });
  await shell.locator('.tab.active .tab-close').click();
  await until(async () => (await asked()).includes("Save|Don't Save|Cancel"), 'close asks');
  assert.equal(await shell.locator('.tab', { hasText: 'part.stp' }).count(), 1, 'Cancel keeps the tab');
  const beforeDiscard = fs.readFileSync(step);
  await answer({ Save: 1 });
  await shell.locator('.tab.active .tab-close').click();
  await until(async () => (await shell.locator('.tab', { hasText: 'part.stp' }).count()) === 0, "Don't Save closes the tab");
  assert.deepEqual(fs.readFileSync(step), beforeDiscard, "Don't Save leaves the source alone");
  assert.equal(sidecar(step).ops.length, 3, "Don't Save still keeps the edits beside the file");
  assert.equal(sidecar(step).bakedThrough, 2);

  console.log('cad save: Save from the close prompt bakes before the tab goes');
  await selectFile(app, step);
  await shell.locator('#open-btn').click();
  const reopened = await c.page(app, 'cad');
  await reopened.locator('#doc-chip-name').getByText('part.stp', { exact: true }).waitFor();
  await dot().waitFor();
  await answer({ Save: 0, 'Save in place': 0 });
  await shell.locator('.tab.active .tab-close').click();
  await until(async () => sidecar(step).bakedThrough === 3, 'Save bakes the remaining tail');
  await until(async () => (await shell.locator('.tab', { hasText: 'part.stp' }).count()) === 0, 'Save then closes the tab');

  console.log('cad save: a mesh source bakes inside the recoverable transaction');
  await selectFile(app, stl);
  await shell.locator('#open-btn').click();
  const mesh = await c.page(app, 'cad');
  await mesh.locator('#doc-chip-name').getByText('cube.stl', { exact: true }).waitFor();
  await edit(mesh, [move('node-0', 10)]);
  await dot().waitFor();
  await answer({ 'Save in place': 0 });
  await menu(app, 'Save');
  await dot().waitFor({ state: 'detached' });
  const minX = text => Math.min(...[...text.matchAll(/vertex\s+(\S+)/g)].map(m => Number(m[1])));
  const binaryMinX = bytes => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let min = Infinity;
    for (let i = 0; i < view.getUint32(80, true); i++) for (let v = 0; v < 3; v++) min = Math.min(min, view.getFloat32(84 + i * 50 + 12 + v * 12, true));
    return min;
  };
  assert.ok(Math.abs(binaryMinX(fs.readFileSync(stl)) - (minX(stlOriginal) + 10)) < 1e-3, 'the STL on disk is translated by exactly the edit');
  assert.equal(fs.readFileSync(`${stl}.bak`, 'utf8'), stlOriginal, 'the backup is the original STL');
  assert.equal(fs.existsSync(`${stl}.save-journal.json`), false, 'the save transaction is closed');
  assert.equal(sidecar(stl).bakedThrough, 1);

  // A dirty tab and a live shell together. The quit prompt's Cancel must leave
  // the shell running (the quit hold only waits once no prompt can cancel), and
  // a quit that goes through must reap the shell before the app exits.
  if (process.platform !== 'win32') {
    console.log('cad save: a cancelled quit keeps the shell, a finished quit reaps it');
    // The viewer sends its whole ops list: the first op is already baked, so
    // sending only the new one would leave nothing unbaked and no dirty dot.
    await edit(mesh, [move('node-0', 10), move('node-0', 5)]);
    await dot().waitFor();
    await shell.locator('#terminal-btn').click();
    const appPid = app.process().pid;
    const shellName = path.basename(process.env.SHELL || '/bin/bash');
    const shellPids = () => execSync('ps -eo pid,ppid,comm', { encoding: 'utf8' }).split('\n').slice(1)
      .map(row => row.trim().split(/\s+/))
      .filter(([, ppid, comm]) => Number(ppid) === appPid && comm === shellName)
      .map(([pid]) => Number(pid));
    // A zombie has exited but is not reaped yet, so it does not count as running.
    const running = pid => execSync(`ps -o stat= -p ${pid} || true`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().match(/^[^Z]/) !== null;
    await until(async () => shellPids().length > 0, 'the terminal shell starts');
    const shells = shellPids();

    await answer({ Save: 2 });
    await app.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await until(async () => (await asked()).includes("Save|Don't Save|Cancel"), 'quit asks about the dirty tab');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(app.process().exitCode, null, 'Cancel keeps the app running');
    assert.ok(shells.every(pid => running(pid)), 'Cancel leaves the shell running');

    await answer({ Save: 1 });
    await quitApp(app);
    assert.ok(shells.every(pid => !running(pid)), 'a finished quit has reaped the shell');
  }
});
