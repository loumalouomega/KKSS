/** Narrow WebviewPanel adapter for mesh's standalone scientific plot builder. */
import { BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";
import { windowBackground } from "./appearance";
import { toast } from "./notifications";

export function createPlotPanel(title: string) {
  const win = new BrowserWindow({
    title, width: 1200, height: 800, show: false, backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, "preload/viewPreload.js"),
      additionalArguments: ["--kkss-channel=plots"],
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  const handlers = new Set<(message: unknown) => void>();
  const disposed = new Set<() => void>();
  const receive = (event: Electron.IpcMainEvent, message: unknown) => {
    if (event.sender === win.webContents) for (const handler of handlers) handler(message);
  };
  const initial = (event: Electron.IpcMainEvent) => {
    if (event.sender === win.webContents) event.returnValue = {};
  };
  ipcMain.on("plots:toHost", receive);
  ipcMain.on("plots:initialState", initial);
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    ipcMain.removeListener("plots:toHost", receive);
    ipcMain.removeListener("plots:initialState", initial);
    for (const callback of disposed) callback();
    handlers.clear(); disposed.clear();
  });
  let html = "";
  return {
    webview: {
      cspSource: "kkss:",
      asWebviewUri: (uri: { fsPath: string }) => {
        const name = path.relative(path.join(__dirname, "media"), uri.fsPath);
        if (name.startsWith("..") || path.isAbsolute(name)) throw new Error("Plot asset outside media root");
        return `kkss://app/renderer/mesh/${name.split(path.sep).map(encodeURIComponent).join("/")}`;
      },
      get html() { return html; },
      set html(value: string) {
        // Like MeshHost, consume the trusted build-generated page, never arbitrary HTML.
        html = value;
        void win.loadURL("kkss://app/renderer/mesh/plots.html").then(() => {
          if (!win.isDestroyed()) win.show();
        }).catch(error => { toast("error", `Could not open scientific plots: ${String(error)}`); if (!win.isDestroyed()) win.close(); });
      },
      postMessage: async (message: unknown) => {
        if (win.isDestroyed()) return false;
        win.webContents.send("plots:toWebview", message); return true;
      },
      onDidReceiveMessage: (callback: (message: unknown) => void) => {
        handlers.add(callback); return { dispose: () => { handlers.delete(callback); } };
      },
    },
    onDidDispose: (callback: () => void) => {
      disposed.add(callback); return { dispose: () => { disposed.delete(callback); } };
    },
    dispose: () => { if (!win.isDestroyed()) win.close(); },
  };
}
