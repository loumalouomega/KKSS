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

/** The case's latest file of one participant family, opened through the shell
 *  window's Post-Processing mode and Open… — the user's own path for a result
 *  file the Problemtype sidebar's single `Open results` did not pick. */
async function openParticipant(app, dir, family, deadline) {
  const files = fs.readdirSync(path.join(dir, 'vtk_output')).filter((n) => n.startsWith(family) && n.endsWith('.vtk'));
  assert.ok(files.length, `no ${family} output in ${dir}/vtk_output`);
  const latest = files.sort((a, b) => Number(a.match(/_(\d+)\.vtk$/)[1]) - Number(b.match(/_(\d+)\.vtk$/)[1])).at(-1);
  const shell = await appWindow(app, '/renderer/shell/', deadline);
  await shell.locator('#mode-mesh').click();
  await selectFile(app, path.join(dir, 'vtk_output', latest));
  await shell.locator('#open-btn').click();
  let found;
  await until(async () => {
    for (const page of app.windows().filter(p => p.url().includes('/renderer/mesh/'))) {
      if (await page.locator('#doc-chip-name').textContent().catch(() => '') === latest) { found = page; return true; }
    }
    return false;
  }, `${latest} opens in a viewer`, 120000);
  return found;
}

export async function manualTutorials(out, selected = []) {
  for (const c of cases.filter(c => !selected.length || selected.includes(c.id))) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-tutorial-'));
    const dir = path.join(temp, c.id), profile = path.join(temp, 'profile');
    fs.cpSync(path.join(root, 'doc/public/examples/tutorials', c.id), dir, { recursive: true });
    // Author case settings in the actual sidebar and export a new mesh in CAD.
    for (const name of fs.readdirSync(dir)) if (name === 'vtk_output' || /^(mesh.*|ProjectParameters.*\.json|.*Materials\.json|MainKratos.*\.py|kkss-convergence.*\.jsonl)$/.test(name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
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
      // Coupled problemtypes carry one card per section (coupling, fluid,
      // structure) and all but the first start collapsed; every field must be
      // visible before the form can be filled by data-field.  Click through the
      // app's own toggles so its persisted collapse state stays consistent.
      while (await mesh.locator('#pt-forms .pt-card.collapsed > .edit-form-title').count() > 0) {
        await mesh.locator('#pt-forms .pt-card.collapsed > .edit-form-title').first().click();
      }
      while (await mesh.locator('#pt-forms .pt-group.collapsed > .pt-group-header').count() > 0) {
        await mesh.locator('#pt-forms .pt-group.collapsed > .pt-group-header').first().click();
      }
      // Coupled cases keep section-keyed values; the sidebar form is flat.
      const formValues = c.values ? Object.assign({}, ...Object.values(c.values)) : c.problem;
      await values(mesh.locator('#pt-forms'), formValues);
      for (const a of c.assignments) {
        // A Parts-style pseudo-condition (which SubModelParts form the computing
        // domain) is filed in its own Domain card — one per physics domain,
        // each with a single-choice dropdown — and is deliberately absent from
        // the Conditions card's grouped add-row.
        const partsCard = await mesh.evaluate((id) => {
          const cards = Array.from(document.querySelectorAll('#pt-parts .pt-card'));
          return cards.findIndex((card) => Array.from(card.querySelectorAll('select.pt-add-what option')).some((o) => o.value === id));
        }, a.conditionId);
        const host = partsCard >= 0 ? mesh.locator('#pt-parts .pt-card').nth(partsCard) : mesh.locator('#pt-assignments');
        if (partsCard < 0) await mesh.selectOption('#pt-assignments .pt-add-what', a.conditionId);
        await host.locator('select.pt-add-where').selectOption(a.smpPath);
        await host.locator('.pt-add-row button').click();
        await values(host.locator('.pt-assign').last(), a.values);
      }
      for (const m of c.materials) {
        await mesh.selectOption('#pt-materials .pt-add-what', m.lawId);
        await mesh.selectOption('#pt-materials .pt-add-where', m.smpPath);
        await mesh.locator('#pt-materials .pt-add-row button').click();
        await values(mesh.locator('#pt-materials .pt-assign').last(), m.values);
      }
      await mesh.locator('#pt-generate').click();
      await until(() => fs.existsSync(path.join(dir, c.primaryDocument ?? 'ProjectParameters.json')), 'Generate case files');
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
      const resultPages = [];
      await until(async () => {
        for (const page of app.windows().filter(p => p.url().includes('/renderer/mesh/'))) {
          const name = await page.locator('#doc-chip-name').textContent().catch(() => '');
          if (name.includes('.vtk') && !resultPages.includes(page)) resultPages.push(page);
        }
        return resultPages.length > 0;
      }, 'Open results creates VTK tab', 60000);
      const shotField = async (result, field, shot) => {
        await result.locator('#toolbar button[data-action="field"]').click();
        const selector = result.locator('#field-panel select').first();
        await selector.waitFor();
        const options = await selector.locator('option').evaluateAll(els => els.map(el => ({ text: el.textContent, value: el.value })));
        const choice = options.find(o => o.text.startsWith(field + ' '));
        assert.ok(choice, `Missing ${field}`);
        await selector.selectOption(choice.value);
        await result.locator('#toolbar button[data-action="reset"]').click();
        await sleep(1800);
        if (out) await result.screenshot({ path: path.join(out, shot) });
        return { result, selector, options };
      };
      let result, selector, options, choice;
      if (c.structureField) {
        // `Open results` opens ONE tab: the case's latest result file (most
        // steps wins across families, ties by name — the fluid participant
        // here), not a tab per participant. The second participant is opened
        // the way any result file is — the shell window's Post-Processing mode
        // and Open…, the same dialog flow tools/e2e/lifecycle.mjs drives — and
        // its field is captured from the viewer the app opens for it.
        const names = await Promise.all(resultPages.map(p => p.locator('#doc-chip-name').textContent().catch(() => '')));
        result = resultPages[names.findIndex(n => n.startsWith('Fluid'))] ?? resultPages[0];
        ({ selector, options } = await shotField(result, c.field, `tutorial-${c.id}-results.png`));
        const structPage = await openParticipant(app, dir, 'Structure', deadline);
        await shotField(structPage, c.structureField, `tutorial-${c.id}-structure.png`);
      } else {
        result = resultPages[0];
        ({ selector, options } = await shotField(result, c.field, `tutorial-${c.id}-results.png`));
        choice = options.find(o => o.text.startsWith(c.field + ' '));
      }
      if (c.id === 'fluid') {
        const pressure = options.find(o => o.text.startsWith('PRESSURE '));
        assert.ok(pressure, 'Missing PRESSURE');
        await selector.selectOption(pressure.value);
        await sleep(700);
        if (out) await result.screenshot({ path: path.join(out, 'tutorial-fluid-pressure.png') });
      }
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
