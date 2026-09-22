/** Preload for the Settings page renderer. */
import { contextBridge, ipcRenderer } from "electron";
import "./appearance";

contextBridge.exposeInMainWorld("settingsApi", {
  post: (message: unknown) => ipcRenderer.send("settings:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("settings:toWebview", (_event, message) => handler(message));
  },
});
