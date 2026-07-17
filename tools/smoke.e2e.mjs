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

// Force a deterministic *software* WebGL backend (ANGLE over SwiftShader) for the
// mesh viewer's vtk.js. Headless CI runners have no real GPU; left to auto-pick,
// Chromium lands on an unstable driver path (llvmpipe) that crashes the mesh
// renderer mid-frame ("StagingBuffer's SharedImage failed" / "GPU stall due to
// ReadPixels"), blanking the window after the model loads. SwiftShader is slower
// but reliable everywhere — the smoke test only needs "renders without crashing".
const SOFTWARE_GL = ["--use-gl=angle", "--use-angle=swiftshader"];

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

async function runCase(c) {
  const { app, output } = await launchApp(c.file, { extraArgs: SOFTWARE_GL });
  const deadline = Date.now() + c.timeoutMs;
  try {
    // 1. Protocol handshake visible on the KKSS_E2E message trace.
    await waitForMarkers(output, c.expect, deadline);

    // 2. The mode's webview page is live and shows its viewer DOM.
    const page = await appWindow(app, c.windowUrl, deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });

    console.log(`PASS ${c.name}`);
  } finally {
    await app.close().catch(() => {});
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
