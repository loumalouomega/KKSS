import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, closeApp, diagnostics, appWindow, softwareGL, root } from '../e2eShared.mjs';
export * from '../e2eShared.mjs';
export { default as assert } from 'node:assert/strict';
/**
 * Chooses a row in the modal picker (`app/renderer/picker/picker.ts`) — the one
 * way the app's own file and save dialogs are driven from a test.
 *
 * Clicks the option ROW rather than the `<span>` label inside it. The row is
 * the element that carries the click handler (`row.addEventListener("click")`),
 * so clicking it is what a user does — and it is also what keeps the click from
 * losing a race with the picker's own teardown: choosing a row posts
 * `picker:toHost`, and the main process closes that window immediately, so a
 * click aimed at a descendant can surface as Playwright's "Target page, context
 * or browser has been closed" (CI run 36321308061, cloud-fail) even though the
 * click worked. A closed target is therefore treated as a completed click;
 * every caller asserts the real effect on its next line — a tab that opened, a
 * file that was written — so a click that genuinely did nothing still fails.
 */
export async function pickOption(picker, text) {
  await picker
    .getByRole('option')
    .filter({ hasText: text })
    .click()
    .catch((error) => {
      if (!/has been closed/.test(String(error))) throw error;
    });
}
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
