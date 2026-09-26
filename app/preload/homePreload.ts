/** Preload for the home-screen renderer. */
import { contextBridge, ipcRenderer } from "electron";
import "./appearance";
import "./fileDrop";

contextBridge.exposeInMainWorld("homeApi", {
  post: (message: unknown) => {
    ipcRenderer.send("home:toHost", message);
    if ((message as { type?: string })?.type === "homeReady") {
      requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send("kkss:interactive")));
    }
  },
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("home:toWebview", (_event, message) => handler(message));
  },
});
