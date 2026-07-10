/** Preload for the modal picker window (quick-pick / input-box replacement). */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pickerApi", {
  post: (message: unknown) => ipcRenderer.send("picker:toHost", message),
  onInit: (handler: (init: unknown) => void) => {
    ipcRenderer.on("picker:init", (_event, init) => handler(init));
  },
});
