import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, closeApp, diagnostics, appWindow, softwareGL, root } from '../e2eShared.mjs';
export * from '../e2eShared.mjs';
export { default as assert } from 'node:assert/strict';
export async function scenario(name, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kkss-${name}-`));
  const launches = [];
  const ctx = {
    dir, profile: path.join(dir, 'profile'),
    copy(source, name = path.basename(source)) { const dest = path.join(dir, name); fs.copyFileSync(path.join(root, source), dest); return dest; },
    seed(state) { fs.mkdirSync(ctx.profile, { recursive: true }); fs.writeFileSync(path.join(ctx.profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', ...state })); },
    async launch(file, opts = {}) {
      const launched = await launchApp(file, { userDataDir: ctx.profile, extraArgs: softwareGL, ...opts });
      launched.process = launched.app.process(); launches.push(launched); return launched.app;
    },
    page(app, name) { return appWindow(app, `/renderer/${name}/`, Date.now() + 60_000); },
  };
  try { await run(ctx); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}:`, error); for (const [i, l] of launches.entries()) await diagnostics(l.app, l.output, `${name}-${i}`).catch(() => {}); throw error; }
  finally { for (const l of launches) if (l.process.exitCode === null) await closeApp(l.app); fs.rmSync(dir, { recursive: true, force: true }); }
}
