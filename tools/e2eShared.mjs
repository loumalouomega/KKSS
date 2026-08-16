/**
 * Shared Playwright-Electron helpers for tools/smoke.e2e.mjs and
 * tools/screenshots.mjs: launch the real app (dev layout, out/) with a file,
 * tail its KKSS_E2E message trace, and find windows by page URL.
 */
import { _electron } from "playwright-core";
import { execSync } from "node:child_process";
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
export async function launchApp(file, { extraArgs = [], timeout = 60_000 } = {}) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox", ...extraArgs, ...(file ? [file] : [])],
    cwd: root,
    env: { ...process.env, KKSS_E2E: "1", ELECTRON_RUN_AS_NODE: undefined },
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
  await app.close().catch(() => {});
  if (pid) killTree(pid);
}
