/**
 * Live check of the VTK-wasm renderer path (mesh 4.8.0's
 * `kratos.preview.renderer`), driven through the real app:
 *
 *   1. vtk.js (the default) — the served mesh page carries NO renderer
 *      attribute, no CSP widening, and vtk.js draws (no #vtk-wasm-canvas);
 *   2. VTK-wasm — the served page carries data-renderer + the base URI and
 *      the one CSP token, and the scene really is drawn by VTK
 *      (#vtk-wasm-canvas exists);
 *   3. VTK-wasm asked for, runtime absent — the page falls back to vtk.js and
 *      announces the reason (data-renderer-fallback), so an installation
 *      without the runtime still works.
 *
 * Not part of npm test / npm run e2e: case 2 needs WebAssembly JSPI, which a
 * headless CI Chromium may not have, and case 3 needs a bundle without the
 * runtime. Run it by hand on a desktop session:
 *
 *   node tools/renderer-probe.mjs
 */
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(root, "mesh/example/MDPA/double_arch.mdpa");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** The renderer decision the app's mesh page was actually served with. */
const probe = (page) =>
  page.evaluate(() => ({
    renderer: document.body.dataset.renderer ?? null,
    base: document.body.dataset.vtkWasmBase ?? null,
    fallback: document.body.dataset.rendererFallback ?? null,
    csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? "",
    wasmCanvas: !!document.getElementById("vtk-wasm-canvas"),
    // vtk.js mounts its own canvas; either way a rendered scene has one.
    anyCanvas: document.querySelectorAll("#render-root canvas").length,
  }));

/**
 * The View ▸ 3D Renderer radio, read off the real menu. This is the only
 * place the "unavailable in this build" note can be checked: it depends on the
 * runtime being absent, which no CI build is.
 */
const probeMenu = (app) =>
  app.evaluate(({ Menu }) => {
    const find = (label, menu = Menu.getApplicationMenu()) => {
      for (const item of menu.items) {
        if (item.label === label) return item;
        if (item.submenu) {
          const found = find(label, item.submenu);
          if (found) return found;
        }
      }
    };
    const item = find("3D Renderer");
    return item
      ? { enabled: item.enabled, options: item.submenu.items.map((o) => ({ label: o.label, enabled: o.enabled })) }
      : null;
  });

async function run(name, stored, { hideRuntime = false } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-renderer-probe-"));
  fs.writeFileSync(
    path.join(userDataDir, "state.json"),
    JSON.stringify({ uiTheme: "dark", "kratos.preview.renderer": stored })
  );
  const runtime = path.join(root, "out", "renderer", "mesh", "vtk-wasm");
  const stash = `${runtime}.stashed`;
  if (hideRuntime && fs.existsSync(runtime)) fs.renameSync(runtime, stash);
  let app;
  try {
    app = await _electron.launch({
      executablePath: electronPath,
      args: [
        ".",
        "--no-sandbox",
        "--enable-unsafe-swiftshader",
        "--disable-gpu-sandbox",
        `--user-data-dir=${userDataDir}`,
        file,
      ],
      cwd: root,
      env: { ...process.env, KKSS_E2E: "1", KKSS_ALLOW_MULTIPLE_INSTANCES: "1", ELECTRON_RUN_AS_NODE: undefined },
    });
    const page = await app
      .firstWindow({ timeout: 60_000 })
      .then(async (first) => {
        // The mesh view is a second window; wait for it to exist.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const pages = app.windows();
          const mesh = pages.find((p) => p.url().includes("/renderer/mesh/"));
          if (mesh) return mesh;
          await new Promise((r) => setTimeout(r, 250));
        }
        void first;
        throw new Error("no mesh window appeared");
      });
    // Wait for a rendered scene. VTK-wasm boots asynchronously at the end of
    // the webview module (it races a 60 s timeout upstream), and vtk.js creates
    // its canvas on the first model rather than at load — so "no canvas yet"
    // means nothing on its own.
    const deadline = Date.now() + 90_000;
    let state = await probe(page);
    while (Date.now() < deadline && !state.wasmCanvas && !state.anyCanvas) {
      await new Promise((r) => setTimeout(r, 500));
      state = await probe(page);
    }
    check(`${name}: served with the expected attributes`, true, JSON.stringify(state));
    return { ...state, menu: await probeMenu(app) };
  } finally {
    await app?.close().catch(() => {});
    if (hideRuntime && fs.existsSync(stash)) fs.renameSync(stash, runtime);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

const jspi = await (async () => {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const page = await app.firstWindow();
  const ok = await page.evaluate(() => typeof WebAssembly.Suspending === "function");
  await app.close();
  return ok;
})();
console.log(`host: WebAssembly.Suspending (JSPI) ${jspi ? "available" : "MISSING"}`);

const base = await run("vtk.js (default)", "vtkjs");
check("vtk.js: page carries no renderer attribute", base.renderer === null, String(base.renderer));
check("vtk.js: CSP is not widened", !base.csp.includes("wasm-unsafe-eval"));
check("vtk.js: drawn by vtk.js", !base.wasmCanvas && base.anyCanvas > 0, `${base.anyCanvas} canvas(es)`);
// View ▸ 3D Renderer: present, mesh-only, both options offered, vtk.js checked.
check("menu: 3D Renderer is offered in Post-Processing", base.menu?.enabled === true);
check(
  "menu: both options enabled while the runtime is installed",
  base.menu?.options.every((o) => o.enabled) && base.menu.options.length === 2,
  JSON.stringify(base.menu?.options),
);
check(
  "menu: vtk.js is the checked default",
  base.menu?.options[0].label === "vtk.js (default)",
  base.menu?.options[0]?.label,
);

if (jspi) {
  const wasm = await run("VTK-wasm", "vtkwasm");
  check("VTK-wasm: page asks for the backend", wasm.renderer === "vtkwasm", String(wasm.renderer));
  check("VTK-wasm: base URI points at the runtime", wasm.base === "./vtk-wasm", String(wasm.base));
  check("VTK-wasm: CSP widened by exactly one token", wasm.csp.includes("script-src kkss: 'wasm-unsafe-eval'") && !wasm.csp.includes("'unsafe-eval'"));
  check("VTK-wasm: scene drawn by VTK", wasm.wasmCanvas, wasm.wasmCanvas ? "" : "no #vtk-wasm-canvas (boot fell back)");
} else {
  console.log("SKIP VTK-wasm: this host has no WebAssembly JSPI, so the runtime cannot start here");
}

const missing = await run("VTK-wasm without the runtime", "vtkwasm", { hideRuntime: true });
check("missing runtime: falls back to vtk.js", missing.renderer === null, String(missing.renderer));
check("missing runtime: says why", missing.fallback === "assets-missing", String(missing.fallback));
check("missing runtime: still drawn", missing.anyCanvas > 0);
// The menu must say the same thing BEFORE the user picks it: in a build
// without the runtime, VTK-wasm is the one option that cannot work.
const wasmOption = missing.menu?.options.find((o) => o.label.startsWith("VTK-wasm"));
check("missing runtime: menu disables VTK-wasm", wasmOption?.enabled === false, wasmOption?.label);
check(
  "missing runtime: menu explains why",
  (wasmOption?.label ?? "").includes("unavailable in this build"),
  wasmOption?.label,
);
check("missing runtime: vtk.js still selectable", missing.menu?.options[0].enabled === true);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
