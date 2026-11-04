import { contextBridge, ipcRenderer } from "electron";
import "./appearance";
import type { StudyToHost, StudyPanelState } from "../main/ipc";
contextBridge.exposeInMainWorld("studyApi", {
  post: (message: StudyToHost) => ipcRenderer.send("study:toHost", message),
  onMessage: (handler: (message: StudyPanelState) => void) => {
    ipcRenderer.on("study:toWebview", (_event, message) => handler(message));
  },
});
