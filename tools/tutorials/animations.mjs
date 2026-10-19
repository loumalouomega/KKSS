#!/usr/bin/env node
/**
 * Animated GIF captures for the transient tutorials. Each shots.mjs entry with
 * producer 'animation' is one GIF: one field stepped through the recovered
 * frames in the real viewer, with the colour range pinned so every frame is on
 * the same scale. The encoder is tools/lib/gif.mjs, which has no dependencies.
 *
 *   KKSS_TUTORIAL_WAYLAND=<socket> node tools/tutorials/animations.mjs [file ...]
 *
 * Structure displacement GIFs (warped for display) are not regenerated here:
 * they are catalogued as legacy and stay as they were.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { closeApp, sleep } from '../e2eShared.mjs';
import { encodeGif } from '../lib/gif.mjs';
import { resultsDir, root } from './results.mjs';
import { CATALOG } from './shots.mjs';
import { canvasCropRect, command, fit, gotoFrame, launchWindow, resetView, setField, setModes, setRange, setScalarBar, waitForDocument } from './capture.mjs';

/** Every GIF must stay under this, so doc/public does not balloon. */
export const GIF_BUDGET_BYTES = 1_500_000;
const WIDTH = 640;
const DELAY_MS = 100; // 10 fps
const STRIDE = 3; // every third saved frame is evenly paced

/** Frame indices (0-based): every STRIDE-th from `fromStep` (1-based), always ending on the last frame. */
export function frameIndices(fromStep, total, stride = total <= 10 ? 1 : STRIDE) {
  const out = [];
  for (let i = fromStep - 1; i < total; i += stride) out.push(i);
  if (out.at(-1) !== total - 1) out.push(total - 1);
  return out;
}

/** The GIFs this script regenerates: catalog entries of the animation producer. */
export const series = () => CATALOG.filter((shot) => shot.producer === 'animation');

/** The uncovered canvas region of the current frame as RGBA, resized to the GIF width in the main process. */
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
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = 255;
  }
  return { width: img.width, height: img.height, rgba };
}

const sameFrame = (a, b) => a.rgba.length === b.rgba.length && Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;

/** Renders one GIF: the field over the recovered steps, camera fixed on the last step. */
export async function captureAnimation(entry, out) {
  const results = resultsDir(entry.case);
  const [, frames] = [...results.families.entries()].find(([name]) => !entry.participant || name.startsWith(entry.participant));
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), `kkss-gif-${entry.case}-`));
  try {
    fs.cpSync(results.vtkDir, path.join(caseDir, 'vtk_output'), { recursive: true });
    const file = path.join(caseDir, 'vtk_output', frames[0].name);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-gif-profile-'));
    const { app, page, output } = await launchWindow(file, { profile, width: 1600, height: 960 });
    try {
      await waitForDocument(page, path.basename(file));
      await sleep(2000);
      const total = await page.locator('#tl-scrub').evaluate((el) => Number(el.max) + 1);
      // The scene is built on the last step first, so the camera fits the model
      // the field will be drawn on (see gallery.mjs for the same sequence).
      await gotoFrame(page, total);
      await sleep(1200);
      await setField(page, entry.field);
      await setModes(page, entry.modes ?? ['Contour']);
      await setRange(page, entry.range[0], entry.range[1]);
      await setScalarBar(page, true);
      if (entry.clip) await command(page, `clip on axis=${entry.clip.axis} pos=${entry.clip.pos}`);
      await resetView(page);
      if (entry.view) await command(page, `view ${entry.view}`);
      await fit(page);
      // As in gallery.mjs: pulled back so the fitted model clears the Field panel.
      for (let i = 0; i < (entry.zoomOut ?? 0); i++) await page.locator('#nav-zoom-out').click();
      await sleep(800);
      // One crop for every frame, so the GIF has a fixed size.
      const clip = await canvasCropRect(page);
      assert.ok(clip && clip.width > 100 && clip.height > 100, 'the canvas has an uncovered area');

      const grabbed = [];
      for (const index of frameIndices(entry.from ?? 1, total, entry.stride)) {
        await gotoFrame(page, index + 1);
        await sleep(400);
        grabbed.push(await grab(app, page, clip));
      }
      assert.ok(!sameFrame(grabbed[0], grabbed.at(-1)), `${entry.file}: first and last frames are identical; nothing animated`);
      const gif = encodeGif(grabbed, { delayMs: DELAY_MS });
      assert.ok(gif.length <= GIF_BUDGET_BYTES, `${entry.file}: ${gif.length} bytes exceeds the ${GIF_BUDGET_BYTES}-byte budget`);
      fs.writeFileSync(path.join(out, entry.file), gif);
      const errors = output().split('\n').filter((l) => /Uncaught|TypeError/.test(l));
      assert.equal(errors.length, 0, `${entry.file}: errors in the viewer log`);
      console.log(`animation ${entry.file}: ${grabbed.length} frames, ${grabbed[0].width}x${grabbed[0].height}, ${(gif.length / 1024).toFixed(0)} KiB`);
    } finally {
      await closeApp(app);
      fs.rmSync(profile, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(caseDir, { recursive: true, force: true });
  }
}

export async function captureAnimations(out = path.join(root, 'doc/public/screenshots'), selected = []) {
  for (const entry of series().filter((s) => !selected.length || selected.some((name) => s.file.includes(name)))) {
    await captureAnimation(entry, out);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await captureAnimations(path.join(root, 'doc/public/screenshots'), process.argv.slice(2));
}
