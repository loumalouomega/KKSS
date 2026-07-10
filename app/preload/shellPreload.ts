/** Preload for the shell toolbar renderer. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("shellApi", {
  post: (message: unknown) => ipcRenderer.send("shell:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("shell:toWebview", (_event, message) => handler(message));
  },
});
