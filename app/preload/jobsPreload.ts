import { contextBridge, ipcRenderer } from "electron";
import type { JobsToHost, JobsSnapshot } from "../main/ipc";
contextBridge.exposeInMainWorld("jobsApi", {
  post: (message: JobsToHost) => ipcRenderer.send("jobs:toHost", message),
  onMessage: (handler: (message: JobsSnapshot) => void) => {
    ipcRenderer.on("jobs:toWebview", (_event, message) => handler(message));
  },
});
