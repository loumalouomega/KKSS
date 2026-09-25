import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { launchApp, appWindow, closeApp, until, selectFile, softwareGL, diagnostics, sleep } from '../e2eShared.mjs';
import { root, python } from './mcp.mjs';
import { cases } from './cases.mjs';

async function values(container, values) {
  for (const [key, value] of Object.entries(values)) {
    const row = container.locator(`[data-field="${key}"]`);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { await row.locator('input').nth(i).fill(String(value[i])); await row.locator('input').nth(i).press('Tab'); }
    } else if (typeof value === 'boolean') await row.locator('input').setChecked(value);
    else if (await row.locator('select').count()) await row.locator('select').selectOption(String(value));
    else { await row.locator('input').fill(String(value)); await row.locator('input').press('Tab'); }
  }
}

export async function manualTutorials(out, selected = []) {
  for (const c of cases.filter(c => !selected.length || selected.includes(c.id))) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-tutorial-'));
    const dir = path.join(temp, c.id), profile = path.join(temp, 'profile');
    fs.cpSync(path.join(root, 'doc/public/examples/tutorials', c.id), dir, { recursive: true });
    // Author case settings in the actual sidebar and export a new mesh in CAD.
    for (const name of fs.readdirSync(dir)) if (name === 'vtk_output' || /^(mesh.*|ProjectParameters.json|.*Materials.json|MainKratos.py)$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', 'kratos.pythonPath': python, 'kratos.extraEnv': { OMP_NUM_THREADS: '2' } }));
    const { app, output } = await launchApp(path.join(dir, c.geometry), { userDataDir: profile, extraArgs: [...softwareGL, '--force-device-scale-factor=2'], env: { OMP_NUM_THREADS: '2', KKSS_KRATOS_PYTHON: python } });
    try {
      await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1440, 1100));
      const deadline = Date.now() + 120000;
      const cad = await appWindow(app, '/renderer/cad/', deadline);
      await until(() => output().includes('[cad] host → webview: geometry'), 'CAD geometry', 120000);
      await cad.locator('#doc-chip-name').getByText(c.geometry, { exact: true }).waitFor();
      await sleep(1200); // allow the WebGL frame to settle before capturing
      if (out) await cad.screenshot({ path: path.join(out, `tutorial-${c.id}-geometry.png`) });
      await cad.locator('#meshing-toggle').click();
      await cad.selectOption('#meshing-export-format', 'mdpaElements');
      await cad.selectOption('#meshing-export-unit', 'm');
      await selectFile(app, path.join(dir, 'mesh.mdpa'), true);
      await cad.locator('#meshing-export').click();
      await until(() => fs.existsSync(path.join(dir, 'mesh.mdpa')), 'CAD MDPA export', 120000);
      let mesh;
      await until(async () => {
        for (const page of app.windows().filter(p => p.url().includes('/renderer/mesh/'))) {
          if (await page.locator('#doc-chip-name').textContent().catch(() => '') === 'mesh.mdpa' && await page.locator('#pt-select option').count() > 1) { mesh = page; return true; }
        }
        return false;
      }, 'exported mesh catalog', 60000);
      await mesh.locator('#pt-select').selectOption(c.problemtype);
      for (const section of ['layers', 'edit', 'variables', 'meshmod']) {
        const expanded = mesh.locator(`.sb-section[data-section="${section}"]:not(.collapsed) > .sb-section-header .panel-chevron`);
        if (await expanded.count()) await expanded.click();
      }
      await values(mesh.locator('#pt-forms'), c.problem);
      for (const a of c.assignments) {
        await mesh.selectOption('#pt-assignments .pt-add-what', a.conditionId);
        await mesh.selectOption('#pt-assignments .pt-add-where', a.smpPath);
        await mesh.locator('#pt-assignments .pt-add-row button').click();
        await values(mesh.locator('#pt-assignments .pt-assign').last(), a.values);
      }
      for (const m of c.materials) {
        await mesh.selectOption('#pt-materials .pt-add-what', m.lawId);
        await mesh.selectOption('#pt-materials .pt-add-where', m.smpPath);
        await mesh.locator('#pt-materials .pt-add-row button').click();
        await values(mesh.locator('#pt-materials .pt-assign').last(), m.values);
      }
      await mesh.locator('#pt-generate').click();
      await until(() => fs.existsSync(path.join(dir, 'ProjectParameters.json')), 'Generate case files');
      await mesh.locator('#pt-select').scrollIntoViewIfNeeded();
      if (out) await mesh.screenshot({ path: path.join(out, `tutorial-${c.id}-setup.png`) });
      await until(async () => await mesh.locator('#pt-run').isEnabled(), 'manual interpreter ready', 60000);
      await mesh.locator('#pt-run').click();
      await until(() => {
        const receipt = path.join(dir, 'mesh.kratosrun.json');
        if (!fs.existsSync(receipt)) return false;
        const state = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        if (state.exitCode !== undefined && state.exitCode !== 0) throw Error(JSON.stringify(state));
        return state.exitCode === 0;
      }, 'manual solver completion', 180000);
      const report = JSON.parse(execFileSync(python, [path.join(root, 'tools/tutorials/verify.py'), c.id, dir], { encoding: 'utf8' }));
      await mesh.locator('#pt-open-results').click();
      let result;
      await until(async () => {
        for (const page of app.windows().filter(p => p.url().includes('/renderer/mesh/'))) {
          const name = await page.locator('#doc-chip-name').textContent().catch(() => '');
          if (name.includes('.vtk')) { result = page; return true; }
        }
        return false;
      }, 'Open results creates VTK tab', 60000);
      await result.locator('#toolbar button[data-action="field"]').click();
      const selector = result.locator('#field-panel select').first();
      await selector.waitFor();
      const options = await selector.locator('option').evaluateAll(els => els.map(el => ({ text: el.textContent, value: el.value })));
      const choice = options.find(o => o.text.startsWith(c.field + ' '));
      assert.ok(choice, `Missing ${c.field}`);
      await selector.selectOption(choice.value);
      await result.locator('#toolbar button[data-action="reset"]').click();
      await sleep(1800);
      if (out) await result.screenshot({ path: path.join(out, `tutorial-${c.id}-results.png`) });
      if (c.id === 'structural') {
        const deformedMode = result.locator('.field-mode-btn').filter({ hasText: 'Deformed' });
        await deformedMode.click();
        const deformForm = result.locator('.field-subform').filter({ hasText: 'Deform by' });
        await deformForm.locator('select').selectOption(choice.value);
        const warpScale = deformForm.locator('input[type="range"]');
        assert.equal(await warpScale.getAttribute('max'), '1000');
        await warpScale.evaluate(el => { el.value = '1000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        assert.match(await deformedMode.getAttribute('class') ?? '', /active/);
        assert.equal(await warpScale.inputValue(), '1000');
        await result.locator('body').press('3'); // standard +Y / Top view exposes the X-Z bending plane
        await sleep(700);
        if (out) await result.screenshot({ path: path.join(out, 'tutorial-structural-deformed.png') });
        await selector.selectOption(options.find(o => o.text.startsWith('VON_MISES_STRESS ')).value);
        await sleep(600);
        if (out) await result.screenshot({ path: path.join(out, 'tutorial-structural-stress.png') });
      }
      console.log(`PASS manual tutorial ${c.id}: ${report.nodes} nodes; solver and physical checks passed`);
    } catch (error) {
      await diagnostics(app, output, `tutorial-${c.id}`).catch(() => {});
      throw error;
    } finally { await closeApp(app); fs.rmSync(temp, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await manualTutorials(path.join(root, 'doc/public/screenshots'), process.argv.slice(2));
}
