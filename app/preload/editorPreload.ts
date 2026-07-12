/** Preload for the text-editor renderer. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("editorApi", {
  post: (message: unknown) => ipcRenderer.send("editor:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("editor:toWebview", (_event, message) => handler(message));
  },
});
