/** Preload for the License dialog window. */
import { contextBridge, ipcRenderer } from "electron";
import "./appearance";

contextBridge.exposeInMainWorld("licenseApi", {
  post: (message: unknown) => ipcRenderer.send("license:toHost", message),
  onInit: (handler: (init: unknown) => void) => {
    ipcRenderer.on("license:init", (_event, init) => handler(init));
  },
});
