/**
 * About/Update dialog — a frameless singleton window (same pattern as the
 * modal picker in quickPick.ts), backed by app/renderer/about/. Shows the
 * app version + author and drives the update flow in services/updates.ts.
 */
import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import type { AboutInit, AboutToHost, AboutToWebview } from "../ipc";
import { DOCS_URL, RELEASES_URL } from "../urls";
import { attachUpdateSink, checkForUpdate, downloadUpdate, installUpdate } from "./updates";

/** Injected by esbuild.mjs from package.json's `author` (never drifts). */
declare const __KKSS_AUTHOR__: string;

let aboutOutDir = "";
let aboutWin: BrowserWindow | null = null;

export function configureAbout(outDir: string): void {
  aboutOutDir = outDir;

  ipcMain.on("about:toHost", (event, raw) => {
    if (!aboutWin || event.sender !== aboutWin.webContents) return;
    const msg = raw as AboutToHost;
    switch (msg.type) {
      case "checkUpdates":
        void checkForUpdate();
        break;
      case "downloadUpdate":
        void downloadUpdate();
        break;
      case "installUpdate":
        installUpdate();
        break;
      case "openReleases":
        void shell.openExternal(RELEASES_URL);
        break;
      case "openDocs":
        void shell.openExternal(DOCS_URL);
        break;
      case "close":
        aboutWin.close();
        break;
    }
  });
}

export function showAbout(): void {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 460,
    height: 380,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(aboutOutDir, "preload", "aboutPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  aboutWin = win;

  attachUpdateSink((status: AboutToWebview) => {
    if (!win.isDestroyed()) win.webContents.send("about:toWebview", status);
  });
  win.on("closed", () => {
    attachUpdateSink(null);
    aboutWin = null;
  });

  win.webContents.once("did-finish-load", () => {
    const init: AboutInit = {
      version: app.getVersion(),
      author: __KKSS_AUTHOR__,
      packaged: app.isPackaged,
      platform: process.platform,
    };
    win.webContents.send("about:init", init);
    void checkForUpdate();
  });
  void win.loadURL("kkss://app/renderer/about/about.html");
}
