/**
 * Animated GIF captures for the transient tutorials (roadmap: docs media only,
 * no app behaviour). Opens the committed solver output of the fluid and coupled
 * tutorials in the real app, pins the Field panel's colour range, steps the mesh
 * timeline and encodes the viewport with the dependency-free encoder in tools/lib/gif.mjs.
 *
 *   env -u ELECTRON_RUN_AS_NODE xvfb-run -a node tools/tutorials/animations.mjs
 *   npm run docs:screenshots -- --animations-only
 *
 * Scope is deliberate. The shallow-water tutorial is a still basin (HEIGHT is
 * 1 m in every frame) so animating it would show nothing and mislead; it is
 * left as static PNGs. Fluid pressure skips steps 1-4: the impulsive start
 * (3300 Pa at step 1, ±9 Pa from step 10) would otherwise dictate the colour
 * range and flatten the other 47 frames. The coupled tutorials contribute one
 * fluid-velocity and one interface-displacement GIF each.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { launchApp, appWindow, closeApp, waitForMarkers, until, softwareGL, diagnostics, sleep, root } from '../e2eShared.mjs';
import { encodeGif } from '../lib/gif.mjs';

/** Every GIF must stay under this, so doc/public does not balloon. */
export const GIF_BUDGET_BYTES = 1_500_000;
const WIDTH = 640;
const DELAY_MS = 100; // 10 fps
const STRIDE = 3; // every 3rd saved frame is evenly paced

/** `fromStep` is 1-based, matching the timeline label and the tutorial text. */
/** `family` selects the VTK filename prefix inside the case's `vtk_output/`. */
export const series = [
  { case: 'fluid', family: 'FluidModelPart', file: 'tutorial-fluid-velocity.gif', field: 'VELOCITY', range: [0, 0.17], fromStep: 1, frames: 51 },
  { case: 'fluid', family: 'FluidModelPart', file: 'tutorial-fluid-pressure.gif', field: 'PRESSURE', range: [-10, 10], fromStep: 5, frames: 51 },
  { case: 'fsi', family: 'FluidModelPart', file: 'tutorial-fsi-velocity.gif', field: 'VELOCITY', range: [0, 0.13], fromStep: 1 },
  // The Mok wall bends ~8 cm: warp 1 keeps it in frame, and the colour range
  // covers the published 8.3 cm peak plus discretisation spread.
  { case: 'fsi', family: 'Structure', file: 'tutorial-fsi-displacement.gif', field: 'DISPLACEMENT', range: [0, 0.12], fromStep: 1, warp: 1 },
  { case: 'cosim', family: 'FluidModelPart', file: 'tutorial-cosim-velocity.gif', field: 'VELOCITY', range: [0, 0.15], fromStep: 1 },
  { case: 'cosim', family: 'Structure', file: 'tutorial-cosim-displacement.gif', field: 'DISPLACEMENT', range: [0, 0.005], fromStep: 1, warp: 200 },
];

/** Frame indices (0-based): every STRIDE-th from `fromStep`, always ending on the last frame. */
export function frameIndices(fromStep, total, stride = STRIDE) {
  const out = [];
  for (let i = fromStep - 1; i < total; i += stride) out.push(i);
  if (out[out.length - 1] !== total - 1) out.push(total - 1);
  return out;
}

const nextPaint = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function grab(app, page, clip) {
  const png = await page.screenshot({ clip });
  // nativeImage decodes and resizes in the main process: no PNG dependency.
  const img = await app.evaluate(({ nativeImage }, { b64, width }) => {
    const resized = nativeImage.createFromBuffer(Buffer.from(b64, 'base64')).resize({ width, quality: 'best' });
    const size = resized.getSize();
    return { width: size.width, height: size.height, bgra: resized.toBitmap().toString('base64') };
  }, { b64: png.toString('base64'), width: WIDTH });
  const bgra = Buffer.from(img.bgra, 'base64');
  const rgba = new Uint8Array(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
  return { width: img.width, height: img.height, rgba };
}

const sameFrame = (a, b) => a.rgba.length === b.rgba.length && Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;

export async function captureAnimations(out, selected = []) {
  const wanted = series.filter((s) => !selected.length || selected.some((n) => s.file.includes(n)));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-animation-'));
  try {
    for (const s of wanted) await captureSeries(temp, out, s);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

async function captureSeries(temp, out, s) {
  const dir = fs.mkdtempSync(path.join(temp, `${s.case}-`)), profile = path.join(dir, 'profile');
  // Published tutorials ship no VTK timelines (only case files and the
  // verification record), so GIFs cannot be regenerated from the archive;
  // the committed GIFs stand. Regeneration needs a local run's vtk_output.
  const published = path.join(root, 'doc/public/examples/tutorials', s.case, 'vtk_output');
  if (!fs.existsSync(published)) {
    console.warn(`animations: skipping ${s.file} (no published VTK for ${s.case}; regenerate from a local run)`);
    return;
  }
  fs.cpSync(published, path.join(dir, 'vtk_output'), { recursive: true });
  const first = fs.readdirSync(path.join(dir, 'vtk_output')).filter(n => n.startsWith(s.family) && n.endsWith('.vtk')).sort()[0];
  assert.ok(first, `${s.file}: no ${s.family} VTK family in ${s.case}/vtk_output`);
  fs.mkdirSync(profile);
  const { app, output } = await launchApp(path.join(dir, 'vtk_output', first), {
    userDataDir: profile, extraArgs: [...softwareGL, '--force-device-scale-factor=1'],
  });
  try {
    await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0].setContentSize(1100, 480));
    const deadline = Date.now() + 120000;
    await waitForMarkers(output, ['[mesh] host → webview: vtkFrame'], deadline);
    const page = await appWindow(app, '/renderer/mesh/', deadline);
    await page.locator('#doc-chip-name').getByText(first, { exact: true }).waitFor();
    const total = Number(await page.locator('#tl-scrub').getAttribute('max')) + 1;
    if (s.frames !== undefined) assert.equal(total, s.frames, `${s.file}: expected ${s.frames} frames, found ${total}`);
    else assert.ok(total >= 2, `${s.file}: timeline holds a single frame — nothing to animate`);

    await page.locator('#toolbar button[data-action="field"]').click();
    const selector = page.locator('#field-panel select').first();
    await selector.waitFor();
    const options = await selector.locator('option').evaluateAll((els) => els.map((el) => ({ text: el.textContent, value: el.value })));

    const choice = options.find((o) => o.text.startsWith(`${s.field} `));
    assert.ok(choice, `Missing ${s.field}`);
    await selector.selectOption(choice.value);
    // Pin the range so the colours mean the same thing on every frame.
    const inputs = page.locator('#field-panel .field-range-input');
    await inputs.nth(0).fill(String(s.range[0])); await inputs.nth(0).press('Tab');
    await inputs.nth(1).fill(String(s.range[1])); await inputs.nth(1).press('Tab');
    const scalarBar = page.locator('#field-panel label', { hasText: 'Show scalar bar in scene' }).locator('input');
    if (!(await scalarBar.isChecked())) await scalarBar.check();
    await page.locator('#toolbar button[data-action="reset"]').click();
    if (s.warp) {
      // Display-only warp for the coupled slab (2 m × 50 mm, millimetre
      // bending), front view: the same 200× the tutorial figure names, chosen
      // so the deflected shape stays inside this window's frame too.
      const deformedMode = page.locator('.field-mode-btn').filter({ hasText: 'Deformed' });
      await deformedMode.click();
      const deformForm = page.locator('.field-subform').filter({ hasText: 'Deform by' });
      await deformForm.locator('select').selectOption(choice.value);
      await deformForm.locator('input[type="range"]').evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, s.warp);
      await page.locator('body').press('5'); // +Z FRONT: the X-Y bending plane face-on
    }

    // Capture only the 3D canvas: hide the floating chrome while shooting.
    const chrome = ['#toolbar', '#field-panel', '#nav-controls'];
    const setChrome = (hidden) => page.evaluate(([ids, h]) => ids.forEach((id) => {
      const el = document.querySelector(id); if (el) el.style.visibility = h ? 'hidden' : '';
    }), [chrome, hidden]);
    const clip = await page.locator('canvas').first().boundingBox();
    assert.ok(clip && clip.width > 300, 'canvas has a size');

    const frames = [];
    for (const index of frameIndices(s.fromStep, total)) {
      await page.evaluate((i) => {
        const scrub = document.getElementById('tl-scrub');
        scrub.value = String(i);
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
      }, index);
      await until(async () => (await page.locator('#tl-label').textContent()).includes(`(${index + 1}/${total})`), `timeline at frame ${index + 1}`, 30000);
      await setChrome(true);
      await nextPaint(page); await sleep(250); await nextPaint(page);
      frames.push(await grab(app, page, clip));
      await setChrome(false);
    }
    assert.ok(!sameFrame(frames[0], frames[frames.length - 1]), `${s.file}: first and last frames are identical — nothing animated`);
    const gif = encodeGif(frames, { delayMs: DELAY_MS });
    assert.ok(gif.length <= GIF_BUDGET_BYTES, `${s.file}: ${gif.length} bytes exceeds the ${GIF_BUDGET_BYTES}-byte budget`);
    if (out) fs.writeFileSync(path.join(out, s.file), gif);
    console.log(`PASS animation ${s.file}: ${frames.length} frames, ${frames[0].width}x${frames[0].height}, ${(gif.length / 1024).toFixed(0)} KiB`);
  } catch (error) {
    await diagnostics(app, output, 'animations').catch(() => {});
    throw error;
  } finally { await closeApp(app); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await captureAnimations(path.join(root, 'doc/public/screenshots'), process.argv.slice(2));
}
