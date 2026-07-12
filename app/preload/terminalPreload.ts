/** Preload for the embedded terminal panel renderer. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("termApi", {
  post: (message: unknown) => ipcRenderer.send("term:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("term:toWebview", (_event, message) => handler(message));
  },
});
