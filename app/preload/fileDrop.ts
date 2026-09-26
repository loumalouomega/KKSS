/** Route OS file drops through the same main-process replacement guard as Open. */
import { ipcRenderer, webUtils } from "electron";
window.addEventListener("dragover", event => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
}, true);
window.addEventListener("drop", event => {
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const path = webUtils.getPathForFile(file);
  if (path) ipcRenderer.send("app:dropFile", path);
}, true);
