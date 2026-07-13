/** Preload for the chat-sidebar renderer. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("chatApi", {
  post: (message: unknown) => ipcRenderer.send("chat:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("chat:toWebview", (_event, message) => handler(message));
  },
});
