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
 *   npm run docs:screenshots -- --mesh-only  # mesh viewer/panels/timeline only
 *   npm run docs:screenshots -- --cad-only   # CAD viewer/panels/menus only
 *   npm run docs:screenshots -- --animations-only  # fluid-tutorial timeline GIFs only
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchApp, waitForMarkers, appWindow, closeApp, sleep, root } from "./e2eShared.mjs";

import { jobsScenario } from "./jobs.e2e.mjs";
import { kratosStartupScenario } from "./kratosStartup.e2e.mjs";
import { manualTutorials } from "./tutorials/manual.mjs";
import { captureAnimations } from "./tutorials/animations.mjs";
import { scriptedCapture } from "./tutorials/assistant.mjs";
import { mesh423Scenario } from "./e2e/mesh-423.mjs";
import { meshPlotsScenario } from "./e2e/mesh-plots.mjs";
import { optimizationRunScenario } from "./e2e/optimization-run.mjs";

const OUT = path.join(root, "doc", "public", "screenshots");
const IMAGES = path.join(root, "images");

/**
 * Every fixture is COPIED into the run's own temp tree before it is opened.
 * mesh 5.10.0 persists the open panels in `<stem>.kratosview.json`, so opening
 * a submodule's own example file leaves an artifact in the submodule working
 * tree — which would show up as an untracked file in the next submodule diff.
 */
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-shots-"));
/** Copies a submodule fixture (or anything else, relative to the repo) and returns its temp path. */
const fixture = relative => {
  const dest = path.join(fixtureDir, path.basename(relative));
  fs.cpSync(path.join(root, relative), dest, { recursive: true });
  return dest;
};
// 2x pixel density, matching cad's deviceScaleFactor: 2 retina PNGs.
const EXTRA_ARGS = ["--force-device-scale-factor=2"];

/**
 * One throwaway profile shared by all four sessions, in order.
 *
 * Two reasons it must be isolated rather than the real ~/.config/kkss: the home
 * screen now lists recent files, so a committed PNG would otherwise capture
 * whatever the person regenerating it had open; and a fresh profile means
 * default theme/zoom/viewer settings, so the shots are reproducible rather than
 * reflecting one developer's preferences. Sharing it *across* sessions is what
 * makes Session D deterministic: A, B and C open bull.stp, double_arch.mdpa and
 * Main_0_6.vtk, so the home screen then shows exactly those three.
 */
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-docs-profile-"));
// The copied fixtures go in the profile's own temp tree, so one cleanup covers both.
const cleanupDirs = () => {
  for (const dir of [profileDir, fixtureDir]) fs.rmSync(dir, { recursive: true, force: true });
};

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
 * one-row nav dock with its inline Clip group and ⋯ popover), and no longer
 * fits the default 1360×860 window — the nav dock and the sidebar labels clip.
 *
 * The fix is a bigger capture window, NOT a smaller interface scale: measured
 * against the running app, `setZoomFactor` scales the rendered content but the
 * mode views' layout viewport stays at the same CSS-pixel count, so a
 * zoomed-out view paints into only that fraction of its bounds and the shot
 * comes back framed in dead space.
 *
 * Height grew again with cad 2.x: `#side` is a fixed-height flex column with
 * `overflow: hidden` (no scrollbar), and its panels — three new ones (Clash,
 * Primitives, plus Region Fit/Mesh Health's own growth) on top of the bundled
 * starter macro library making the Macros panel non-empty by default — now
 * total more height than 1000px holds. Flexbox's answer to that overflow is
 * to silently squeeze SOME panels (Tree/Parts/Edits, at this width) to 0px
 * rather than clipping evenly, so `cad-edits-panel.png`/`cad-parts-panel.png`
 * timed out screenshotting an invisible element instead of looking merely
 * cropped. 1600 was measured against the running app to fit every section's
 * default-expanded state with room to spare.
 */
const SHOT_SIZE = { width: 1760, height: 1600 };

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
async function prepareWindow(app, deadline, size = SHOT_SIZE) {
  await app.evaluate(async ({ BaseWindow }, size) => {
    // One BaseWindow hosts every view (app/main/windows.ts); its own resize
    // listener re-runs layout(), so the views follow.
    const win = BaseWindow.getAllWindows()[0];
    if (win) win.setContentSize(size.width, size.height);
  }, size);
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
  const { app, output } = await launchApp(fixture("cad/examples/STP/bull.stp"), { extraArgs: EXTRA_ARGS, userDataDir: profileDir });
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
  const { app, output } = await launchApp(fixture("mesh/example/MDPA/double_arch.mdpa"), { extraArgs: EXTRA_ARGS, userDataDir: profileDir });
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
    // whose File pill KKSS hides in favour of the native one (mesh-overrides.css;
    // the strip itself stays, carrying the document chip), so the
    // View ▾ dropdown — the toolbar menu that IS reachable here — is what this
    // documents instead.
    await click(page, '[data-action="viewMenu"]');
    await shoot(page, "mesh-view-menu.png", "#view-popup");
    await click(page, '[data-action="viewMenu"]');
    await click(page, '[data-action="selection"]');
    await shoot(page, "mesh-selection.png", "#selection-panel");
    await click(page, '[data-action="selection"]');

  } finally {
    await restoreWindow(prepared);
    await closeApp(app);
  }
}

// A property-bearing frame makes the authoring controls visible in the guide.
async function sessionProperties() {
  const { app, output } = await launchApp(fixture("mesh/example/MDPA/portal_frame.mdpa"), { extraArgs: EXTRA_ARGS, userDataDir: profileDir });
  const deadline = Date.now() + 90_000;
  let prepared;
  try {
    await waitForMarkers(output, ["[mesh] host → webview: model"], deadline);
    const page = await appWindow(app, "/renderer/mesh/", deadline);
    prepared = await prepareWindow(app, deadline);
    await click(page, '[data-action="advanced"]');
    await click(page, '[data-action="propertiesEditor"]');
    await shoot(page, "mesh-properties.png", "#properties-panel");
  } finally {
    await restoreWindow(prepared);
    await closeApp(app);
  }
}

// ---- Session B2: mesh Problemtype sidebar on the Kratos 3D hook -------------
//
// Documents the mesh 5.11.0 problemtype families (Structural Optimization,
// the four ROM trainers, strong CoSimulation) against OptimizationApplication's
// own 3D hook case from ~/src/Examples: a tetrahedral SmallDisplacementElement3D4N
// volume mesh whose SubModelParts are named exactly what the panels talk about
// (domain, design_surface_1, main_load_1, support_*, tip_1, non_design_*), plus
// its implicit-vertex-morphing optimization_parameters.json and a solver-written
// summary (the mesh submodule's own gradient-projection fixture) for the
// Optimization progress panel. Each stage launches with a seeded
// `<stem>.kratoscase.json` so the sidebar renders populated forms. The outline's
// default visibility keeps the shaded boundary skin shown (the tetra block is
// hidden behind those real surface parts) — the prettiest honest mesh view, so
// the harness leaves it as the viewer opens it. Skips cleanly where
// ~/src/Examples is absent (CI): the committed PNGs stay as they are.
// `--disable-gpu` pins the renderer to software GL: on GPU-composited
// desktops the vtk.js scene build can lose its WebGL context mid-build
// (observed on a GL-flaky workstation, where the unhandled exception left
// `#app { display:none }` behind), while SwiftShader produces identical doc
// frames deterministically.
const PROBLEMTYPE_EXAMPLES = () => path.join(os.homedir(), "src", "Examples");
const HOOK_SUBDIR = path.join("optimization_application", "use_cases", "3d_hook");
const problemaState = () => ({
  version: 1,
  values: {},
  assignments: [],
  materials: [],
  output: { format: "ascii", controlType: "step", interval: 1, nodalVariables: [] },
});

async function shotProblemtypeStage(name, problemtypeId, caseStateFile) {
  const stage = path.join(fixtureDir, name);
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(PROBLEMTYPE_EXAMPLES(), HOOK_SUBDIR, "hook.mdpa"), path.join(stage, "hook.mdpa"));
  fs.writeFileSync(path.join(stage, "hook.kratoscase.json"),
    JSON.stringify({ ...problemaState(), problemtypeId, ...caseStateFile }, null, 2));
  const { app, output } = await launchApp(path.join(stage, "hook.mdpa"), { extraArgs: [...EXTRA_ARGS, "--disable-gpu"], userDataDir: profileDir });
  const deadline = Date.now() + 180_000;
  let prepared;
  try {
    await waitForMarkers(output, ["[mesh] host → webview: model"], deadline);
    const page = await appWindow(app, "/renderer/mesh/", deadline);
    // The first `progress` message hides `#app` behind the loading overlay
    // until the model is applied to the scene; the selects live inside it.
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#app")).display !== "none", null, { timeout: 60_000 });
    await page.waitForSelector("#pt-select", { state: "visible", timeout: 20_000 });
    await sleep(1_200);
    // Resolution: a larger frame just for these captures — at the shared 2×
    // device scale the full-window PNGs come out ~4400×3800, so the sidebar
    // cards and the hook render at full doc legibility.
    prepared = await prepareWindow(app, deadline, { width: 2200, height: 1900 });
    await sleep(400);
    await page.selectOption("#pt-select", problemtypeId);
    await page.waitForFunction(() => document.querySelectorAll("#pt-collections .pt-card, #pt-forms .pt-card").length > 0, null, { timeout: 20_000 });
    await sleep(2_500); // scene settle (a 10 MB tetra mesh) before framing
    await click(page, "#nav-fit"); // fit the whole model deterministically
    await page.keyboard.press("i"); // the isometric corner view (`1–6`/`i` presets)
    await sleep(800); // snap + repaint
    return { page, caseDir: stage, close: async () => { await restoreWindow(prepared); await closeApp(app); } };
  } catch (err) {
    try { await restoreWindow(prepared); await closeApp(app); } catch { /* surface the real error */ }
    throw err;
  }
}

/** Expands the `.pt-card` whose title label matches, inside the given host. */
async function expandProblemtypeCards(page, titles) {
  await page.evaluate((wanted) => {
    for (const title of document.querySelectorAll("#pt-forms .pt-card > .edit-form-title, #pt-collections .pt-card > .edit-form-title")) {
      const label = title.querySelector(".pt-card-title")?.textContent ?? title.textContent ?? "";
      if (wanted.includes(label)) title.click();
    }
  }, titles);
  await sleep(600);
}

/**
 * Layer un-hide helper for meshes whose visibility defaults hide a needed
 * block (a shell `3D4N` mesh decodes to a volume, so upstream's outline
 * default hides it behind surface blocks). The 3D hook needs no un-hide —
 * its shaded boundary skin is the intended view — but the helper stays so a
 * future fixture with the same shape can still be framed honestly.
 */
async function ensureBlockVisible(page, labelPart) {
  await page.evaluate((part) => {
    for (const row of document.querySelectorAll("#sidebar label")) {
      const text = row.textContent ?? "";
      if (text.includes(part)) {
        const box = row.querySelector("input[type=checkbox]");
        if (box && !box.checked) box.click();
        return;
      }
    }
  }, labelPart);
  await sleep(900); // scene re-render
}

/**
 * Scrolls the mesh viewer's sidebar so `wanted` (a container id or a card
 * title) is at the top — the sidebar is its own scroll container, the mesh
 * view on the right never moves. `shootFull` then takes a WHOLE-WINDOW shot:
 * problemtype panel left, the loaded mesh right (side-by-side context, as in
 * the other viewer figures), with the pointer parked off the chrome.
 */
async function ptScroll(page, wanted) {
  await page.evaluate((key) => {
    if (key.startsWith("#")) {
      document.querySelector(key)?.scrollIntoView({ block: "start" });
      return;
    }
    for (const card of document.querySelectorAll("#pt-forms .pt-card, #pt-collections .pt-card")) {
      const label = card.querySelector(".pt-card-title")?.textContent ?? "";
      if (label === key) { card.scrollIntoView({ block: "start" }); break; }
    }
  }, wanted);
  await sleep(500);
}

const shootFull = async (page, file) => {
  await page.mouse.move(0, 0);
  await sleep(300);
  await shootViewer(page, file);
};

async function sessionProblemtypes() {
  const paramsSrc = path.join(PROBLEMTYPE_EXAMPLES(), HOOK_SUBDIR, "implicit_vertex_morphing", "optimization_parameters.json");
  const summarySrc = path.join(root, "mesh", "src", "test", "fixtures", "optimization", "gradient_projection_cut.csv");
  const meshSrc = path.join(PROBLEMTYPE_EXAMPLES(), HOOK_SUBDIR, "hook.mdpa");
  for (const f of [meshSrc, paramsSrc, summarySrc]) {
    if (!fs.existsSync(f)) {
      warnings.push(`problemtypes session skipped: missing ${f}`);
      return;
    }
  }

  // 1 — Structural Optimization: seeded responses/controls/constraints, then
  // the progress panel fed by the hook's own optimization_parameters.json +
  // the solver summary fixture.
  {
    const { page, caseDir, close } = await shotProblemtypeStage("opt-optimization", "optimization", {
      values: {
        algorithm: { algorithmType: "algorithm_gradient_projection" },
      },
      // A real primal load on the hook's own load face clears the preflight
      // "strain-energy needs a loaded primal" finding the seeded template
      // would otherwise show in the committed solver-cards figure.
      assignments: [{ conditionId: "surfacePressure", smpPath: "main_load_1", values: {} }],
      collections: {
        responses: [
          { name: "mass", type: "mass", parts: [], values: {} },
          { name: "strain_energy", type: "strainEnergy", parts: [], values: {} },
        ],
        controls: [{ name: "shape_control", type: "shape", parts: ["design_surface_1"], values: {} }],
        constraints: [{ name: "mass_limit", type: "limit", parts: [], values: { response: "mass", relation: "<=", refMode: "initial" } }],
      },
    });
    try {
      // Full window: Setup collections left, mesh right.
      await ptScroll(page, "#pt-collections");
      await shootFull(page, "problemtype-optimization.png");
      // Detail crop: the three setup collections alone.
      await shoot(page, "problemtype-optimization-setup.png", "#pt-collections");
      await expandProblemtypeCards(page, ["Optimization"]);
      await ptScroll(page, "Optimization");
      await shootFull(page, "problemtype-optimization-algorithm.png");

      // The staged case: the optimizer's own document names summary.csv.
      fs.cpSync(paramsSrc, path.join(caseDir, "optimization_parameters.json"));
      fs.cpSync(summarySrc, path.join(caseDir, "summary.csv"));
      await click(page, '[data-action="advanced"]');
      await click(page, '[data-action="optimizationProgress"]');
      await page.waitForSelector("#optimization-panel", { state: "visible", timeout: 20_000 });
      await sleep(1_500);
      // Panel docked left with the real objective/constraint charts; the
      // whole window for the mesh context (no element clip).
      await shootFull(page, "problemtype-optimization-progress.png");
    } finally { await close(); }
  }

  // 2 — ROM · Structural Mechanics over a young-modulus material parameter.
  {
    const { page, close } = await shotProblemtypeStage("opt-rom", "romStructural", {
      materials: [{ smpPath: "domain", lawId: "linear_elastic_3d", values: { YOUNG_MODULUS: 210000, DENSITY: 7850, POISSON_RATIO: 0.3 } }],
      collections: {
        parameters: [{ name: "young_modulus", type: "range", parts: [], values: { target: "material:domain/YOUNG_MODULUS", min: 150000, max: 250000 } }],
      },
    });
    try {
      await expandProblemtypeCards(page, ["Reduced-order model", "Sampling"]);
      await ptScroll(page, "Reduced-order model");
      await shootFull(page, "problemtype-rom.png");
      await shoot(page, "problemtype-rom-parameters.png", "#pt-collections");
    } finally { await close(); }
  }

  // 3 — Generic Coupling (CoSimulation): strong coupling options over the
  // hook's real boundary parts (the load face as the fluid side, the tip as
  // the structure side).
  {
    const { page, close } = await shotProblemtypeStage("opt-cosim", "cosim", {
      values: {
        coupling: {
          couplingType: "strong",
          numCouplingIterations: 10,
          absTolerance: 1e-5,
          relTolerance: 1e-5,
          accelerator: "mvqn",
          predictor: "linear",
          mapperType: "nearest_element",
          aleMesh: true,
          meshSolver: "structural_similarity",
        },
      },
      assignments: [
        { conditionId: "fluidInterface", smpPath: "main_load_1", values: {} },
        { conditionId: "structureInterface", smpPath: "tip_1", values: {} },
      ],
    });
    try {
      await ptScroll(page, "Coupling");
      await shootFull(page, "problemtype-coupling.png");
    } finally { await close(); }
  }
}

// ---- Session C: mesh mode on a VTK time series --------------------------------

async function sessionVtk() {
  const { app, output } = await launchApp(fixture("mesh/example/VTK/Main_0_6.vtk"), { extraArgs: EXTRA_ARGS, userDataDir: profileDir });
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
  const { app } = await launchApp(undefined, { extraArgs: EXTRA_ARGS, userDataDir: profileDir });
  const deadline = Date.now() + 60_000;
  try {
    const page = await appWindow(app, "/renderer/home/", deadline);
    await page.waitForSelector(".menu-btn", { timeout: 15_000 });
    // Park the pointer off the menu: the recents block shifts this centered
    // column upward, which otherwise leaves whichever button sits under the
    // default cursor position hover-highlighted in the committed PNG.
    await page.mouse.move(0, 0);
    await sleep(800);
    await shoot(page, "home-screen.png");

    // The Settings page, opened the way a user does (the same MenuItem.click()
    // handler as Ctrl+,), then a light-theme shot of the home screen driven
    // through it. The profile is this script's temp one, so nothing leaks.
    await app.evaluate(({ Menu }) => {
      const settings = Menu.getApplicationMenu().items.find((i) => i.label === "&Settings");
      settings.submenu.items.find((i) => i.label === "Open Settings…").click();
    });
    const settings = await appWindow(app, "/renderer/settings/", deadline);
    await settings.waitForSelector('.row[data-id="appearance.uiTheme"]', { timeout: 15_000 });
    await settings.mouse.move(0, 0);
    await sleep(600);
    await shoot(settings, "settings.png");
    await settings.selectOption('.row[data-id="appearance.uiTheme"] select', "light");
    await page.waitForFunction(() => document.body.classList.contains("vscode-light"), null, { timeout: 10_000 });
    await sleep(600);
    await shoot(page, "home-screen-light.png");
    await settings.selectOption('.row[data-id="appearance.uiTheme"] select', "dark");
  } finally {
    await closeApp(app);
  }
}

// A seeded local study exposes the actual quantity form without launching a solver.
async function sessionHomeWorkflow() {
  const project = path.join(profileDir, "Cantilever study");
  fs.mkdirSync(path.join(project, ".kkss"), { recursive: true });
  const profile = path.join(profileDir, "workflow-profile"); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "state.json"), JSON.stringify({ uiTheme: "dark", projectRoot: project }));
  fs.writeFileSync(path.join(project, ".kkss/project.json"), JSON.stringify({ version: 1, id: "docs", revision: 1,
    activeStudyId: "baseline", activeRunId: "example-run", queue: { paused: true, tasks: [] },
    studies: [{ id: "baseline", name: "Cantilever", source: { kind: "project", path: "beam.step", revision: "example" }, meshing: {}, caseSettings: {},
      runs: [{ id: "example-run", studyId: "baseline", directory: ".kkss/runs/example-run", state: "succeeded", artifacts: [] }] }] }));
  const { app } = await launchApp(undefined, { extraArgs: EXTRA_ARGS, userDataDir: profile });
  try {
    const page = await appWindow(app, "/renderer/home/", Date.now() + 60000);
    await page.locator("#study-evaluate-quantity:enabled").click();
    await page.locator("#workflow-input-unit").fill("m");
    await page.locator("#workflow-form-title").click();
    await page.mouse.move(0, 0);
    await shoot(page, "home-workflow-form.png");
    await page.locator("#workflow-form .btn-secondary").click();
    await page.locator("#workflow").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(250);
    await page.locator("#study-refinement:enabled").click();
    await page.locator("#workflow-form-title").click();
    await page.mouse.move(0, 0);
    await shoot(page, "home-refinement-form.png");
  } finally { await closeApp(app); }
}

if (process.argv.includes("--home-workflow-only")) {
  try { await sessionHomeWorkflow(); }
  finally { cleanupDirs(); }
  process.exit(0);
}
if (process.argv.includes("--problemtypes-only")) {
  try { await sessionProblemtypes(); }
  finally { cleanupDirs(); }
  process.exit(0);
}
if (process.argv.includes("--animations-only")) {
  try { await captureAnimations(OUT); }
  finally { cleanupDirs(); }
  process.exit(0);
}
const meshOnly = process.argv.includes("--mesh-only");
// `--cad-only`: the CAD session alone, symmetric with `--mesh-only`. A cad bump
// moves the viewer's chrome (panels, menus, overlays), so the pre-processing
// captures and the `pre_processing.png` hero have to be regenerated without
// paying for the tutorial/solver half of the pipeline.
if (process.argv.includes("--cad-only")) {
  try { await sessionCad(); }
  finally { cleanupDirs(); }
  fs.copyFileSync(path.join(OUT, "cad-viewer.png"), path.join(IMAGES, "pre_processing.png"));
  console.log("hero pre_processing.png ← cad-viewer.png");
  console.log("done");
  process.exit(0);
}
if (process.argv.includes("--plots-only")) {
  try { await meshPlotsScenario(OUT); }
  finally { cleanupDirs(); }
  process.exit(0);
}
if (process.argv.includes("--optimization-run-only")) {
  try { await optimizationRunScenario(OUT); }
  finally { cleanupDirs(); }
  process.exit(0);
}
if (!meshOnly) await sessionCad();
await sessionMdpa();
await sessionVtk();
await sessionProperties();
await sessionProblemtypes();
// Verified new mesh panels, using deterministic files and their real hosts.
await mesh423Scenario(OUT);
await meshPlotsScenario(OUT);
// A REAL Structural-Optimization run (Generate ▸ Run case with the pinned
// Kratos runtime) — skipped with a warning wherever its runtime is absent.
await optimizationRunScenario(OUT);
// Last, so its recents list contains the documents the sessions above opened.
if (!meshOnly) {
  await sessionHome();
  await sessionHomeWorkflow();
  await kratosStartupScenario(path.join(OUT, "chat-kratos-setup.png"));
  await jobsScenario(path.join(OUT, "kratos-jobs.png"));
  // These captures use the real CAD/mesh app, the configured manual Python
  // interpreter and actual solver-produced tutorial results. The companion uses
  // a local OpenAI-compatible fixture but routes every tool call through KKSS.
  await manualTutorials(OUT);
  // Timeline GIFs from the committed fluid solver output (no solver run).
  await captureAnimations(OUT);
  await scriptedCapture(OUT);
}

// ---- README hero refresh (same pattern as cad's capture.mjs tail) -------------

for (const [src, dst] of [
  ["cad-viewer.png", "pre_processing.png"],
  ["mesh-viewer.png", "post_processing.png"],
]) {
  if (meshOnly && src.startsWith("cad-")) continue;
  fs.copyFileSync(path.join(OUT, src), path.join(IMAGES, dst));
  console.log(`hero ${dst} ← ${src}`);
}

cleanupDirs();

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):\n  ${warnings.join("\n  ")}`);
}
console.log("done");
