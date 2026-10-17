/**
 * License dialog — a frameless singleton window (the About/What's-New
 * pattern from services/about.ts and services/whatsNew.ts) showing the
 * repo's LICENSE text. Help ▸ License… opens it; the renderer only posts a
 * close request back, so the contract is a tenth the size of About's.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { LicenseInit, LicenseToHost } from "../ipc";

let licenseOutDir = "";
let licenseWin: BrowserWindow | null = null;

export function configureLicense(outDir: string): void {
  licenseOutDir = outDir;

  ipcMain.on("license:toHost", (event, raw) => {
    if (!licenseWin || event.sender !== licenseWin.webContents) return;
    const msg = raw as LicenseToHost;
    if (msg.type === "close") licenseWin.close();
  });
}

export function showLicense(): void {
  if (licenseWin && !licenseWin.isDestroyed()) {
    licenseWin.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 560,
    height: 720,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minWidth: 380,
    minHeight: 300,
    webPreferences: {
      preload: path.join(licenseOutDir, "preload", "licensePreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  licenseWin = win;

  win.on("closed", () => {
    licenseWin = null;
  });

  win.webContents.once("did-finish-load", () => {
    const init: LicenseInit = { version: app.getVersion(), text: licenseText(licenseOutDir) };
    win.webContents.send("license:init", init);
  });
  void win.loadURL("kkss://app/renderer/license/license.html");
}

/** The LICENSE text beside the bundle, for the renderer to receive inline. */
export function licenseText(outDir: string): string {
  try {
    return fs.readFileSync(path.join(outDir, "LICENSE"), "utf8");
  } catch {
    return "";
  }
}
