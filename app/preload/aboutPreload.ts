/** Preload for the About/Update dialog window. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("aboutApi", {
  post: (message: unknown) => ipcRenderer.send("about:toHost", message),
  onInit: (handler: (init: unknown) => void) => {
    ipcRenderer.on("about:init", (_event, init) => handler(init));
  },
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("about:toWebview", (_event, message) => handler(message));
  },
});
