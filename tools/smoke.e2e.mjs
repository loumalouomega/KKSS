/**
 * End-to-end smoke test: launches the real Electron app (dev layout, out/)
 * twice — once per mode — and asserts the full host↔webview protocol
 * handshakes complete against real example files from the submodules.
 *
 *   1. cad:  bull.stp  → status → geometry + tree (OCCT worker round-trip)
 *   2. mesh: *.mdpa    → model + opState (reused MdpaEditorProvider)
 *   3. mesh: Main_0_6.vtk → vtkGroup + vtkFrame (timeline discovery)
 *
 * Runs under xvfb in CI: xvfb-run -a node tools/smoke.e2e.mjs
 */
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron"); // resolves to the binary path in Node context
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox", c.file],
    cwd: root,
    env: { ...process.env, KKSS_E2E: "1", ELECTRON_RUN_AS_NODE: undefined },
    timeout: 60_000,
  });

  let stdout = "";
  app.process().stdout?.on("data", (d) => (stdout += d.toString()));
  app.process().stderr?.on("data", (d) => (stdout += d.toString()));

  const deadline = Date.now() + c.timeoutMs;
  try {
    // 1. Protocol handshake visible on the KKSS_E2E message trace.
    for (const marker of c.expect) {
      while (!stdout.includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for "${marker}".\n--- captured output ---\n${stdout}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    // 2. The mode's webview page is live and shows its viewer DOM.
    const page = await appWindow(app, c.windowUrl, deadline);
    await page.waitForSelector("#app", { state: "attached", timeout: 15_000 });

    console.log(`PASS ${c.name}`);
  } finally {
    await app.close().catch(() => {});
  }
}

async function appWindow(app, urlPart, deadline) {
  for (;;) {
    for (const page of app.windows()) {
      if (page.url().includes(urlPart)) return page;
    }
    if (Date.now() > deadline) {
      const urls = app.windows().map((w) => w.url());
      throw new Error(`No window matching "${urlPart}". Windows: ${urls.join(", ")}`);
    }
    await new Promise((r) => setTimeout(r, 250));
    // waitForEvent would race with windows that already exist; polling is fine here.
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
