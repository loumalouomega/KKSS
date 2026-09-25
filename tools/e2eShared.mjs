/**
 * Shared Playwright-Electron helpers for tools/smoke.e2e.mjs and
 * tools/screenshots.mjs: launch the real app (dev layout, out/) with a file,
 * tail its KKSS_E2E message trace, and find windows by page URL.
 */
import { _electron } from "playwright-core";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
/** Electron binary path (the npm stub resolves to it under plain Node). */
export const electronPath = require("electron");
/** Repo root. */
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Launches KKSS with `file` opened via the CLI hook (omit `file` to land on
 * the home screen). Returns the Playwright ElectronApplication plus an
 * `output()` accessor over combined stdout+stderr (the KKSS_E2E=1
 * host↔webview message trace).
 */
/**
 * @param {string|undefined} file  Document to open on launch.
 * @param {{extraArgs?: string[], timeout?: number, userDataDir?: string, env?: Record<string, string|undefined>, restore?: boolean, singleInstance?: boolean}} opts
 *   `userDataDir` isolates the run from the developer's real ~/.config/kkss.
 *   Callers that render persisted state (the docs screenshots now show the
 *   recent-files list) must pass one, or a committed PNG would capture whoever
 *   regenerated it; every caller passing one also keeps e2e runs from writing
 *   to the real profile at all.
 */
export async function launchApp(file, { extraArgs = [], timeout = 60_000, userDataDir, env = {}, restore = false, singleInstance = false } = {}) {
  // The UI theme defaults to "Follow system", so an isolated profile would
  // render in whatever theme the generating machine (or a headless Xvfb)
  // reports — seed Dark+ so committed screenshots stay reproducible. Seeded
  // rather than locked via KKSS_UI_THEME, which would make it unchangeable.
  if (userDataDir) {
    const state = path.join(userDataDir, "state.json");
    if (!fs.existsSync(state)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(state, JSON.stringify({ uiTheme: "dark" }));
    }
  }
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [
      ".",
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--disable-gpu-sandbox",
      // A flag, so fileArgFrom() in the app skips it when looking for the
      // launch document.
      ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : []),
      ...extraArgs,
      ...(file ? [file] : []),
    ],
    cwd: root,
    // KKSS_ALLOW_MULTIPLE_INSTANCES: the harness relaunches the app many times
    // and SIGKILLs the tree between runs (killTree below), so a lock left over
    // from a killed run would make every later launch quit on startup.
    env: {
      ...process.env,
      KKSS_E2E: "1",
      KKSS_ALLOW_MULTIPLE_INSTANCES: singleInstance ? undefined : "1",
      KKSS_E2E_RESTORE: restore ? "1" : undefined,
      ...env,
      ELECTRON_RUN_AS_NODE: undefined,
    },
    timeout,
  });
  let captured = "";
  app.process().stdout?.on("data", (d) => (captured += d.toString()));
  app.process().stderr?.on("data", (d) => (captured += d.toString()));
  return { app, output: () => captured };
}

/** Waits until every marker string has appeared in `output()`. */
export async function waitForMarkers(output, markers, deadline) {
  for (const marker of markers) {
    while (!output().includes(marker)) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for "${marker}".\n--- captured output ---\n${output()}`);
      }
      await sleep(250);
    }
  }
}

/**
 * Polls for the window whose page URL contains `urlPart`.
 *
 * With `deadGraceMs` set, gives up early when a window keeps reporting a
 * non-app URL (e.g. ":") for that long: a view whose renderer crashed before
 * committing its URL never recovers within the launch, so waiting out the
 * full deadline only delays the caller's relaunch-and-retry.
 */
export async function appWindow(app, urlPart, deadline, { deadGraceMs } = {}) {
  let deadSince;
  for (;;) {
    const windows = app.windows();
    for (const page of windows) {
      if (page.url().includes(urlPart)) return page;
    }
    const urls = windows.map((w) => w.url());
    const now = Date.now();
    if (deadGraceMs && urls.some((u) => !u.startsWith("kkss:"))) {
      deadSince ??= now;
      if (now - deadSince > deadGraceMs) {
        throw new Error(`No window matching "${urlPart}" and a window looks renderer-dead after ${deadGraceMs}ms. Windows: ${urls.join(", ")}`);
      }
    } else {
      deadSince = undefined;
    }
    if (now > deadline) {
      throw new Error(`No window matching "${urlPart}". Windows: ${urls.join(", ")}`);
    }
    await sleep(250);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Force-kills `pid` and every descendant process (best-effort; no-ops if
 * `ps` isn't available or the tree is already gone).
 */
function killTree(pid) {
  try {
    const out = execSync("ps -eo pid,ppid --no-headers", { encoding: "utf8" });
    const childrenOf = new Map();
    for (const line of out.trim().split("\n")) {
      const [p, ppid] = line.trim().split(/\s+/).map(Number);
      if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
      childrenOf.get(ppid).push(p);
    }
    const stack = [pid];
    while (stack.length) {
      const p = stack.pop();
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // Already gone.
      }
      stack.push(...(childrenOf.get(p) ?? []));
    }
  } catch {
    // `ps` unavailable (e.g. Windows) — nothing more we can do here.
  }
}

/**
 * Closes `app` and guarantees no descendant process survives it.
 *
 * Chromium's GPU process can wedge (the "stall on ReadPixels" case
 * smoke.e2e.mjs works around) and outlive a graceful app.close() as an
 * orphan that keeps burning a CPU core — starving every later launch's
 * software renderer on CI's shared runners and turning one crashed attempt
 * into a run of identical failures. Force-kill the tree unconditionally so
 * a wedged process never survives past its case.
 */
export async function closeApp(app) {
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), sleep(5000)]);
  if (pid) killTree(pid);
}

/** Quit must complete naturally in lifecycle assertions; cleanup may force-kill later. */
export async function quitApp(app, timeout = 40_000) {
  const child = app.process();
  let timer;
  let onExit;
  const exited = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Graceful quit timed out")), timeout);
    onExit = (code, signal) => code === 0 ? resolve() : reject(new Error(`Exit ${code}${signal ? ` via ${signal}` : ""}`));
    child.once("exit", onExit);
  });
  try {
    // Schedule quit after this IPC evaluation returns. Electron may close the
    // window before the evaluate reply otherwise reaches Playwright.
    await Promise.all([app.evaluate(({ app }) => { setImmediate(() => app.quit()); }), exited]);
  } finally {
    clearTimeout(timer);
    child.off("exit", onExit);
  }
}

export async function until(check, label = "condition", timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(100);
  }
}

export async function menu(app, label) {
  return app.evaluate(({ Menu }, label) => {
    const find = (m) => { for (const i of m.items) { if (i.label === label) return i; const nested = i.submenu && find(i.submenu); if (nested) return nested; } };
    const item = find(Menu.getApplicationMenu());
    if (!item || !item.enabled) throw new Error(`Unavailable menu: ${label}`);
    item.click(item);
  }, label);
}

export async function selectFile(app, file, save = false) {
  await app.evaluate(({ dialog }, { file, save }) => {
    if (save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    else dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, { file, save });
}

export const softwareGL = ["--use-gl=angle", "--use-angle=swiftshader", "--disable-gpu-compositing", "--disable-dev-shm-usage"];

/** Best-effort artifacts must never hide the original assertion. */
export async function diagnostics(app, output, name) {
  const dir = path.join(root, "test-results", name.replace(/[^a-z0-9-]/gi, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "electron.log"), output());
  if (!app) return;
  fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify(app.windows().map(p => p.url()), null, 2));
  await Promise.allSettled(app.windows().map(async (p, i) => {
    await Promise.allSettled([
      p.screenshot({ path: path.join(dir, `${i}.png`), timeout: 3000 }),
      Promise.race([p.content(), sleep(3000).then(() => null)]).then(html => {
        if (html !== null) fs.writeFileSync(path.join(dir, `${i}.html`), html);
      }),
    ]);
  }));
}
