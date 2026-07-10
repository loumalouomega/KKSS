/**
 * Shared Playwright-Electron helpers for tools/smoke.e2e.mjs and
 * tools/screenshots.mjs: launch the real app (dev layout, out/) with a file,
 * tail its KKSS_E2E message trace, and find windows by page URL.
 */
import { _electron } from "playwright-core";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
/** Electron binary path (the npm stub resolves to it under plain Node). */
export const electronPath = require("electron");
/** Repo root. */
export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Launches KKSS with `file` opened via the CLI hook. Returns the Playwright
 * ElectronApplication plus an `output()` accessor over combined stdout+stderr
 * (the KKSS_E2E=1 host↔webview message trace).
 */
export async function launchApp(file, { extraArgs = [] } = {}) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [".", "--no-sandbox", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox", ...extraArgs, file],
    cwd: root,
    env: { ...process.env, KKSS_E2E: "1", ELECTRON_RUN_AS_NODE: undefined },
    timeout: 60_000,
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

/** Polls for the window whose page URL contains `urlPart`. */
export async function appWindow(app, urlPart, deadline) {
  for (;;) {
    for (const page of app.windows()) {
      if (page.url().includes(urlPart)) return page;
    }
    if (Date.now() > deadline) {
      const urls = app.windows().map((w) => w.url());
      throw new Error(`No window matching "${urlPart}". Windows: ${urls.join(", ")}`);
    }
    await sleep(250);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
