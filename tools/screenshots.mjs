/**
 * Documentation screenshot generator — the KKSS counterpart of the cad
 * submodule's scripts/screenshots/ pipeline, but *more* end-to-end: instead
 * of a harness page fed with fixtures, it launches the REAL Electron app
 * (out/ layout) on real example files from the submodules and captures the
 * live windows with Playwright.
 *
 *   Session A  cad/examples/STP/bull.stp          → CAD viewer + panels + shell
 *   Session B  mesh/example/MDPA/double_arch.mdpa → mesh viewer + outline
 *   Session C  mesh/example/VTK/Main_0_6.vtk      → VTK timeline view
 *   Session D  no file                            → home screen (main menu)
 *
 * PNGs land in doc/public/screenshots/ (committed, kebab-case — same
 * convention as cad) and the two README heroes are refreshed in images/.
 *
 * Run (after a full `npm run build` at least once):
 *   env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run docs:screenshots
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { launchApp, waitForMarkers, appWindow, closeApp, sleep, root } from "./e2eShared.mjs";

const OUT = path.join(root, "doc", "public", "screenshots");
const IMAGES = path.join(root, "images");
// 2x pixel density, matching cad's deviceScaleFactor: 2 retina PNGs.
const EXTRA_ARGS = ["--force-device-scale-factor=2"];

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(IMAGES, { recursive: true });

const warnings = [];

/** Full-page or element (`sel`) screenshot; element shots warn-only. */
async function shoot(page, file, sel) {
  const dest = path.join(OUT, file);
  try {
    if (sel) await page.locator(sel).screenshot({ path: dest });
    else await page.screenshot({ path: dest });
    console.log(`shot ${file}`);
  } catch (err) {
    if (sel) {
      warnings.push(`${file}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    } else {
      throw err;
    }
  }
}

/**
 * Whole-window viewer shot. Deliberately the full page, not an element clip:
 * `#app` means different things in the two viewers — mesh's is the page root,
 * but cad's is only the canvas area inside `#layout`, so clipping to it would
 * silently crop cad's menubar and its `#side` panel column. With the window
 * sized and the scale pinned (`prepareWindow`), the page IS the window.
 */
async function shootViewer(page, file) {
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`shot ${file}`);
}

/** Click a selector if present (panel toggles); ignore absence. */
async function click(page, sel) {
  try {
    await page.locator(sel).click({ timeout: 3_000 });
    await sleep(400);
  } catch {
    warnings.push(`click ${sel} skipped`);
  }
}

/**
 * The viewers' chrome grew with cad 1.2 / mesh 3.0 (toolbar dropdowns, the
 * unified nav card with its Clip/Appearance/Display groups), and no longer
 * fits the default 1360×860 window — the nav card and the sidebar labels clip.
 *
 * The fix is a bigger capture window, NOT a smaller interface scale: measured
 * against the running app, `setZoomFactor` scales the rendered content but the
 * mode views' layout viewport stays at the same CSS-pixel count, so a
 * zoomed-out view paints into only that fraction of its bounds and the shot
 * comes back framed in dead space.
 */
const SHOT_SIZE = { width: 1760, height: 1000 };

/**
 * Sizes the window for capture and pins the interface scale to 100%.
 *
 * The scale matters because it is persisted (`uiZoom`): without pinning it, a
 * run would inherit whatever the developer last set, and a zoomed-out view
 * leaves an unpainted band — `setZoomFactor` scales the rendered content while
 * the view's layout viewport stays at the same CSS-pixel count, so the page
 * covers only that fraction of its bounds. Whatever scale was found is put
 * back before the session ends, so generating docs never rewrites the user's
 * own preference.
 */
async function prepareWindow(app, deadline) {
  await app.evaluate(async ({ BaseWindow }, size) => {
    // One BaseWindow hosts every view (app/main/windows.ts); its own resize
    // listener re-runs layout(), so the views follow.
    const win = BaseWindow.getAllWindows()[0];
    if (win) win.setContentSize(size.width, size.height);
  }, SHOT_SIZE);
  const shell = await appWindow(app, "/renderer/shell/", deadline);
  const previousZoom = await shell.locator("#zoom-select").inputValue();
  if (previousZoom !== "1") await shell.selectOption("#zoom-select", "1");
  await sleep(800); // relayout + the viewers' ResizeObserver reframing
  return { shell, previousZoom };
}

async function restoreWindow(prepared) {
  if (!prepared || prepared.previousZoom === "1") return;
  try {
    await prepared.shell.selectOption("#zoom-select", prepared.previousZoom);
    await sleep(400); // let the stateStore write land before the app closes
  } catch {
    warnings.push(`could not restore the interface scale to ${prepared.previousZoom}`);
  }
}

// ---- Session A: CAD mode on bull.stp ----------------------------------------

async function sessionCad() {
  const { app, output } = await launchApp("cad/examples/STP/bull.stp", { extraArgs: EXTRA_ARGS });
  const deadline = Date.now() + 120_000;
  let prepared;
  try {
    await waitForMarkers(output, ["[cad] host → webview: geometry", "[cad] host → webview: tree"], deadline);
    const page = await appWindow(app, "/renderer/cad/", deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
    await sleep(2_500); // let the geometry decode + first frames render
    prepared = await prepareWindow(app, deadline);

    await shootViewer(page, "cad-viewer.png");
    await shoot(page, "cad-toolbar.png", "#toolbar");
    await shoot(page, "cad-view-controls.png", "#view-controls");
    await shoot(page, "cad-edits-panel.png", "#edits-panel");
    await shoot(page, "cad-parts-panel.png", "#parts-panel");
    await shoot(page, "cad-fe-mesh-panel.png", "#meshing-panel");

    // The components tree (#tree-panel) is open by default for B-rep sources —
    // don't "helpfully" click #tree-toggle first, that closes it.
    await shoot(page, "cad-components-tree.png", "#tree-panel");

    await click(page, "#file-menu");
    await shoot(page, "cad-file-menu.png", "#file-dropdown");

    // The shell toolbar (mode toggle + Open), from its own view.
    await shoot(await appWindow(app, "/renderer/shell/", deadline), "shell-toolbar.png");
  } finally {
    await restoreWindow(prepared);
    await closeApp(app);
  }
}

// ---- Session B: mesh mode on an MDPA model ----------------------------------

async function sessionMdpa() {
  const { app, output } = await launchApp("mesh/example/MDPA/double_arch.mdpa", { extraArgs: EXTRA_ARGS });
  const deadline = Date.now() + 90_000;
  let prepared;
  try {
    await waitForMarkers(output, ["[mesh] host → webview: model", "[mesh] host → webview: opState"], deadline);
    const page = await appWindow(app, "/renderer/mesh/", deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
    await sleep(2_500);
    prepared = await prepareWindow(app, deadline);

    await shootViewer(page, "mesh-viewer.png");
    await shoot(page, "mesh-outline.png", "#sidebar");
    await shoot(page, "mesh-toolbar.png", "#toolbar");

    // mesh 3.0.0 moved the webview's own File menu into an in-flow menubar
    // that KKSS hides in favour of the native one (mesh-overrides.css), so the
    // View ▾ dropdown — the toolbar menu that IS reachable here — is what this
    // documents instead.
    await click(page, '[data-action="viewMenu"]');
    await shoot(page, "mesh-view-menu.png", "#view-popup");
  } finally {
    await restoreWindow(prepared);
    await closeApp(app);
  }
}

// ---- Session C: mesh mode on a VTK time series --------------------------------

async function sessionVtk() {
  const { app, output } = await launchApp("mesh/example/VTK/Main_0_6.vtk", { extraArgs: EXTRA_ARGS });
  const deadline = Date.now() + 90_000;
  let prepared;
  try {
    await waitForMarkers(output, ["[mesh] host → webview: vtkGroup", "[mesh] host → webview: vtkFrame"], deadline);
    const page = await appWindow(app, "/renderer/mesh/", deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
    await sleep(2_500);
    prepared = await prepareWindow(app, deadline);

    await shootViewer(page, "mesh-vtk-timeline.png");
  } finally {
    await restoreWindow(prepared);
    await closeApp(app);
  }
}

// ---- Session D: home screen (no file argument) --------------------------------

async function sessionHome() {
  const { app } = await launchApp(undefined, { extraArgs: EXTRA_ARGS });
  const deadline = Date.now() + 60_000;
  try {
    const page = await appWindow(app, "/renderer/home/", deadline);
    await page.waitForSelector(".menu-btn", { timeout: 15_000 });
    await sleep(800);
    await shoot(page, "home-screen.png");
  } finally {
    await closeApp(app);
  }
}

await sessionCad();
await sessionMdpa();
await sessionVtk();
await sessionHome();

// ---- README hero refresh (same pattern as cad's capture.mjs tail) -------------

for (const [src, dst] of [
  ["cad-viewer.png", "pre_processing.png"],
  ["mesh-viewer.png", "post_processing.png"],
]) {
  fs.copyFileSync(path.join(OUT, src), path.join(IMAGES, dst));
  console.log(`hero ${dst} ← ${src}`);
}

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):\n  ${warnings.join("\n  ")}`);
}
console.log("done");
