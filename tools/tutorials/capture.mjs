// Viewer capture helpers shared by manual.mjs, gallery.mjs and animations.mjs:
// one way to launch a window at a pinned size and 2x scale, one way to set a
// field, a colour range, a clip plane or a time step, and one canvas-only
// screenshot that waits for the frame to stop changing.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchApp, appWindow, closeApp, selectFile, softwareGL, sleep, until } from '../e2eShared.mjs';

export const SCALE_FLAG = '--force-device-scale-factor=2';
/** Chrome that would otherwise sit over the model in a canvas crop. */
const CHROME = ['#toolbar', '#nav-controls', '#field-panel', '#cut-panel', '#find-bar', '#timeline-bar', '#cmd-prompt', '#statusbar', '#menubar'];

let warnedDesktop = false;
/**
 * Where windows open. With KKSS_TUTORIAL_WAYLAND=<socket> they go to a private
 * Wayland compositor (see doc/guide/development.md) and never reach the
 * desktop; otherwise they open on the current desktop, and we say so once.
 */
export function displayOptions() {
  const socket = process.env.KKSS_TUTORIAL_WAYLAND;
  if (socket) return { extraArgs: ['--ozone-platform=wayland'], env: { DISPLAY: undefined, WAYLAND_DISPLAY: socket } };
  if (!warnedDesktop) {
    warnedDesktop = true;
    console.warn('capture: KKSS_TUTORIAL_WAYLAND is not set, so capture windows open on the current desktop');
  }
  return { extraArgs: [], env: {} };
}

/**
 * Launches the app on `file` with a pinned window and 2x device scale, and
 * returns the renderer page. `renderer` is the page URL fragment ('/renderer/mesh/', '/renderer/cad/').
 */
export async function launchWindow(file, { profile, renderer = '/renderer/mesh/', width = 1100, height = 760, extraArgs = [], env = {} } = {}) {
  const display = displayOptions();
  // English number formats, whatever the machine's locale: the docs show 1.204, not 1,204.
  const { app, output } = await launchApp(file, {
    userDataDir: profile,
    extraArgs: [...softwareGL, SCALE_FLAG, ...display.extraArgs, ...extraArgs],
    env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...display.env, ...env },
  });
  try {
    const page = await appWindow(app, renderer, Date.now() + 120_000);
    await app.evaluate(({ BaseWindow }, [w, h]) => BaseWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
    await until(async () => (await page.evaluate(() => window.devicePixelRatio)) === 2, 'device pixel ratio 2', 30_000);
    return { app, page, output };
  } catch (error) {
    await closeApp(app);
    throw error;
  }
}

/** Waits until the viewer's document chip shows `name` and the canvas has a size. */
export async function waitForDocument(page, name, timeout = 180_000) {
  await until(async () => (await page.locator('#doc-chip-name').textContent().catch(() => '')) === name, `${name} opens`, timeout);
  await until(async () => (await page.locator('#render-root canvas').boundingBox().catch(() => null))?.width > 0, 'canvas size', 60_000);
}

/** Field panel: open it if it is not already on screen (never toggle it closed). */
export async function openFieldPanel(page) {
  const panel = page.locator('#field-panel');
  if (!(await panel.isVisible().catch(() => false))) await page.locator('#toolbar button[data-action="field"]').click();
  await panel.locator('select.field-select').first().waitFor({ timeout: 15_000 });
  return panel;
}

/** Selects a result field by name ("PRESSURE" matches the option "PRESSURE (Nodal, scalar)"). */
export async function setField(page, name) {
  const panel = await openFieldPanel(page);
  const select = panel.locator('select.field-select').first();
  const value = await select.locator('option').evaluateAll((els, n) => els.find((e) => e.textContent.trim().startsWith(`${n} (`))?.value ?? null, name);
  assert.ok(value !== null, `field ${name} is not offered by this result`);
  await select.selectOption(value);
  await sleep(250);
}

/** Lists the field names the result offers, in the panel's own order. */
export async function fieldNames(page) {
  const panel = await openFieldPanel(page);
  return panel.locator('select.field-select').first().locator('option').evaluateAll((els) => els.map((e) => e.textContent.trim().split(' (')[0]));
}

/** Sets the colour range by its two number inputs and commits it (the panel commits on `change`). */
export async function setRange(page, min, max) {
  const panel = await openFieldPanel(page);
  const [lo, hi] = [panel.locator('.field-range-input').nth(0), panel.locator('.field-range-input').nth(1)];
  for (const [input, value] of [[lo, min], [hi, max]]) {
    await input.evaluate((el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  await sleep(250);
}

/** Drops a pinned colour range back to the field's own data range (the panel's ⟲ button). */
export async function resetRange(page) {
  const panel = await openFieldPanel(page);
  const reset = panel.locator('button.field-range-reset').filter({ hasNotText: 'Plot distribution' });
  // Disabled when nothing is overridden: a click there would wait for the button to enable.
  if ((await reset.count()) && (await reset.first().isEnabled())) await reset.first().click();
  await sleep(200);
}

/**
 * Switches display modes so exactly `modes` are active. Modes combine
 * independently (Contour + Quiver is one picture), so each button is clicked
 * only when its current state differs from the wanted one.
 */
export async function setModes(page, modes) {
  const panel = await openFieldPanel(page);
  for (const label of ['Contour', 'Quiver', 'Isosurface', 'Deformed', 'Threshold']) {
    const button = panel.locator('.field-mode-btn').filter({ hasText: label });
    const active = /\bactive\b/.test(await button.getAttribute('class') ?? '');
    if (active !== modes.includes(label)) await button.click();
  }
  await sleep(250);
}

/** Turns the in-scene scalar bar on or off (the "Show scalar bar in scene" checkbox). */
export async function setScalarBar(page, on) {
  const panel = await openFieldPanel(page);
  // Set and announce the state from script rather than clicking: a pointer
  // click that misses the panel lands on the orientation cube and snaps the
  // camera to a face.
  const box = panel.locator('label.edit-check', { hasText: 'Show scalar bar in scene' }).locator('input[type="checkbox"]');
  await box.evaluate((el, value) => {
    if (el.checked === value) return;
    el.checked = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, on);
  await sleep(300);
}

/**
 * Opens the embedded Plots pane and loads a recipe file through the mocked
 * open dialog. Resolves when the plot has drawn; `status` is the pane's own
 * "N full-resolution points" line.
 */
export async function loadPlotRecipe(app, page, recipe) {
  await page.locator('#toolbar [data-action="plots"]').click();
  await page.locator('#plot-app[data-plot-ready="true"]').waitFor({ timeout: 60_000 });
  await selectFile(app, recipe);
  await page.getByRole('button', { name: 'Load recipe', exact: true }).click();
  await until(async () => (await page.locator('#plot-status').textContent()).includes('full-resolution points'), `plot ${recipe}`, 120_000);
  await page.locator('#plot-chart .main-svg').first().waitFor({ timeout: 30_000 });
  await sleep(800);
  return (await page.locator('#plot-status').textContent()).trim();
}

/** Each trace of the drawn plot: name, point count and first/last (x, y). */
export async function plotTraces(page) {
  return page.locator('#plot-chart').evaluate((el) => el.data.map((t) => ({
    name: t.name, n: t.y.length, x0: t.x[0], y0: t.y[0], xn: t.x.at(-1), yn: t.y.at(-1),
  })));
}

/** Element screenshot of the plot pane, held until two captures match. */
export async function plotShot(page, file) {
  const pane = page.locator('#plot-app');
  let previous = null;
  for (let i = 0; i < 10; i++) {
    const png = await pane.screenshot({ timeout: 30_000 });
    if (previous && png.equals(previous)) { fs.writeFileSync(file, png); return png.length; }
    previous = png;
    await sleep(300);
  }
  fs.writeFileSync(file, previous);
  return previous.length;
}

/** Types one line into the command bar (the mesh viewer's `/` line): `view top`, `clip on axis=y pos=0.5`. */
export async function command(page, line) {
  const input = page.locator('#cmd-input');
  await input.fill(line);
  await input.press('Enter');
  await sleep(400);
}

/** Moves the timeline to a 1-based step and waits for the label to confirm it. */
export async function gotoFrame(page, step) {
  await page.locator('#tl-scrub').evaluate((el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, step - 1);
  await until(async () => (await page.locator('#tl-label').textContent()).includes(`(${step}/`), `step ${step} shown`, 120_000);
  await sleep(300);
}

/**
 * The toolbar Reset: puts the camera back to the viewer's default. A scene
 * rebuilt from a new step is not framed by Fit alone, so every shot resets first.
 */
export async function resetView(page) {
  await page.locator('#toolbar button[data-action="reset"]').click();
  await sleep(800);
}

/** Frames the model in view (the viewer's Fit button). */
export async function fit(page) {
  await page.locator('#nav-fit').click();
  await sleep(400);
}

/**
 * The canvas rectangle with every floating panel cut away. Hiding the panels
 * (visibility, display or transform) makes Chromium drop the WebGL canvas
 * from the captured frame, so the capture crops instead: each overlay that
 * overlaps the canvas removes the strip it sits on, from the nearest edge.
 */
export async function canvasCropRect(page) {
  return page.evaluate((sels) => {
    const canvas = document.querySelector('#render-root canvas');
    if (!canvas) return null;
    const c = canvas.getBoundingClientRect();
    const box = { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
      // The overlay sits against the edge it penetrates least.
      const depth = { top: r.bottom - box.top, bottom: box.bottom - r.top, left: r.right - box.left, right: box.right - r.left };
      const edge = Object.keys(depth).reduce((a, b) => (depth[b] < depth[a] ? b : a));
      if (edge === 'top') box.top = Math.max(box.top, r.bottom);
      else if (edge === 'bottom') box.bottom = Math.min(box.bottom, r.top);
      else if (edge === 'left') box.left = Math.max(box.left, r.right);
      else box.right = Math.min(box.right, r.left);
    }
    return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
  }, CHROME);
}

/**
 * The share of pixels that differ from the background (the top-left pixel).
 * A smooth colour field compresses to a few kilobytes, so the byte size of a
 * PNG says nothing about whether it drew; the pixels do.
 */
export async function drawnFraction(app, png) {
  return app.evaluate(({ nativeImage }, b64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const at = (x, y) => (y * width + x) * 4;
    const bg = at(0, 0);
    const near = (i) => Math.abs(bitmap[i] - bitmap[bg]) + Math.abs(bitmap[i + 1] - bitmap[bg + 1]) + Math.abs(bitmap[i + 2] - bitmap[bg + 2]) > 24;
    let differing = 0;
    const step = 2;
    let sampled = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        sampled++;
        if (near(at(x, y))) differing++;
      }
    }
    return differing / sampled;
  }, png.toString('base64'));
}

/**
 * How many distinct colours the frame holds, quantised to 16 levels per
 * channel over a sample grid. A blank frame holds a handful; a coloured field
 * holds dozens, even when the geometry is a thin strip.
 */
export async function distinctColours(app, png) {
  return app.evaluate(({ nativeImage }, b64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap();
    const seen = new Set();
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        const i = (y * width + x) * 4;
        seen.add(((bitmap[i + 2] >> 4) << 8) | ((bitmap[i + 1] >> 4) << 4) | (bitmap[i] >> 4));
      }
    }
    return seen.size;
  }, png.toString('base64'));
}

/**
 * Captures the canvas with the floating panels cropped away, until two
 * captures in a row are identical. A frame that has not drawn yet is a flat
 * background, so it is captured again after a pause, up to `attempts` times.
 */
export async function stableCanvas(page, { tries = 12, interval = 300, attempts = 3, app } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const clip = await canvasCropRect(page);
    assert.ok(clip && clip.width > 100 && clip.height > 100, 'the canvas has no uncovered area to capture');
    let previous = null;
    for (let i = 0; i < tries; i++) {
      const png = await page.screenshot({ clip, timeout: 30_000 });
      if (previous && png.equals(previous)) { last = png; break; }
      previous = png;
      last = png;
      await sleep(interval);
    }
    if (!app || (await distinctColours(app, last)) >= 24) return last;
    await sleep(2000);
  }
  return last;
}

/**
 * Writes a canvas-only PNG and checks it is neither blank nor oversized: a
 * frame that never drew is a few kilobytes, a field render is far larger.
 */
export async function canvasShot(page, file, { minBytes = 0, maxBytes = 1_500_000, app } = {}) {
  const png = await stableCanvas(page, { app });
  // Written before the checks, so a failed capture can be looked at.
  fs.writeFileSync(file, png);
  assert.ok(png.length <= maxBytes, `${file}: ${png.length} bytes exceeds ${maxBytes}`);
  if (minBytes) assert.ok(png.length >= minBytes, `${file}: ${png.length} bytes is below ${minBytes}`);
  if (app) {
    const colours = await distinctColours(app, png);
    assert.ok(colours >= 24, `${file}: only ${colours} distinct colours; the canvas did not draw`);
  }
  return png.length;
}

/** Reads a PNG's pixel size from its IHDR chunk. */
export function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

/**
 * CAD window after FE Mesh > Generate: waits for the status line, frames the model, parks the mouse on empty
 * canvas and writes the window to `file`. Returns the status text (counts) for captions.
 */
export async function feMeshShot(cad, file, timeout = 300_000) {
  await cad.locator('#meshing-generate').click();
  await until(async () => /\d/.test(await cad.locator('#meshing-status').innerText().catch(() => '')), 'FE mesh status', timeout);
  await sleep(1500);
  await cad.locator('#fit').click();
  await cad.mouse.move(2, 2);
  await sleep(1200);
  await cad.screenshot({ path: file, timeout: 60_000 });
  return (await cad.locator('#meshing-status').innerText()).replace(/\s+/g, ' ').trim();
}

const PLANAR = new Set(['fluid', 'potential-flow', 'shallow-water', 'fsi', 'rans', 'two-fluids']);
/**
 * Writes `<geometry>.view.json` (cad's ViewState sidecar, version 1) beside a scratch copy of a case so the CAD
 * camera, display mode and collapsed sidebar panels are fixed: a front view for planar (z = 0) cases, an
 * isometric one (y up) otherwise. `expanded` lists the collapsible panels to leave open; every other one is collapsed.
 */
export function seedView(geometryPath, caseId, expanded = ['parts-panel']) {
  const panels = ['tree-panel', 'parts-panel', 'layers-panel', 'edits-panel', 'scad-panel', 'meshing-panel', 'advanced-group'];
  const planar = PLANAR.has(caseId);
  fs.writeFileSync(`${geometryPath}.view.json`, JSON.stringify({
    version: 1,
    source: path.basename(geometryPath),
    view: {
      viewDirection: planar ? [0, 0, 1] : [1, 0.8, 1],
      cameraUp: [0, 1, 0],
      orthographic: false,
      displayMode: 'shaded',
      clip: null,
    },
    collapsedPanels: panels.filter((p) => !expanded.includes(p)),
  }, null, 2) + '\n');
}

/** CAD window with the Parts panel expanded (names visible), model framed, mouse parked. */
export async function partsShot(cad, file) {
  await cad.locator('#fit').click();
  await cad.mouse.move(2, 2);
  await sleep(1200);
  await cad.screenshot({ path: file, timeout: 60_000 });
  return (await cad.locator('#parts-body .part-name, #parts-body').first().innerText()).replace(/\s+/g, ' ').trim();
}
