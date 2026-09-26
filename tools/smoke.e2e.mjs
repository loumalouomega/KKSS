/**
 * End-to-end smoke test: launches the real Electron app (dev layout, out/)
 * once per case and asserts the full host↔webview protocol handshakes
 * complete against real example files from the submodules.
 *
 *   1. cad:  bull.stp  → status → geometry + tree (OCCT worker round-trip)
 *   2. mesh: *.mdpa    → model + opState (reused MdpaEditorProvider)
 *   3. mesh: Main_0_6.vtk → vtkGroup + vtkFrame (timeline discovery)
 *
 * Runs under xvfb in CI: xvfb-run -a node tools/smoke.e2e.mjs
 */
import { launchApp, waitForMarkers, appWindow, closeApp, diagnostics } from "./e2eShared.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Headless CI runners have no real GPU. Left to auto-pick, Chromium crashes the
// mesh viewer's vtk.js renderer mid-frame — the GPU compositor fails to allocate
// shared memory ("Creation of StagingBuffer's SharedImage failed") and the driver
// stalls on ReadPixels — blanking the mesh window after the model loads, so the
// mesh smoke cases fail with "No window matching /renderer/mesh/" even though the
// host↔webview handshake completed. Force a fully software path:
//   --use-gl=angle --use-angle=swiftshader  → software WebGL for vtk.js
//   --disable-gpu-compositing               → software compositor (no GPU
//                                             SharedImages — the failing alloc)
//   --disable-dev-shm-usage                 → /tmp instead of the small /dev/shm
// Scoped to the smoke test only; screenshots keep hardware rendering for quality.
const SOFTWARE_GL = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--disable-gpu-compositing",
  "--disable-dev-shm-usage",
];

const DEAD_RENDERER_GRACE_MS = 15_000;

const CASES = [
  {
    name: "cad STEP (OCCT worker)",
    file: "cad/examples/STP/bull.stp",
    expect: ["[cad] host → webview: geometry", "[cad] host → webview: tree"],
    windowUrl: "/renderer/cad/",
    // CI run 32000629986: on a CPU-starved runner the app finished its full
    // handshake (every expected marker showed up in stdout) inside all three
    // 90s attempts, but Playwright's own electron.launch() handshake — a
    // separate Node-inspector/CDP connection racing the OCCT worker thread
    // and the swiftshader GPU process for the same 2-3 cores — never
    // resolved in time. More headroom here lets the first attempt land
    // instead of burning 3x90s of contention that then starves the mesh
    // cases that follow.
    timeoutMs: 150_000,
  },
  {
    name: "mesh MDPA (reused provider)",
    file: "mesh/example/MDPA/double_arch.mdpa",
    expect: ["[mesh] host → webview: model", "[mesh] host → webview: opState"],
    windowUrl: "/renderer/mesh/",
    timeoutMs: 60_000,
  },
  {
    name: "mesh VTK timeline",
    file: "mesh/example/VTK/Main_0_6.vtk",
    expect: ["[mesh] host → webview: vtkGroup", "[mesh] host → webview: vtkFrame"],
    windowUrl: "/renderer/mesh/",
    timeoutMs: 60_000,
  },
];

async function attempt(c) {
  // Playwright's own launch() wait must cover at least the case's inner
  // deadline below — otherwise a slow-booting case (e.g. cad's heavier
  // OCCT+WebGL startup) can hit Playwright's launch timeout before its own
  // waitForMarkers/appWindow deadline ever gets a chance to apply.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-smoke-case-"));
  const fixtureDir = path.join(workspace, "files");
  let app;
  let output = () => "";
  try {
    fs.cpSync(path.dirname(c.file), fixtureDir, { recursive: true });
    const launched = await launchApp(path.join(fixtureDir, path.basename(c.file)), {
      extraArgs: SOFTWARE_GL,
      timeout: c.timeoutMs,
      userDataDir: path.join(workspace, "profile"),
    });
    ({ app, output } = launched);
    const deadline = Date.now() + c.timeoutMs;
    // 1. Grab the mode's webview page and assert its viewer DOM mounts *as the
    //    view loads* — before the host pushes the model and vtk.js starts the
    //    GPU render. Headless CI runners have no real GPU, so that render can
    //    still crash the mesh renderer mid-frame even with software rendering
    //    forced (the window blanks). We verify the integration — routing, HTML
    //    generation, shim + bundle load — not that a broken CI GPU survives a
    //    full render (real hardware does; the doc screenshots prove it).
    const page = await appWindow(app, c.windowUrl, deadline, { deadGraceMs: DEAD_RENDERER_GRACE_MS });
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });

    // 2. Protocol handshake on the KKSS_E2E trace. These are host→webview *sends*,
    //    logged before the webview renders, so they land even if the render later
    //    crashes — and the host only sends them after the webview posts `ready`,
    //    which itself follows the DOM mount above.
    await waitForMarkers(output, c.expect, deadline);
    // Opening a mesh used to leave the menu built for the previous CAD mode.
    // Check both the initial file-open path and explicit mode switches.
    await app.evaluate(({ Menu }, isMesh) => {
      const find = (label, menu = Menu.getApplicationMenu()) => {
        for (const item of menu.items) {
          if (item.label === label) return item;
          if (item.submenu) {
            const found = find(label, item.submenu);
            if (found) return found;
          }
        }
      };
      const check = (enabled) => {
        if (find("Pack Time Series Into One File…")?.enabled !== enabled) {
          throw new Error(`Packing menu enabled state should be ${enabled}`);
        }
      };
      check(isMesh);
      find("Pre-Processing (CAD)").click();
      check(false);
      find("Post-Processing (Mesh)").click();
      check(true);
    }, c.windowUrl === "/renderer/mesh/");

    // Settings ▸ UI Theme reaches every view live: the viewers only follow it
    // through VS Code's body classes, so assert the class on the viewer page
    // itself, then that the Settings page opens and renders its schema.
    await app.evaluate(({ Menu }) => {
      const settings = Menu.getApplicationMenu().items.find((i) => i.label === "&Settings");
      const theme = settings.submenu.items.find((i) => i.label === "UI Theme");
      theme.submenu.items.find((i) => i.label === "Light").click();
      settings.submenu.items.find((i) => i.label === "Open Settings…").click();
    });
    await page.waitForFunction(() => document.body.classList.contains("vscode-light"), null, { timeout: 10_000 });
    const settingsPage = await appWindow(app, "/renderer/settings/", deadline);
    await settingsPage.waitForSelector('.row[data-id="appearance.uiTheme"]', { timeout: 15_000 });
    const theme = await settingsPage.$eval('.row[data-id="appearance.uiTheme"] select', (s) => s.value);
    if (theme !== "light") throw new Error(`Settings page shows UI theme "${theme}", expected "light"`);
  } catch (error) {
    await diagnostics(app, output, c.name).catch(() => {});
    throw error;
  } finally {
    if (app) await closeApp(app).catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function runCase(c) {
  await attempt(c);
  console.log(`PASS ${c.name}`);
}

let failed = false;
for (const c of CASES) {
  try {
    await runCase(c);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${c.name}\n${err instanceof Error ? err.message : err}`);
  }
}

// Exercise the visible Home workflow through its real IPC path. The environment
// is intentionally not configured: the check must still render an actionable
// report, and creating an optional study must not require a solver install.
const workflowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-home-workflow-"));
const workflowProfile = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-home-profile-"));
let workflowApp;
let workflowOutput = () => "";
let workflowStage = "setup";
try {
  const geometry = path.join(workflowRoot, "beam.step");
  fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cad/examples/STP/block.stp"), geometry);
  fs.writeFileSync(path.join(workflowProfile, "state.json"), JSON.stringify({ uiTheme: "dark", projectRoot: workflowRoot }));
  workflowStage = "launch Home";
  const launched = await launchApp(undefined, { userDataDir: workflowProfile, timeout: 90_000 });
  workflowApp = launched.app;
  workflowOutput = launched.output;
  const page = await appWindow(workflowApp, "/renderer/home/", Date.now() + 90_000);
  workflowStage = "show the workflow section";
  await page.waitForSelector("#workflow:not([hidden])", { timeout: 15_000 });
  workflowStage = "create a study from Home";
  await page.click("#study-create");
  await page.fill("#workflow-input-source", geometry);
  await page.fill("#workflow-input-name", "Smoke-test study");
  await page.click("#workflow-form button[type=submit]");
  workflowStage = "render study readiness";
  try {
    await page.waitForFunction(() => document.querySelector("#study-picker").options.length === 1, null, { timeout: 15_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      projectRoot: document.querySelector("#project-root-path").textContent,
      workflowError: document.querySelector("#workflow-error").textContent,
      studyCreateDisabled: document.querySelector("#study-create").disabled,
      body: document.body.innerText.slice(0, 1200),
    }));
    throw new Error(`${error instanceof Error ? error.message : error}\n${JSON.stringify(state)}`);
  }
  const readiness = await page.$eval("#study-readiness", element => element.textContent);
  if (!readiness?.includes("geometry: ready") || !readiness.includes("mesh: missing")) {
    throw new Error(`Unexpected Home study readiness: ${readiness}`);
  }
  workflowStage = "check the simulation environment from Home";
  await page.click("#workflow-check");
  await page.waitForFunction(() => document.querySelector("#environment-report").textContent.includes("Manual runs:"), null, { timeout: 45_000 });
  if (!fs.existsSync(path.join(workflowRoot, ".kkss", "project.json"))) throw new Error("Home did not persist the optional study metadata.");
  console.log("PASS Home workflow (study creation, readiness and environment check)");
} catch (err) {
  failed = true;
  await diagnostics(workflowApp, workflowOutput, "home-workflow").catch(() => {});
  console.error(`FAIL Home workflow (${workflowStage})\n${err instanceof Error ? err.message : err}\n${workflowOutput()}`);
} finally {
  if (workflowApp) await closeApp(workflowApp);
  fs.rmSync(workflowRoot, { recursive: true, force: true });
  fs.rmSync(workflowProfile, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
