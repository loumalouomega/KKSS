#!/usr/bin/env node
// Captures the field and plot shots of the tutorial catalog (shots.mjs) from
// the recovered solver output (results.mjs). Field shots are canvas-only crops
// of the real viewer; plot shots load the case's own recipe into the embedded
// Plots pane and must reproduce the CSV it was published with.
//
//   node tools/tutorials/gallery.mjs [case ...] [--only=fields,plots]
//
// Set KKSS_TUTORIAL_WAYLAND=<socket> to draw on a private Wayland compositor
// (see doc/guide/development.md); without it the windows open on the desktop.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { closeApp, sleep } from '../e2eShared.mjs';
import { LAST_SHIPPED, eigenResultsDir, resultsDir, root } from './results.mjs';
import { CATALOG } from './shots.mjs';
import {
  canvasShot, command, fieldNames, fit, gotoFrame, launchWindow, loadPlotRecipe, openFieldPanel, plotShot, plotTraces,
  pngSize, resetRange, resetView, setField, setModes, setRange, setScalarBar, waitForDocument,
} from './capture.mjs';

export const screenshots = path.join(root, 'doc/public/screenshots');
const only = new Set((process.argv.slice(2).find((a) => a.startsWith('--only=')) ?? '--only=fields,plots,gifs')
  .slice('--only='.length).split(','));
const requested = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const git = (args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024 });
const shippedPath = (caseId, file) => `doc/public/examples/tutorials/${caseId}/${file}`;

/** Writes staged bytes over `dest` only when they differ, so a re-run leaves git alone. */
export function publishIfChanged(staged, dest) {
  const previous = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (previous && previous.equals(fs.readFileSync(staged))) return false;
  fs.copyFileSync(staged, dest);
  return true;
}

/** Rows of a restored plot CSV: `derived` stage only (the values the recipe draws). */
export function publishedSeries(csvText) {
  const [header, ...rows] = csvText.trim().split('\n');
  const cols = header.split(',');
  const series = new Map();
  for (const line of rows) {
    const cells = line.split(',');
    const row = Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
    if (row.stage !== 'derived') continue;
    if (!series.has(row.series)) series.set(row.series, []);
    series.get(row.series).push({ x: Number(row.x), y: Number(row.y) });
  }
  return series;
}

/** Compares a drawn trace's endpoints with the published values, to 1e-6 relative. */
export function assertTraceMatches(trace, published, label) {
  const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  assert.ok(published, `${label}: no published series named "${trace.name}"`);
  const first = published[0];
  const last = published.at(-1);
  assert.equal(trace.n, published.length, `${label} ${trace.name}: point count`);
  assert.ok(close(trace.x0, first.x) && close(trace.y0, first.y), `${label} ${trace.name}: first point ${trace.x0},${trace.y0} vs ${first.x},${first.y}`);
  assert.ok(close(trace.xn, last.x) && close(trace.yn, last.y), `${label} ${trace.name}: last point ${trace.xn},${trace.yn} vs ${last.x},${last.y}`);
}

/**
 * Removes the view-state sidecars a previous session left beside the frames.
 * The viewer restores a saved camera, field and range on open, so a shot must
 * never depend on what an earlier session of the same case did.
 */
export function clearViewState(caseDir) {
  for (const dir of [caseDir, path.join(caseDir, 'vtk_output')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (name.endsWith('.kratosview.json')) fs.rmSync(path.join(dir, name));
  }
}

/** The step count of the open series, from the timeline's own range input. */
// A single-frame result has no timeline at all (thermal, potential flow): one step.
const stepCount = async (page) => ((await page.locator('#tl-scrub').count()) ? page.locator('#tl-scrub').evaluate((el) => Number(el.max) + 1) : 1);

function firstFile(caseDir, results, family) {
  const families = [...results.families.entries()];
  const [, frames] = family ? families.find(([name]) => name.startsWith(family)) : families[0];
  return path.join(caseDir, 'vtk_output', frames[0].name);
}

/** Runs the field entries of one case in one viewer session per document. */
async function fieldShots(caseId, entries, caseDir, results, stage, log) {
  const byDocument = new Map();
  for (const shot of entries) {
    const key = shot.participant ?? '';
    if (!byDocument.has(key)) byDocument.set(key, []);
    byDocument.get(key).push(shot);
  }
  for (const [participant, shots] of byDocument) {
    const file = firstFile(caseDir, results, participant || undefined);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-gallery-profile-'));
    clearViewState(caseDir);
    // Wide enough that the Field panel sits beside the model rather than over it.
    const { app, page, output } = await launchWindow(file, { profile, width: 1600, height: 960 });
    let clipOn = false;
    try {
      await waitForDocument(page, path.basename(file));
      // The first scene is still settling after the chip shows the name.
      await sleep(2000);
      const total = await stepCount(page);
      for (const shot of shots) {
        const frame = shot.frame === 'last' ? total : shot.frame === 'middle' ? Math.ceil(total / 2) : (shot.frame ?? total);
        if (total > 1) await gotoFrame(page, frame);
        // The label moves before the new frame's scene is built; let it land first.
        await sleep(1200);
        await setField(page, shot.field);
        await setModes(page, shot.modes ?? ['Contour']);
        if (shot.range) await setRange(page, shot.range[0], shot.range[1]);
        else await resetRange(page);
        await setScalarBar(page, shot.bar !== false);
        if (shot.clip) {
          await command(page, `clip on axis=${shot.clip.axis} pos=${shot.clip.pos}`);
          clipOn = true;
        } else if (clipOn) {
          await command(page, 'clip off');
          clipOn = false;
        }
        await resetView(page);
        if (shot.view) await command(page, `view ${shot.view}`);
        await fit(page);
        // Pull the camera back so a wide model clears the Field panel (it is cropped out of the shot, not hidden).
        for (let i = 0; i < (shot.zoomOut ?? 0); i++) await page.locator('#nav-zoom-out').click();
        await sleep(1500);
        const pinned = shot.range ? await page.locator('#field-panel .field-range-input').evaluateAll((els) => els.map((e) => Number(e.value))) : null;
        if (pinned) assert.ok(Math.abs(pinned[0] - shot.range[0]) < 1e-9 && Math.abs(pinned[1] - shot.range[1]) < 1e-9, `${shot.file}: range inputs read ${pinned}`);
        const staged = path.join(stage, shot.file);
        // canvasShot writes before it checks (so a bad frame can be looked at); a failed shot must not be published.
        let bytes;
        try {
          bytes = await canvasShot(page, staged, { app, maxBytes: 1_500_000 });
        } catch (error) {
          fs.rmSync(staged, { force: true });
          throw error;
        }
        const size = pngSize(staged);
        assert.equal(size.width % 2, 0, `${shot.file}: width ${size.width} is not a 2x canvas`);
        log(`${shot.file}: ${size.width}x${size.height}, ${bytes} bytes, step ${frame}/${total}`);
      }
      const errors = output().split('\n').filter((l) => /ERROR|Uncaught|TypeError/.test(l) && !/GPU stall|ANGLE|EGL|gl_utils|Display\.cpp|angle_platform/.test(l));
      assert.equal(errors.length, 0, `${caseId}: errors in the viewer log:\n${errors.slice(0, 5).join('\n')}`);
    } finally {
      await closeApp(app);
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
}

/** Loads one restored recipe, checks it against its CSV and captures the pane. */
async function plotShots(caseId, entries, caseDir, results, stage, log) {
  for (const shot of entries) {
    const recipe = path.join(caseDir, shot.recipe);
    fs.mkdirSync(path.dirname(recipe), { recursive: true });
    fs.writeFileSync(recipe, git(['cat-file', 'blob', `${LAST_SHIPPED}:${shippedPath(caseId, shot.recipe)}`]));
    const csvPath = shippedPath(caseId, shot.recipe.replace(/\.json$/, '.csv'));
    const published = publishedSeries(git(['cat-file', 'blob', `${LAST_SHIPPED}:${csvPath}`]).toString('utf8'));
    const file = firstFile(caseDir, results, undefined);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-gallery-profile-'));
    clearViewState(caseDir);
    const { app, page, output } = await launchWindow(file, { profile, width: 1280, height: 820 });
    try {
      await waitForDocument(page, path.basename(file));
      const status = await loadPlotRecipe(app, page, recipe);
      const traces = await plotTraces(page);
      for (const trace of traces) assertTraceMatches(trace, published.get(trace.name), `${shot.file}`);
      const staged = path.join(stage, shot.file);
      const bytes = await plotShot(page, staged);
      log(`${shot.file}: ${status}; ${traces.length} traces match ${csvPath}; ${bytes} bytes`);
      const errors = output().split('\n').filter((l) => /Uncaught|TypeError/.test(l));
      assert.equal(errors.length, 0, `${shot.file}: errors in the viewer log`);
    } finally {
      await closeApp(app);
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }
}

/** The VTK copy of the eigen result, which the viewer opens (eigenShots). */
const EIGEN_VTK = path.join(root, 'node_modules/.cache/tutorial-eigen-modes/eigen-modes.vtu');
/** The eigen generation folder; its EigenResults/*.post.bin holds the raw records the copy is written from. */
const EIGEN_GENERATION = path.join(root, 'node_modules/.cache/tutorials-CYub9c/eigen');

/** Returns the VTK copy, writing it with tools/tutorials/eigenModes.py when it is missing. */
function ensureEigenVtk() {
  if (fs.existsSync(EIGEN_VTK)) return EIGEN_VTK;
  assert.ok(fs.existsSync(path.join(EIGEN_GENERATION, 'EigenResults')), `eigen: no EigenResults under ${EIGEN_GENERATION}; generate the eigen case first`);
  fs.mkdirSync(path.dirname(EIGEN_VTK), { recursive: true });
  execFileSync('python3', [path.join(root, 'tools/tutorials/eigenModes.py'), EIGEN_GENERATION, EIGEN_VTK], { stdio: 'inherit' });
  assert.ok(fs.existsSync(EIGEN_VTK), 'eigen: eigenModes.py did not write the VTK copy');
  return EIGEN_VTK;
}

/**
 * Mode-shape shots (tutorial-eigen-mode-N.png). The viewer opens a copy of the VTK file that eigenModes.py writes
 * from the raw GiD records (its own GiD reader misreads them). Each field is shown Deformed by its own
 * displacement, with the tip moved by shot.tipMm, coloured by the displacement magnitude. The scalar bar is off:
 * the mode normalisation is arbitrary, so its numbers would read as amplitudes.
 */
async function eigenShots(entries, stage, log) {
  const vtk = ensureEigenVtk();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-eigen-'));
  try {
    // A copy: the viewer writes view-state sidecars beside the file it opens.
    const file = path.join(tmp, path.basename(vtk));
    fs.copyFileSync(vtk, file);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-gallery-profile-'));
    const { app, page, output } = await launchWindow(file, { profile, width: 1600, height: 960 });
    try {
      await waitForDocument(page, path.basename(file));
      await sleep(2000);
      log(`eigen: ${path.basename(vtk)} offers ${(await fieldNames(page)).join(' | ')}`);
      for (const shot of entries) {
        await setField(page, shot.field);
        await setModes(page, ['Deformed', 'Contour']);
        const deform = page.locator('#field-panel').getByText('Deform by', { exact: true }).locator('xpath=..').locator('select');
        assert.equal(await deform.count(), 1, 'eigen: the Deform by selector is not on the Field panel');
        const deformValue = await deform.locator('option').evaluateAll(
          (els, n) => els.find((e) => e.textContent.trim().startsWith(`${n} (`))?.value ?? null,
          shot.field,
        );
        assert.ok(deformValue !== null, `eigen: ${shot.field} is not offered by Deform by`);
        await deform.selectOption(deformValue);
        await resetRange(page);
        // The warp is display-only and the tip moves shot.tipMm. The slider steps by 0.1, too coarse for a 4-5 mm
        // tip on this normalisation, so the value is set exactly (its step is widened for that set only).
        const peak = (await page.locator('#field-panel .field-range-input').evaluateAll((els) => els.map((e) => Number(e.value))))[1];
        const scale = (shot.tipMm / 1000) / peak;
        await page.locator('#field-panel .field-row').filter({ has: page.locator('label', { hasText: 'Warp scale' }) })
          .locator('input.field-slider').evaluate((el, v) => {
            el.step = 'any';
            el.value = String(v);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }, scale);
        log(`${shot.file}: ${shot.field}, peak |u| ${peak.toPrecision(4)}, warp ${scale.toFixed(4)}x, tip ${(scale * peak * 1000).toFixed(2)} mm`);
        await setScalarBar(page, false);
        await resetView(page);
        if (shot.view) await command(page, `view ${shot.view}`);
        await fit(page);
        for (let i = 0; i < (shot.zoomOut ?? 0); i++) await page.locator('#nav-zoom-out').click();
        await sleep(1500);
        const staged = path.join(stage, shot.file);
        let bytes;
        try {
          bytes = await canvasShot(page, staged, { app, maxBytes: 1_500_000 });
        } catch (error) {
          fs.rmSync(staged, { force: true });
          throw error;
        }
        log(`${shot.file}: view ${shot.view ?? 'as opened'}, ${bytes} bytes`);
      }
      const errors = output().split('\n').filter((l) => /Uncaught|TypeError/.test(l));
      assert.equal(errors.length, 0, 'eigen: errors in the viewer log');
    } finally {
      await closeApp(app);
      fs.rmSync(profile, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const cases = [...new Set(CATALOG.map((s) => s.case))].filter((id) => !requested.length || requested.includes(id));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-gallery-stage-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-gallery-case-'));
  const report = { written: [], unchanged: [], failed: [] };
  const log = (line) => console.log(line);
  try {
    const eigen = CATALOG.filter((s) => s.producer === 'eigen' && only.has('fields') && (!requested.length || requested.includes(s.case)));
    if (eigen.length) {
      const outDir = fs.mkdtempSync(path.join(stage, 'eigen-'));
      try {
        await eigenShots(eigen, outDir, log);
      } catch (error) {
        report.failed.push(`eigen: ${error.message.split('\n')[0]}`);
        log(`eigen: FAILED ${error.message.split('\n')[0]}`);
      }
      for (const name of fs.readdirSync(outDir)) {
        const dest = path.join(screenshots, name);
        (publishIfChanged(path.join(outDir, name), dest) ? report.written : report.unchanged).push(name);
      }
    }
    for (const caseId of cases) {
      const entries = CATALOG.filter((s) => s.case === caseId && s.producer === 'gallery' && only.has('fields')
        || s.case === caseId && s.producer === 'plot' && only.has('plots'));
      if (!entries.length) continue;
      const fields = entries.filter((s) => s.producer === 'gallery');
      const plots = entries.filter((s) => s.producer === 'plot');
      const caseDir = path.join(tmp, caseId);
      let results;
      try {
        results = resultsDir(caseId);
      } catch (error) {
        log(`${caseId}: skipped, ${error.message}`);
        report.failed.push(`${caseId}: ${error.message}`);
        continue;
      }
      fs.mkdirSync(caseDir, { recursive: true });
      // A copy, not a link: the viewer writes view-state sidecars beside the
      // frames, and those must never land in the result cache.
      fs.cpSync(results.vtkDir, path.join(caseDir, 'vtk_output'), { recursive: true });
      for (const monitor of results.monitors) fs.copyFileSync(monitor.path, path.join(caseDir, monitor.name));
      const outDir = fs.mkdtempSync(path.join(stage, `${caseId}-`));
      for (const runner of [[fields, fieldShots], [plots, plotShots]]) {
        const [list, run] = runner;
        if (!list.length) continue;
        try {
          await run(caseId, list, caseDir, results, outDir, log);
        } catch (error) {
          report.failed.push(`${caseId}: ${error.message.split('\n')[0]}`);
          log(`${caseId}: FAILED ${error.message.split('\n')[0]}`);
        }
      }
      for (const name of fs.readdirSync(outDir)) {
        const dest = path.join(screenshots, name);
        (publishIfChanged(path.join(outDir, name), dest) ? report.written : report.unchanged).push(name);
      }
    }
  } finally {
    if (!process.env.KKSS_GALLERY_KEEP) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(stage, { recursive: true, force: true });
    } else console.log(`kept ${stage}`);
  }
  console.log(`gallery: ${report.written.length} written, ${report.unchanged.length} unchanged, ${report.failed.length} failed`);
  for (const line of report.failed) console.log(`  failed: ${line}`);
  if (report.failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
