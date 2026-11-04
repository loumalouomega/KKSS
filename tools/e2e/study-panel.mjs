import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, until } from './context.mjs';

// Roadmap item 9: the study panel mirrors the project's studies beside the
// viewers, opens a stage in its viewer, and shares the right-hand slot with Chat/Jobs.
await scenario('study-panel', async c => {
  c.seed({ projectRoot: c.dir });
  const geometry = c.copy('cad/examples/STP/block.stp');
  const app = await c.launch();
  const home = await c.page(app, 'home');
  await home.locator('#study-create:enabled').waitFor();
  await home.locator('#study-create').click();
  await home.locator('#workflow-input-source').fill(geometry);
  await home.locator('#workflow-input-name').fill('Block');
  await home.locator('#workflow-form [type=submit]').click();
  await home.locator('#workflow-form').waitFor({ state: 'hidden' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, '.kkss/project.json'), 'utf8')).studies.length, 1);

  const shell = await c.page(app, 'shell');
  await shell.locator('#mode-cad, [data-mode=cad]').first().click();
  await shell.locator('#study-btn').click();
  const study = await c.page(app, 'study');
  await until(async () => await study.locator('.study').count() === 1, 'study chain listed');
  assert.equal(await shell.locator('#study-btn').getAttribute('aria-pressed'), 'true');
  assert.equal(await study.locator('.study .stage').count(), 5, 'five stages');
  assert.match(await study.locator('.study-name').textContent(), /Block/);
  // Geometry is attached and readable; there is no mesh yet, so Open is disabled there.
  assert.equal(await study.locator('.stage').nth(0).locator('button').isEnabled(), true);
  assert.equal(await study.locator('.stage').nth(1).locator('button').isEnabled(), false);

  if (process.env.KKSS_STUDY_SHOT) { await study.locator('h1').hover(); await study.screenshot({ path: process.env.KKSS_STUDY_SHOT }); }

  // Open geometry shows the model in the CAD viewer.
  await study.locator('.stage').nth(0).locator('button').click();
  await until(async () => /block/i.test(await shell.locator('#file-title').textContent() ?? '') ||
    (await shell.locator('.tab-title, .tab').allTextContents()).some(t => /block/i.test(t)), 'geometry opened in its viewer');

  // Shares the right-hand slot: opening Chat closes the panel.
  await shell.locator('#chat-btn').click();
  await until(async () => await shell.locator('#study-btn').getAttribute('aria-pressed') === 'false', 'chat replaces the study panel');
  await shell.locator('#study-btn').click();
  await until(async () => await shell.locator('#study-btn').getAttribute('aria-pressed') === 'true', 'panel reopens');
  await study.keyboard.press('Escape');
  await until(async () => await shell.locator('#study-btn').getAttribute('aria-pressed') === 'false', 'Escape closes the panel');
});
