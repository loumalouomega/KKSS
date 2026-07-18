/** Preload for the What's New changelog dialog window. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("whatsNewApi", {
  post: (message: unknown) => ipcRenderer.send("whatsNew:toHost", message),
  onInit: (handler: (init: unknown) => void) => {
    ipcRenderer.on("whatsNew:init", (_event, init) => handler(init));
  },
});
