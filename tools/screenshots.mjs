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
import { launchApp, waitForMarkers, appWindow, sleep, root } from "./e2eShared.mjs";

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

/** Click a selector if present (panel toggles); ignore absence. */
async function click(page, sel) {
  try {
    await page.locator(sel).click({ timeout: 3_000 });
    await sleep(400);
  } catch {
    warnings.push(`click ${sel} skipped`);
  }
}

// ---- Session A: CAD mode on bull.stp ----------------------------------------

async function sessionCad() {
  const { app, output } = await launchApp("cad/examples/STP/bull.stp", { extraArgs: EXTRA_ARGS });
  const deadline = Date.now() + 120_000;
  try {
    await waitForMarkers(output, ["[cad] host → webview: geometry", "[cad] host → webview: tree"], deadline);
    const page = await appWindow(app, "/renderer/cad/", deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
    await sleep(2_500); // let the geometry decode + first frames render

    await shoot(page, "cad-viewer.png");
    await shoot(page, "cad-toolbar.png", "#toolbar");
    await shoot(page, "cad-view-controls.png", "#view-controls");
    await shoot(page, "cad-edits-panel.png", "#edits-panel");
    await shoot(page, "cad-parts-panel.png", "#parts-panel");
    await shoot(page, "cad-fe-mesh-panel.png", "#meshing-panel");

    // The components tree (#tree-panel) is open by default for B-rep sources.
    await shoot(page, "cad-components-tree.png", "#tree-panel");

    await click(page, "#file-menu");
    await shoot(page, "cad-file-menu.png", "#file-dropdown");

    // The shell toolbar (mode toggle + Open), from its own view.
    const shell = await appWindow(app, "/renderer/shell/", deadline);
    await shoot(shell, "shell-toolbar.png");
  } finally {
    await app.close().catch(() => {});
  }
}

// ---- Session B: mesh mode on an MDPA model ----------------------------------

async function sessionMdpa() {
  const { app, output } = await launchApp("mesh/example/MDPA/double_arch.mdpa", { extraArgs: EXTRA_ARGS });
  const deadline = Date.now() + 90_000;
  try {
    await waitForMarkers(output, ["[mesh] host → webview: model", "[mesh] host → webview: opState"], deadline);
    const page = await appWindow(app, "/renderer/mesh/", deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
    await sleep(2_500);

    await shoot(page, "mesh-viewer.png");
    await shoot(page, "mesh-outline.png", "#sidebar");
    await shoot(page, "mesh-toolbar.png", "#toolbar");

    await click(page, "#file-menu-btn");
    await shoot(page, "mesh-file-menu.png", "#file-menu-popup");
  } finally {
    await app.close().catch(() => {});
  }
}

// ---- Session C: mesh mode on a VTK time series --------------------------------

async function sessionVtk() {
  const { app, output } = await launchApp("mesh/example/VTK/Main_0_6.vtk", { extraArgs: EXTRA_ARGS });
  const deadline = Date.now() + 90_000;
  try {
    await waitForMarkers(output, ["[mesh] host → webview: vtkGroup", "[mesh] host → webview: vtkFrame"], deadline);
    const page = await appWindow(app, "/renderer/mesh/", deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });
    await sleep(2_500);

    await shoot(page, "mesh-vtk-timeline.png");
  } finally {
    await app.close().catch(() => {});
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
    await app.close().catch(() => {});
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
