/** Preload for the home-screen renderer. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("homeApi", {
  post: (message: unknown) => ipcRenderer.send("home:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("home:toWebview", (_event, message) => handler(message));
  },
});
