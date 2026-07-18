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
import { launchApp, waitForMarkers, appWindow } from "./e2eShared.mjs";

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

/**
 * Software rendering in CI is occasionally still flaky — the mesh view's
 * renderer can die on load (its window then reports a bogus URL like ":").
 * Each attempt is a fresh launch; the dead-renderer fast-fail in appWindow
 * keeps failed attempts cheap, so allow two clean retries.
 */
const ATTEMPTS = 3;
const DEAD_RENDERER_GRACE_MS = 15_000;

const CASES = [
  {
    name: "cad STEP (OCCT worker)",
    file: "cad/examples/STP/bull.stp",
    expect: ["[cad] host → webview: geometry", "[cad] host → webview: tree"],
    windowUrl: "/renderer/cad/",
    timeoutMs: 90_000,
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
  const { app, output } = await launchApp(c.file, { extraArgs: SOFTWARE_GL, timeout: c.timeoutMs });
  const deadline = Date.now() + c.timeoutMs;
  try {
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
  } finally {
    await app.close().catch(() => {});
  }
}

async function runCase(c) {
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      await attempt(c);
      console.log(`PASS ${c.name}${i > 1 ? ` (attempt ${i})` : ""}`);
      return;
    } catch (err) {
      if (i === ATTEMPTS) throw err;
      console.error(`retry ${c.name} (attempt ${i} failed: ${err instanceof Error ? err.message : err})`);
    }
  }
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
process.exit(failed ? 1 : 0);
