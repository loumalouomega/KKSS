/** Preload for the embedded terminal panel renderer. */
import { contextBridge, ipcRenderer } from "electron";
import "./appearance";

contextBridge.exposeInMainWorld("termApi", {
  post: (message: unknown) => ipcRenderer.send("term:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("term:toWebview", (_event, message) => handler(message));
  },
});

/** The Output panel's Messages / Progress / Log / memory half (services/outputPanel.ts). */
contextBridge.exposeInMainWorld("outApi", {
  post: (message: unknown) => ipcRenderer.send("out:toHost", message),
  onMessage: (handler: (message: unknown) => void) => {
    ipcRenderer.on("out:toWebview", (_event, message) => handler(message));
  },
});
