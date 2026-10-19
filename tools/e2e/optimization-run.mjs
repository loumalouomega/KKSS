/**
 * A REAL Structural-Optimization run through the real KKSS app, producing the
 * figures for doc/guide/problemtypes.md's "follow the run" section.
 *
 * OptimizationApplication's own 3D-hook case (https://github.com/KratosMultiphysics/Examples/blob/master) is staged with a
 * `<stem>.kratoscase.json` seeded to mirror upstream's implicit-vertex-morphing
 * formulation as the built-in Structural Optimization problemtype expresses it:
 * objective mass, one strain-energy constraint ≤ initial value, a
 * vertex-morphing shape control on the hook's design_surface_1 (implicit
 * filter, radius 25 mm, filter-based mesh motion, damped non-design parts),
 * steel in the hook's units (N/mm, ton/mm³ — YOUNG 206900, ν 0.29, ρ 7.85e-05,
 * from the example's own materials_3D.json), and 5 iterations.
 *
 * The app runs it with the venv at `KKSS_OPTIMIZATION_PYTHON` (default
 * node_modules/.cache/kkss-optimization/runtime — `pip install "KratosMultiphysics==10.4.4"
 * "KratosStructuralMechanicsApplication==10.4.4" "KratosMappingApplication==10.4.4"
 * "KratosMeshMovingApplication==10.4.4" "KratosConstitutiveLawsApplication==10.4.4"
 * "KratosOptimizationApplication==10.4.4"`), through Generate ▸ Run case in the
 * Problemtype sidebar (the user flow, including KKSS's pre-run application
 * probe). Every capture below is read from THAT run; nothing is fabricated, and
 * a missing runtime skips the scenario with a warning so the committed figures
 * stay the previous real run's.
 *
 * Figures into the docs' screenshot root:
 *   problemtype-optimization-progress.png        — panel over the real summary (verdict: finished)
 *   problemtype-optimization-design-fields.png   — hook, design-fields timeline
 *   problemtype-optimization-evolution.gif       — the shape morphing per iteration
 *
 *   env -u ELECTRON_RUN_AS_NODE npm run docs:screenshots -- --optimization-run-only
 *
 * Capture iterations must not pay the ~35-minute solve again: point
 * `KKSS_OPTIMIZATION_RUN_REUSE` at a previous run's staged `case` directory and
 * the scenario replays only the panel/design-fields/GIF captures over it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { launchApp, appWindow, waitForMarkers, closeApp, diagnostics, sleep, root, until } from "../e2eShared.mjs";
import { encodeGif } from "../lib/gif.mjs";

/** Every GIF must stay under this, so doc/public does not balloon (shared budget). */
export const GIF_BUDGET_BYTES = 1_500_000;
const WIDTH = 1200;
const MESH_URL = "/renderer/mesh/";

const optimizationPython = process.env.KKSS_OPTIMIZATION_PYTHON
  ?? path.join(root, "node_modules", ".cache", "kkss-optimization", "runtime", "bin", "python");
const hookSource = path.join(os.homedir(), "src", "Examples", "optimization_application", "use_cases", "3d_hook");

/** The design-fields viewer: the mesh window that is NOT the hook window that
 *  opened it. Its document chip is the `.vtm` series, and only the series
 *  viewer builds the timeline — a chip match on the case name would return the
 *  original window (chip "hook.mdpa"), which has neither. */
async function designFieldsPage(app, deadline, excluded) {
  for (;;) {
    if (Date.now() > deadline) throw new Error("No design-fields viewer appeared");
    for (const page of app.windows().filter((p) => p.url().includes(MESH_URL))) {
      if (page === excluded) continue;
      try {
        const chip = await page.evaluate(() => document.querySelector("#doc-chip-name")?.textContent ?? "");
        if (chip.includes(".vtm") && await page.locator("#tl-scrub").count()) return page;
      } catch { /* page mid-navigation */ }
    }
    await sleep(500);
  }
}

async function waitForGenerated(stage, deadline) {  const names = ["optimization_parameters.json", "primal_parameters.json", "MainKratosOpt.py"];
  for (;;) {
    if (Date.now() > deadline) throw new Error("Generate did not produce the case inputs");
    if (names.every((n) => fs.existsSync(path.join(stage, n)))) return;
    await sleep(500);
  }
}

/** The run sidecar `<stem>.kratosrun.json` reaches a terminal state: done when
 *  the process exited 0; a nonzero exit (or an invalid driver) fails loudly.
 *  A non-live status (`orphaned`/`detached`/`cancelled`/`failed`) fails fast —
 *  waiting out a dead run only produces the same answer an hour later. The
 *  sidecar's status is authoritative; the app marks a run orphaned when the
 *  mesh view was closed or reloaded while it ran (windowCloseAction). */
const DEAD_SIDECAR_STATUSES = ["orphaned", "detached", "cancelled", "failed"];
async function waitForRun(stage, deadline) {
  const sidecar = path.join(stage, "hook.kratosrun.json");
  for (;;) {
    if (Date.now() > deadline) throw new Error("The optimization run did not finish in time");
    try {
      const run = JSON.parse(fs.readFileSync(sidecar, "utf8"));
      if (typeof run.status === "string" && DEAD_SIDECAR_STATUSES.includes(run.status) && run.exitCode === null) {
        throw new Error(
          `The optimization run was marked ${run.status} before finishing`
          + (run.message ? `: ${run.message}` : " — the mesh view closed or reloaded while it ran."));
      }
      if (typeof run.exitCode !== "number") { /* still running */ }
      else if (run.exitCode !== 0) {
        const log = fs.existsSync(path.join(stage, "hook.kratosrun.log"))
          ? fs.readFileSync(path.join(stage, "hook.kratosrun.log"), "utf8").slice(-2_000)
          : "";
        throw new Error(`The optimization run failed (exit ${run.exitCode}).\n${log}`);
      } else {
        return run;
      }
    } catch (err) {
      // Retry only while the sidecar is absent or being (re)written.  Anything
      // else — including a typo inside the try — must surface, not spin until
      // the deadline.
      if (err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
    }
    await sleep(5_000);
  }
}

const nextPaint = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Capture only the 3D canvas: hide the floating chrome while shooting. */
const CHROME = ["#toolbar", "#nav-controls", "#menubar"];
const setChrome = (page, hidden) => page.evaluate(([ids, h]) => ids.forEach((id) => {
  const el = document.querySelector(id);
  if (el) el.style.visibility = h ? "hidden" : "";
}), [CHROME, hidden]);

export async function optimizationRunScenario(out) {
  if (!fs.existsSync(optimizationPython)) {
    console.warn(`optimization-run: runtime ${optimizationPython} missing — skipping (the committed figures keep the previous real run)`);
    return;
  }
  if (!fs.existsSync(path.join(hookSource, "hook.mdpa"))) {
    console.warn("optimization-run: the 3D hook example is missing — skipping");
    return;
  }

  // Capture iterations replay over an existing staged run instead of paying the
  // ~35-minute solve again: KKSS_OPTIMIZATION_RUN_REUSE names a previous run's
  // `case` directory (its finished sidecar and Optimization_Results are reused).
  const reuse = process.env.KKSS_OPTIMIZATION_RUN_REUSE;
  const stageRoot = reuse ? path.dirname(path.resolve(reuse)) : fs.mkdtempSync(path.join(os.tmpdir(), "kkss-opt-run-"));
  const stage = reuse ? path.resolve(reuse) : path.join(stageRoot, "case");
  if (reuse && !fs.existsSync(path.join(stage, "hook.kratosrun.json"))) {
    throw new Error(`KKSS_OPTIMIZATION_RUN_REUSE=${stage} does not hold a staged run`);
  }
  if (!reuse) {
    fs.mkdirSync(stage);
    fs.cpSync(path.join(hookSource, "hook.mdpa"), path.join(stage, "hook.mdpa"));
  }
  // The seeded case: the hook's own shape study, as the built-in problemtype
  // expresses it (see the file's header for the upstream mapping).
  const caseState = {
    version: 1,
    problemtypeId: "optimization",
    values: {
      algorithm: {
        // Unconstrained compliance minimization: the constraint_conv_criterion
        // counts an unviolated constraint as satisfied at the initial point and
        // would stop the run there (observed), while the max-iterations
        // criterion runs every iteration and morphs the shape visibly.
        algorithmType: "algorithm_steepest_descent",
        objectiveResponse: "strain_energy",
        maxIter: 5,
        // mm-scale shape steps: the problemtype default (0.01) is well below a
        // cell at the hook's units and would morph nothing.
        lsType: "const_step", initStep: 3.0,
      },
    },
    assignments: [
      { conditionId: "parts", smpPath: "domain", values: {} },
      { conditionId: "displacement", smpPath: "support_horizontal_1", values: {} },
      { conditionId: "displacement", smpPath: "support_vertical_1", values: {} },
      { conditionId: "surfacePressure", smpPath: "main_load_1", values: { value: 10 } },
    ],
    materials: [{
      smpPath: "domain", lawId: "linear_elastic_3d",
      values: { YOUNG_MODULUS: 206900, DENSITY: 7.85e-05, POISSON_RATIO: 0.29 },
    }],
    output: { format: "binary", controlType: "step", interval: 1, nodalVariables: [] },
    collections: {
      responses: [
        { name: "mass", type: "mass", parts: [], values: {} },
        { name: "strain_energy", type: "strainEnergy", parts: [], values: {} },
      ],
      controls: [{
        name: "shape_control", type: "shape", parts: ["design_surface_1"],
        values: {
          filterType: "implicit_filter", filterRadius: 25,
          meshMotion: "filter_based",
          dampedParts: ["non_design_inner_1", "non_design_top_1", "tip_1"],
        },
      }],
    },
  };
  fs.writeFileSync(path.join(stage, "hook.kratoscase.json"), JSON.stringify(caseState, null, 2));

  // Dedicated profile: Kratos interpreter pinned to the venv, OMP threads
  // bounded like the tutorials; everything else factory defaults.
  const profile = path.join(stageRoot, "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "state.json"), JSON.stringify({
    uiTheme: "dark",
    "kratos.pythonPath": optimizationPython,
    "kratos.extraEnv": { OMP_NUM_THREADS: "8" },
  }));

  const { app, output } = await launchApp(path.join(stage, "hook.mdpa"), {
    extraArgs: ["--force-device-scale-factor=2", "--disable-gpu"],
    userDataDir: profile,
  });
  const deadline = Date.now() + 75 * 60_000;
  try {
    await waitForMarkers(output, ["[mesh] host → webview: model"], deadline);
    const page = await appWindow(app, MESH_URL, deadline);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#app")).display !== "none", null, { timeout: 90_000 });
    await page.waitForSelector("#pt-select", { state: "visible", timeout: 30_000 });
    await sleep(2_000); // scene settle (a 10 MB tetra mesh) before touching the sidebar

    // Resolution + renderer stability: this long session and its captures run
    // under the same enlarged frame as the problemtype session (2200 × 1900
    // CSS at the shared 2× device scale — ~4400 × 3800 PNGs), which proved far
    // steadier under software GL than the default window during a live solve.
    await app.evaluate(({ BaseWindow }, size) => {
      const win = BaseWindow.getAllWindows()[0];
      if (win) win.setContentSize(size.width, size.height);
    }, { width: 2200, height: 1900 });
    await sleep(1_000);

    // ---- The user flow: generate, then run --------------------------------
    if (!reuse) {
      await page.selectOption("#pt-select", "optimization");
      await page.waitForFunction(() => document.querySelectorAll("#pt-collections .pt-card, #pt-forms .pt-card").length > 0, null, { timeout: 30_000 });
      await sleep(1_500);
      await page.locator("#pt-generate").click();
      await waitForGenerated(stage, Date.now() + 300_000);
      await page.locator("#pt-run:enabled").click({ timeout: 120_000 });
      // Each iteration is a primal solve plus a gradient pass — ~5–6 minutes
      // each on the streaming host (measured), so the full five-iteration run
      // takes ~half an hour. Wait it out; the sidecar's terminal state is what
      // says the optimizer finalized (and that its summary holds every row).
      await waitForRun(stage, deadline);
    }

    // ---- Progress panel over the REAL completed run -------------------------
    await page.locator('[data-action="advanced"]').click();
    await page.locator('[data-action="optimizationProgress"]').click();
    // The action toggles. A reused profile can restore the panel open (view
    // state is saved per document), in which case the click above closed it —
    // so make opening idempotent instead of assuming it was hidden.
    if (!await page.locator("#optimization-panel").isVisible()) {
      await page.locator('[data-action="advanced"]').click();
      await page.locator('[data-action="optimizationProgress"]').click();
    }
    await page.waitForSelector("#optimization-panel", { state: "visible", timeout: 30_000 });
    await page.locator("#optimization-panel button.panel-btn", { hasText: "Refresh" }).click();
    await until(async () => (await page.locator(".opt-verdict").textContent()).includes("finished"), "the panel reads the finished run", 60_000);
    await sleep(1_500);
    await page.mouse.move(0, 0); await sleep(300);
    // A live GL canvas can hold the compositor past Playwright's 30 s default.
    await page.screenshot({ path: path.join(out, "problemtype-optimization-progress.png"), timeout: 180_000 });

    // ---- Design fields: the per-iteration timeline -------------------------
    await page.locator("#optimization-panel button.panel-btn", { hasText: "Design fields" }).click();
    await until(async () => output().includes("[mesh] host → webview: vtkGroup"), "the design-fields timeline posts", 240_000);
    await sleep(4_000);
    // The series viewer is a NEW mesh window (document chip `Structure_0_N.vtm`),
    // not the hook window that opened it; and it must finish parsing the ~160 MB
    // series before it can paint — the timeline appears only once that load is
    // done, so wait for it instead of queueing the first screenshot behind it.
    const dfPage = await designFieldsPage(app, Date.now() + 600_000, page);
    await dfPage.waitForFunction(() => {
      const appEl = document.querySelector("#app");
      if (!appEl || getComputedStyle(appEl).display === "none") return false;
      const scrub = document.querySelector("#tl-scrub");
      const label = document.querySelector("#tl-label")?.textContent ?? "";
      return !!scrub && scrub.getAttribute("max") !== null && /\d+\s*\/\s*\d+/.test(label);
    }, null, { timeout: 600_000 });
    await nextPaint(dfPage);
    await sleep(1_500);
    await dfPage.locator("#nav-fit").click();
    await dfPage.keyboard.press("i"); // isometric corner view
    await sleep(1_000);
    await dfPage.mouse.move(0, 0); await sleep(300);
    await dfPage.screenshot({ path: path.join(out, "problemtype-optimization-design-fields.png"), timeout: 600_000 });

    // ---- GIF: the shape morphing iteration by iteration --------------------
    const total = Number(await dfPage.locator("#tl-scrub").getAttribute("max")) + 1;
    assert.ok(total >= 4, `the design-fields timeline holds ${total} steps — expected the per-iteration frames`);
    const grab = async (clip) => {
      const png = await dfPage.screenshot({ clip, timeout: 300_000 });
      const img = await app.evaluate(({ nativeImage }, { b64, width }) => {
        const resized = nativeImage.createFromBuffer(Buffer.from(b64, "base64")).resize({ width, quality: "best" });
        const size = resized.getSize();
        return { width: size.width, height: size.height, bgra: resized.toBitmap().toString("base64") };
      }, { b64: png.toString("base64"), width: WIDTH });
      const bgra = Buffer.from(img.bgra, "base64");
      const rgba = new Uint8Array(bgra.length);
      for (let i = 0; i < bgra.length; i += 4) { rgba[i] = bgra[i + 2]; rgba[i + 1] = bgra[i + 1]; rgba[i + 2] = bgra[i]; rgba[i + 3] = 255; }
      return { width: img.width, height: img.height, rgba };
    };
    const clip = await dfPage.locator("canvas").first().boundingBox();
    assert.ok(clip && clip.width > 300, "the design-fields canvas has a size");
    const frames = [];
    for (let index = 0; index < total; index++) {
      await dfPage.evaluate((i) => {
        const scrub = document.getElementById("tl-scrub");
        scrub.value = String(i);
        scrub.dispatchEvent(new Event("input", { bubbles: true }));
      }, index);
      await until(async () => (await dfPage.locator("#tl-label").textContent()).includes(`(${index + 1}/${total})`), `timeline at frame ${index + 1}`, 120_000);
      await setChrome(dfPage, true);
      await nextPaint(dfPage); await sleep(250); await nextPaint(dfPage);
      frames.push(await grab(clip));
      await setChrome(dfPage, false);
    }
    const identical = frames[0].rgba.length === frames[frames.length - 1].rgba.length
      && Buffer.compare(Buffer.from(frames[0].rgba), Buffer.from(frames[frames.length - 1].rgba)) === 0;
    assert.ok(!identical, "the design-fields GIF's first and last frames are identical — nothing animated");
    const gif = encodeGif(frames, { delayMs: 150 });
    assert.ok(gif.length <= GIF_BUDGET_BYTES, `the design-fields GIF is ${gif.length} bytes, over the ${GIF_BUDGET_BYTES}-byte budget`);
    fs.writeFileSync(path.join(out, "problemtype-optimization-evolution.gif"), gif);
    console.log(`optimization-run: done — summary rows from the finished run; GIF ${gif.length} bytes`);
  } catch (error) {
    // The open risk is the app exiting mid-run: leave the full app output and
    // page state behind for the post-mortem instead of just the thrown message.
    await diagnostics(app, output, "optimization-run").catch(() => {});
    throw error;
  } finally {
    await closeApp(app);
  }
}
