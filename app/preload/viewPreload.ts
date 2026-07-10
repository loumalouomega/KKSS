/**
 * Preload for the two webview pages (cad / mesh). Exposes the tiny bridge the
 * acquireVsCodeApi shim (app/renderer/view/shim.ts) builds on:
 *   __kkss.post(msg)      → ipc `${mode}:toHost`   (webview → host)
 *   __kkss.initialState   → sync snapshot { mode, theme }
 * and forwards ipc `${mode}:toWebview` → window.postMessage, which delivers
 * the standard "message" event both extension bundles already listen for.
 */
import { contextBridge, ipcRenderer } from "electron";

const arg = process.argv.find((a) => a.startsWith("--kkss-channel="));
const mode = arg ? arg.split("=")[1] : "cad";

const initialState = ipcRenderer.sendSync(`${mode}:initialState`);

contextBridge.exposeInMainWorld("__kkss", {
  post: (message: unknown) => ipcRenderer.send(`${mode}:toHost`, message),
  initialState,
});

ipcRenderer.on(`${mode}:toWebview`, (_event, message: unknown) => {
  window.postMessage(message, "*");
});
