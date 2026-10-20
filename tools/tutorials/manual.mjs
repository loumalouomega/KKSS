#!/usr/bin/env node
// The setup half of each tutorial, replayed in the real app: the CAD geometry,
// the CAD MDPA export, the Problemtype sidebar (values, Parts, Conditions,
// Materials) and Generate. It takes the geometry, mesh and setup-card shots
// that shots.mjs declares for each case. The solver is not run here: results
// come from tools/tutorials/gallery.mjs, which reads the recovered output.
//
//   node tools/tutorials/manual.mjs [case ...]
//   node tools/tutorials/manual.mjs --fit-cad   (the mesh → CAD example's two CAD shots)
//   node tools/tutorials/manual.mjs --openscad   (the OpenSCAD example's two CAD shots)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { closeApp, appWindow, selectFile, sleep, until, diagnostics } from '../e2eShared.mjs';
import { root, python } from './mcp.mjs';
import { cases } from './cases.mjs';
import { CATALOG } from './shots.mjs';
import { canvasShot, command, feMeshShot, fit, launchWindow, partsShot, seedView, resetView, waitForDocument } from './capture.mjs';

const screenshots = path.join(root, 'doc/public/screenshots');

/** Fills `[data-field]` rows of a card from a plain value map (arrays fill the row's inputs in order). */
async function values(container, entries) {
  for (const [key, value] of Object.entries(entries)) {
    try {
      await valueRow(container, key, value);
    } catch (error) {
      throw new Error(`field ${key} (${JSON.stringify(value)}): ${error.message.split("\n")[0]}`);
    }
  }
}

async function valueRow(container, key, value) {
  {
    const row = container.locator(`[data-field="${key}"]`);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        await row.locator('input').nth(i).fill(String(value[i]));
        await row.locator('input').nth(i).press('Tab');
      }
    } else if (typeof value === 'boolean') await row.locator('input').setChecked(value);
    else if (await row.locator('select').count()) await row.locator('select').selectOption(String(value));
    else {
      // A read-only input already holds the form default; typing into it would wait forever.
      const input = row.locator('input').first();
      if (!(await input.isEditable().catch(() => false))) return;
      await input.fill(String(value));
      await input.press('Tab');
    }
  }
}

/**
 * Screenshots the sidebar region covering `locators` (the union of their
 * boxes, after scrolling the first into view) with a page-level clip. Only
 * the sidebar is in the clip, so the canvas never moves.
 */
async function sectionShot(page, locators, file, zoom = 1) {
  await locators[0].scrollIntoViewIfNeeded();
  await sleep(300);
  const boxes = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    if (box && box.height > 0) boxes.push(box);
  }
  assert.ok(boxes.length, `no visible card for ${file}`);
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  // Never past the sidebar itself: its scrolling edge and the command line below are not part of the card.
  const side = await page.locator('#sidebar').boundingBox();
  const clipTop = Math.max(side ? side.y : 0, top - 6);
  const clipBottom = Math.min(side ? side.y + side.height : bottom, bottom + 6);
  // page.screenshot takes its clip in zoom-independent units, boundingBox in zoomed ones.
  const clip = { x: (left - 6) * zoom, y: clipTop * zoom, width: (right - left + 12) * zoom, height: (clipBottom - clipTop) * zoom };
  let previous = null;
  for (let i = 0; i < 8; i++) {
    const png = await page.screenshot({ clip, timeout: 30_000 });
    if (previous && png.equals(previous)) { fs.writeFileSync(file, png); return png.length; }
    previous = png;
    await sleep(250);
  }
  fs.writeFileSync(file, previous);
  return previous.length;
}

/** Expands every collapsed card and group so their fields are in the DOM and on screen. */
async function expandAll(mesh) {
  for (const section of ['layers', 'edit', 'variables', 'mesh-mod']) {
    const expanded = mesh.locator(`.sb-section[data-section="${section}"]:not(.collapsed) > .sb-section-header .panel-chevron`);
    if (await expanded.count()) await expanded.click();
  }
  while (await mesh.locator('#pt-forms .pt-card.collapsed > .edit-form-title').count() > 0) {
    await mesh.locator('#pt-forms .pt-card.collapsed > .edit-form-title').first().click();
  }
  while (await mesh.locator('#pt-forms .pt-group.collapsed > .pt-group-header').count() > 0) {
    await mesh.locator('#pt-forms .pt-group.collapsed > .pt-group-header').first().click();
  }
}

/** Set by --shot=<file>: only that catalog shot is written (the setup still runs to reach it). */
let onlyShot = null;

/**
 * Grows the window until every card's bottom edge is inside the sidebar, so a capture of the stack is not cut
 * off by the sidebar's edge. Returns true when the window had to grow.
 */
/** Sets the zoom factor of the mesh viewer's view (the factor View > Zoom applies); returns the previous one. */
async function setMeshZoom(app, factor) {
  return app.evaluate(({ webContents }, f) => {
    const view = webContents.getAllWebContents().find((c) => c.getURL().includes('/renderer/mesh/'));
    const previous = view.getZoomFactor();
    view.setZoomFactor(f);
    return previous;
  }, factor);
}

/**
 * Steps the mesh viewer's zoom down until the whole Problemtype stack, its Generate button included, sits inside
 * the sidebar. At 1500 px the stack is taller than the sidebar and a taller window does not reflow the viewer here.
 * Returns the zoom that was applied (null at 100%).
 */
async function fitStackByZoom(app, mesh, locators) {
  for (const factor of [1, 0.9, 0.85, 0.8]) {
    await setMeshZoom(app, factor);
    await sleep(800);
    await locators[0].scrollIntoViewIfNeeded();
    await sleep(300);
    let bottom = 0;
    for (const locator of locators) {
      const box = await locator.boundingBox();
      if (box && box.height > 0) bottom = Math.max(bottom, box.y + box.height);
    }
    const side = await mesh.locator('#sidebar').boundingBox();
    console.log(`  zoom ${factor}: cards bottom ${Math.round(bottom)}, sidebar bottom ${Math.round(side.y + side.height)}`);
    if (bottom + 6 <= side.y + side.height) return factor < 1 ? factor : null;
  }
  throw new Error('the Problemtype stack does not fit the sidebar even at 80% zoom');
}

/** One case's setup: CAD geometry, exported MDPA, Problemtype values, Generate. */
async function setupCase(c, shots, log) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-tutorial-'));
  const dir = path.join(temp, c.id);
  const profile = path.join(temp, 'profile');
  fs.cpSync(path.join(root, 'doc/public/examples/tutorials', c.id), dir, { recursive: true });
  // The published case carries the solver inputs; the setup regenerates them.
  for (const name of fs.readdirSync(dir)) {
    if (name === 'vtk_output' || /^(mesh.*|ProjectParameters.*\.json|.*Materials\.json|MainKratos.*\.py|kkss-convergence.*\.jsonl|.*\.kratosrun\.json)$/.test(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', uiLanguage: 'en', 'kratos.pythonPath': python, 'kratos.extraEnv': { OMP_NUM_THREADS: '2' } }));
  const env = { OMP_NUM_THREADS: '2', KKSS_KRATOS_PYTHON: python };
  const { app, output } = await launchWindow(path.join(dir, c.geometry), { profile, renderer: '/renderer/cad/', width: 1440, height: 1100, env });
  try {
    const cad = await appWindow(app, '/renderer/cad/', Date.now() + 120_000);
    await until(() => output().includes('[cad] host → webview: geometry'), 'CAD geometry', 120_000);
    await cad.locator('#doc-chip-name').getByText(c.geometry, { exact: true }).waitFor();
    await sleep(1200);
    const geometry = shots.find((s) => s.producer === 'manual' && s.file.endsWith('-geometry.png'));
    if (geometry && (!onlyShot || geometry.file === onlyShot)) await cad.screenshot({ path: path.join(screenshots, geometry.file) });
    log(`${c.id}: geometry`);
    if (c.manual === 'geometry') return;

    await cad.locator('#meshing-toggle').click();
    await cad.selectOption('#meshing-export-format', 'mdpaElements');
    await cad.selectOption('#meshing-export-unit', 'm');
    await selectFile(app, path.join(dir, 'mesh.mdpa'), true);
    await cad.locator('#meshing-export').click();
    await until(() => fs.existsSync(path.join(dir, 'mesh.mdpa')), 'CAD MDPA export', 120_000);

    let mesh;
    await until(async () => {
      for (const page of app.windows().filter((p) => p.url().includes('/renderer/mesh/'))) {
        if (await page.locator('#doc-chip-name').textContent().catch(() => '') === 'mesh.mdpa' && await page.locator('#pt-select option').count() > 1) {
          mesh = page;
          return true;
        }
      }
      return false;
    }, 'exported mesh catalog', 60_000);
    // Tall enough for the whole setup to sit in one sidebar view, and a wider
    // sidebar so labels are not cut.
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1440, 1500));
    await mesh.evaluate(() => { const side = document.querySelector('#sidebar'); if (side) side.style.width = '380px'; });
    await sleep(800);
    await mesh.locator('#pt-select').selectOption(c.problemtype);
    await expandAll(mesh);

    // Coupled problemtypes carry one card per section; the sidebar form is flat.
    const formValues = c.values ? Object.assign({}, ...Object.values(c.values)) : c.problem;
    await values(mesh.locator('#pt-forms'), formValues);
    for (const a of c.assignments) {
      // A Parts-style pseudo-condition is filed in its own Domain card.
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
    await until(() => fs.existsSync(path.join(dir, c.primaryDocument ?? 'ProjectParameters.json')), 'Generate case files', 120_000);
    await sleep(800);

    for (const shot of shots) {
      if (onlyShot && shot.file !== onlyShot) continue;
      const file = path.join(screenshots, shot.file);
      if (shot.file.endsWith('-setup.png')) {
        const cards = [mesh.locator('#pt-parts'), mesh.locator('#pt-materials')];
        log(`${c.id}: ${shot.file} ${await sectionShot(mesh, cards, file)} bytes`);
      } else if (shot.file.endsWith('-setup-conditions.png')) {
        const cards = [mesh.locator('#pt-assignments')];
        log(`${c.id}: ${shot.file} ${await sectionShot(mesh, cards, file)} bytes`);
      } else if (shot.file.endsWith('-setup-solver.png')) {
        const cards = [mesh.locator('#pt-forms'), mesh.locator('#pt-preflight'), mesh.locator('#pt-generate')];
        // At 1500 px the stack is taller than the sidebar, so the Generate button sits below its edge: the viewer's
        // zoom is stepped down until the whole stack is inside, and restored after the capture.
        const zoom = await fitStackByZoom(app, mesh, cards);
        log(`${c.id}: ${shot.file} ${await sectionShot(mesh, cards, file, zoom ?? 1)} bytes${zoom ? ` (zoom ${zoom})` : ''}`);
        await setMeshZoom(app, 1);
        await sleep(800);
      } else if (shot.file.endsWith('-mesh.png')) {
        await resetView(mesh);
        await fit(mesh);
        // Fit leaves no margin on a wide model; the nav dock's zoom-out gives the ends room.
        for (let i = 0; i < (shot.zoomOut ?? 0); i++) await mesh.locator('#nav-zoom-out').click();
        if (shot.zoomOut) await sleep(600);
        log(`${c.id}: ${shot.file} ${await canvasShot(mesh, file, { minBytes: 30_000 })} bytes`);
      }
    }
    const errors = output().split('\n').filter((l) => /Uncaught|TypeError/.test(l));
    assert.equal(errors.length, 0, `${c.id}: errors in the app log`);
  } catch (error) {
    await diagnostics(app, output, `tutorial-${c.id}`).catch(() => {});
    throw error;
  } finally {
    await closeApp(app);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function manualTutorials(out = screenshots, selected = []) {
  const failures = [];
  const log = (line) => console.log(line);
  for (const c of cases.filter((c) => !selected.length || selected.includes(c.id))) {
    const shots = CATALOG.filter((s) => s.case === c.id && s.producer === 'manual');
    try {
      await setupCase(c, shots, log);
    } catch (error) {
      failures.push(`${c.id}: ${error.message.split('\n')[0]}`);
      log(`${c.id}: FAILED ${error.message.split('\n')[0]}`);
    }
  }
  if (failures.length) {
    console.log(`manual: ${failures.length} failed`);
    for (const line of failures) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

/**
 * The virtual wind tunnel wizard in the mesh viewer, with the settings of the published record
 * (wind-tunnel/tunnel.kratosvwt.json): one shot per step, step 5 twice (the plan under the form, then the
 * built result). The viewer opens a copy of tunnel.mdpa, the body is a copy of tunnel_body.stl and the
 * build goes to a scratch folder, so nothing under doc/public is written.
 */
async function windTunnelWizard(out, entries, log) {
  const published = path.join(root, 'doc/public/examples/tutorials/wind-tunnel');
  const base = path.join(os.tmpdir(), 'kkss-wind-tunnel-tutorial');
  fs.rmSync(base, { recursive: true, force: true });
  const dir = path.join(base, 'case');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(published, 'tunnel.mdpa'), path.join(dir, 'tunnel.mdpa'));
  const body = path.join(base, 'tunnel_body.stl');
  fs.copyFileSync(path.join(published, 'tunnel_body.stl'), body);
  const folder = path.join(base, 'tunnel');
  const profile = path.join(base, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', uiLanguage: 'en' }));
  const { app, page, output } = await launchWindow(path.join(dir, 'tunnel.mdpa'), { profile, renderer: '/renderer/mesh/', width: 1440, height: 1250 });
  const panel = page.locator('#wind-tunnel-panel');
  // A form row is a .series-toolbar whose own label has this exact text (rows are built by row() in windTunnelPanel.ts).
  const field = (label) => panel.locator(
    `xpath=.//div[contains(concat(" ", normalize-space(@class), " "), " series-toolbar ")][./label[normalize-space()=${JSON.stringify(label)}]]`,
  ).first();
  const text = (label, value) => field(label).locator('input[type="text"]').fill(value);
  const step = (index) => panel.locator('.meshsize-mode-btn').nth(index).click();
  // The scratch paths stay out of the figures: the inputs only display neutral names (the form keeps the real paths).
  const mask = () => panel.locator('input[type="text"]').evaluateAll((els) => els.forEach((e) => {
    if (e.value.includes('kkss-wind-tunnel-tutorial')) e.value = e.value.endsWith('.stl') ? 'tunnel_body.stl' : 'wind-tunnel';
  }));
  const shot = async (index, phase) => {
    await mask();
    const entry = entries.find((e) => e.step === index && e.phase === phase);
    const file = path.join(out, entry.file);
    await panel.screenshot({ path: file, timeout: 60_000 });
    log(`${entry.file}: ${fs.statSync(file).size} bytes`);
  };
  try {
    await waitForDocument(page, 'tunnel.mdpa');
    await sleep(1500);
    await command(page, 'windTunnel');
    await panel.waitFor({ state: 'visible', timeout: 30_000 });

    // 1 Body: the published body, placed and measured by the plan.
    await text('Body', body);
    await panel.getByText('Measured:', { exact: false }).waitFor({ timeout: 120_000 });
    await sleep(600);
    await shot(0);

    // 2 Tunnel: the record's extents in body lengths, free air.
    await step(1);
    await text('Upstream', '1.5');
    await text('Downstream', '2.5');
    await text('Sides', '1.5');
    await text('Top', '2.5');
    await text('Below', '2.5');
    await panel.getByText('Blockage', { exact: false }).waitFor({ timeout: 120_000 });
    await sleep(600);
    await shot(1);

    // 3 Flow: 10 m/s air with the k-omega SST model.
    await step(2);
    await text('Speed', '10');
    await field('Turbulence model').locator('select').selectOption('k_omega_sst');
    await panel.getByText('Re = ', { exact: false }).waitFor({ timeout: 120_000 });
    await sleep(600);
    await shot(2);

    // 4 Mesh: the record's surface, far-field, y+ and wake settings.
    await step(3);
    await text('Surface', '0.35');
    await text('Far field', '3');
    await text('Target y+', '150');
    await text('Wake', '0.5');
    await panel.getByText('tetrahedra', { exact: false }).waitFor({ timeout: 120_000 });
    await sleep(600);
    await shot(3);

    // 5 Generate: the plan under the form, before anything is built.
    await step(4);
    await text('Folder', folder);
    await text('Name', 'tunnel');
    await field('Solver files').locator('input[type="checkbox"]').setChecked(true);
    const generate = panel.locator('button.panel-btn', { hasText: 'Generate' });
    await until(() => generate.isEnabled(), 'Generate enabled', 120_000);
    await sleep(600);
    await shot(4, 'plan');

    // 6 Built: the build's own result lines.
    await generate.click();
    await panel.locator('.meshsize-section', { hasText: 'Built' }).waitFor({ timeout: 2_400_000 });
    await sleep(800);
    await shot(4, 'result');
    log(`wizard build kept in ${folder}`);
    const errors = output().split('\n').filter((l) => /Uncaught|TypeError/.test(l));
    assert.equal(errors.length, 0, 'wind-tunnel wizard: errors in the app log');
  } catch (error) {
    await diagnostics(app, output, 'tutorial-wind-tunnel-wizard').catch(() => {});
    throw error;
  } finally {
    await closeApp(app);
  }
}

/**
 * The CAD-side shots (tutorial-<id>-fe-mesh.png, tutorial-<id>-parts.png): each case's geometry opens in CAD from a
 * scratch copy with a seeded <geometry>.view.json (fixed camera, collapsed panels) and its published Parts sidecar.
 */
export async function cadTutorials(kind, out = screenshots, selected = []) {
  const failures = [];
  for (const c of cases.filter((c) => !selected.length || selected.includes(c.id))) {
    const entry = CATALOG.find((s) => s.case === c.id && s.producer === kind);
    if (!entry) continue;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-cad-'));
    const dir = path.join(temp, c.id);
    fs.cpSync(path.join(root, 'doc/public/examples/tutorials', c.id), dir, { recursive: true });
    seedView(path.join(dir, c.geometry), c.id, kind === 'fe-mesh' ? ['parts-panel', 'meshing-panel'] : ['parts-panel']);
    const profile = path.join(temp, 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', uiLanguage: 'en' }));
    let app;
    try {
      const launched = await launchWindow(path.join(dir, c.geometry), { profile, renderer: '/renderer/cad/', width: 1440, height: 1100 });
      app = launched.app;
      const cad = await appWindow(app, '/renderer/cad/', Date.now() + 120_000);
      await until(() => launched.output().includes('[cad] host → webview: geometry'), 'CAD geometry', 120_000);
      await cad.locator('#doc-chip-name').getByText(c.geometry, { exact: true }).waitFor();
      await sleep(1200);
      const file = path.join(out, entry.file);
      const text = kind === 'fe-mesh' ? await feMeshShot(cad, file) : await partsShot(cad, file);
      console.log(`${entry.file}: ${fs.statSync(file).size} bytes; ${text}`);
    } catch (error) {
      failures.push(`${c.id}: ${error.message.split('\n')[0]}`);
      console.log(`${c.id}: FAILED ${error.message.split('\n')[0]}`);
    } finally {
      if (app) await closeApp(app);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  if (failures.length) process.exitCode = 1;
}

/**
 * The mesh → CAD example's shots (fit-cad-source.png, fit-cad-fitted.png): the
 * committed fit-cad files open in CAD from a scratch copy with a seeded view —
 * the 100,000-triangle STL skin first, then the fitted STEP solid. The files
 * already exist, so no fit runs at capture time; the names carry no
 * `tutorial-` prefix, so they need no catalog entry (see shots.mjs).
 */
export async function fitCadTutorials(out = screenshots) {
  const published = path.join(root, 'doc/public/examples/fit-cad');
  for (const [file, shot] of [['large-sphere.stl', 'fit-cad-source.png'], ['large-sphere.step', 'fit-cad-fitted.png']]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-fit-cad-'));
    const copy = path.join(temp, file);
    fs.copyFileSync(path.join(published, file), copy);
    seedView(copy, 'fit-cad', ['parts-panel']);
    const profile = path.join(temp, 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', uiLanguage: 'en' }));
    let app;
    try {
      const launched = await launchWindow(copy, { profile, renderer: '/renderer/cad/', width: 1440, height: 1100 });
      app = launched.app;
      const cad = await appWindow(app, '/renderer/cad/', Date.now() + 120_000);
      await cad.locator('#doc-chip-name').getByText(file, { exact: true }).waitFor();
      if (file.endsWith('.step')) {
        await until(() => launched.output().includes('[cad] host → webview: geometry'), `fit-cad ${file}`, 120_000);
      } else {
        // A three.js-native mesh (STL) loads entirely in the viewer (fetch +
        // parse + render) — the host never posts `geometry`, so the load is
        // read from the status line instead: it must start, then stop saying
        // so. Anything else is either too early or a load failure, surfaced.
        const statusText = async () => (await cad.locator('#status').textContent().catch(() => '')) ?? '';
        await until(async () => (await statusText()).includes('Loading model'), `fit-cad ${file} starts loading`, 120_000);
        await until(async () => {
          const text = await statusText();
          if (text.startsWith('Failed to load model')) throw new Error(`fit-cad ${file}: ${text}`);
          return !text.includes('Loading model');
        }, `fit-cad ${file} finishes loading`, 300_000);
      }
      await sleep(1200);
      const text = await partsShot(cad, path.join(out, shot));
      console.log(`${shot}: ${fs.statSync(path.join(out, shot)).size} bytes; ${text}`);
    } catch (error) {
      console.log(`fit-cad ${file}: FAILED ${error.message.split('\n')[0]}`);
      process.exitCode = 1;
    } finally {
      if (app) await closeApp(app);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

/**
 * The OpenSCAD example's shots (openscad-source.png, openscad-customizer.png):
 * the committed `bracket.scad` opens in CAD from a scratch copy with a seeded
 * view — first at its defaults with the Parts panel open, then with a seeded
 * `<model>.scad-params.json` (`hole_d = 12`) and the Customizer panel open.
 * The bundled WASM build evaluates the source, so no `openscad` install is
 * needed at capture time. The names carry no `tutorial-` prefix, so like the
 * fit-cad shots they need no catalog entry (see shots.mjs).
 */
export async function openscadTutorials(out = screenshots) {
  const published = path.join(root, 'doc/public/examples/openscad');
  const variants = [
    { file: 'bracket.scad', shot: 'openscad-source.png', expanded: ['parts-panel'], overrides: null },
    { file: 'bracket.scad', shot: 'openscad-customizer.png', expanded: ['scad-panel'], overrides: { hole_d: 12 } },
  ];
  for (const { file, shot, expanded, overrides } of variants) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-openscad-'));
    const copy = path.join(temp, file);
    fs.copyFileSync(path.join(published, file), copy);
    if (overrides) {
      fs.writeFileSync(
        `${copy}.scad-params.json`,
        JSON.stringify({ version: 1, source: file, overrides }, null, 2) + '\n'
      );
    }
    seedView(copy, 'openscad', expanded);
    const profile = path.join(temp, 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', uiLanguage: 'en' }));
    let app;
    try {
      const launched = await launchWindow(copy, { profile, renderer: '/renderer/cad/', width: 1440, height: 1100 });
      app = launched.app;
      const cad = await appWindow(app, '/renderer/cad/', Date.now() + 120_000);
      await cad.locator('#doc-chip-name').getByText(file, { exact: true }).waitFor();
      // A B-rep-route source (via the WASM .scad conversion) posts `geometry`
      // like any STEP open; a conversion failure surfaces on the status line.
      await until(() => launched.output().includes('[cad] host → webview: geometry'), `openscad ${shot}`, 120_000);
      const statusText = async () => (await cad.locator('#status').textContent().catch(() => '')) ?? '';
      await until(async () => {
        const text = await statusText();
        if (text.startsWith('Failed to load model')) throw new Error(`openscad ${shot}: ${text}`);
        return !text.includes('Loading model');
      }, `openscad ${shot} finishes loading`, 300_000);
      await sleep(1200);
      const text = await partsShot(cad, path.join(out, shot));
      console.log(`${shot}: ${fs.statSync(path.join(out, shot)).size} bytes; ${text}`);
    } catch (error) {
      console.log(`openscad ${shot}: FAILED ${error.message.split('\n')[0]}`);
      process.exitCode = 1;
    } finally {
      if (app) await closeApp(app);
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
}

/** The wizard shots (tutorial-*-wizard-*.png) for each case that declares them. */
export async function wizardTutorials(out = screenshots, selected = []) {
  const failures = [];
  const log = (line) => console.log(line);
  for (const c of cases.filter((c) => !selected.length || selected.includes(c.id))) {
    const entries = CATALOG.filter((s) => s.case === c.id && s.producer === 'wizard');
    if (!entries.length) continue;
    try {
      await windTunnelWizard(out, entries, log);
    } catch (error) {
      failures.push(`${c.id}: ${error.message.split('\n')[0]}`);
      log(`${c.id}: FAILED ${error.message.split('\n')[0]}`);
    }
  }
  if (failures.length) {
    console.log(`wizard: ${failures.length} failed`);
    for (const line of failures) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith('--shot='));
  if (only) onlyShot = only.slice('--shot='.length);
  const names = args.filter((a) => !a.startsWith('--'));
  if (args.includes('--fe-mesh')) await cadTutorials('fe-mesh', screenshots, names);
  else if (args.includes('--parts')) await cadTutorials('parts', screenshots, names);
  else if (args.includes('--wizard')) await wizardTutorials(screenshots, names);
  else if (args.includes('--fit-cad')) await fitCadTutorials(screenshots);
  else if (args.includes('--openscad')) await openscadTutorials(screenshots);
  else await manualTutorials(screenshots, names);
}
