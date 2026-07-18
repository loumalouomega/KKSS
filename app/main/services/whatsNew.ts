/**
 * "What's New" changelog dialog — a frameless singleton window (same pattern
 * as the About dialog in about.ts), backed by app/renderer/whatsnew/. Content
 * comes from CHANGELOG.md, copied verbatim into out/ by esbuild.mjs.
 *
 * checkForNewVersion() runs once at startup: it compares the last-seen version
 * (stateStore) against app.getVersion() and, if newer CHANGELOG.md entries
 * exist, shows them automatically. It is silent on a fresh install (nothing to
 * diff against) and under the e2e smoke test (KKSS_E2E). Help ▸ What's New…
 * (showChangelog) reopens the full history on demand, regardless of version.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as semver from "semver";
import type { ChangelogEntry, WhatsNewInit, WhatsNewToHost } from "../ipc";
import { parseChangelog } from "./changelog";
import { stateStore } from "./stateStore";

const LAST_SEEN_VERSION_KEY = "lastSeenVersion";

let whatsNewOutDir = "";
let whatsNewWin: BrowserWindow | null = null;

function loadChangelogEntries(): ChangelogEntry[] {
  try {
    return parseChangelog(fs.readFileSync(path.join(whatsNewOutDir, "CHANGELOG.md"), "utf8"));
  } catch {
    return [];
  }
}

export function configureWhatsNew(outDir: string): void {
  whatsNewOutDir = outDir;

  ipcMain.on("whatsNew:toHost", (event, raw) => {
    if (!whatsNewWin || event.sender !== whatsNewWin.webContents) return;
    const msg = raw as WhatsNewToHost;
    if (msg.type === "close") whatsNewWin.close();
  });
}

function showWhatsNew(entries: ChangelogEntry[]): void {
  if (whatsNewWin && !whatsNewWin.isDestroyed()) {
    whatsNewWin.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 540,
    height: 500,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(whatsNewOutDir, "preload", "whatsNewPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  whatsNewWin = win;

  win.on("closed", () => {
    whatsNewWin = null;
  });

  win.webContents.once("did-finish-load", () => {
    const init: WhatsNewInit = { version: app.getVersion(), entries };
    win.webContents.send("whatsNew:init", init);
  });
  void win.loadURL("kkss://app/renderer/whatsnew/whatsnew.html");
}

/** Called once at startup — see the module doc comment for the gating rules. */
export function checkForNewVersion(): void {
  const current = app.getVersion();
  const lastSeen = stateStore.get<string>(LAST_SEEN_VERSION_KEY);
  void stateStore.update(LAST_SEEN_VERSION_KEY, current);
  if (process.env.KKSS_E2E || !lastSeen || lastSeen === current) return;

  const entries = loadChangelogEntries().filter((e) => semver.gt(e.version, lastSeen));
  if (entries.length) showWhatsNew(entries);
}

/** Help ▸ What's New… — reopens the full history on demand. */
export function showChangelog(): void {
  showWhatsNew(loadChangelogEntries());
}
