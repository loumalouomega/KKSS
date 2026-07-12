/** About/Update dialog renderer — status-driven UI over aboutApi IPC. */
import type { AboutInit, AboutToWebview } from "../../main/ipc";

declare global {
  interface Window {
    aboutApi: {
      post(message: unknown): void;
      onInit(handler: (init: unknown) => void): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.aboutApi;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const versionEl = byId<HTMLElement>("version");
const authorEl = byId<HTMLElement>("author");
const spinnerEl = byId<HTMLSpanElement>("update-spinner");
const textEl = byId<HTMLSpanElement>("update-text");
const progressEl = byId<HTMLProgressElement>("update-progress");
const actionsEl = byId<HTMLDivElement>("update-actions");

api.onInit((raw) => {
  const init = raw as AboutInit;
  versionEl.textContent = init.version;
  authorEl.textContent = init.author;
});

function actions(buttons: Array<{ label: string; message: unknown; primary?: boolean }>): void {
  actionsEl.innerHTML = "";
  for (const { label, message, primary } of buttons) {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.addEventListener("click", () => api.post(message));
    actionsEl.appendChild(b);
  }
}

api.onMessage((raw) => {
  const msg = raw as AboutToWebview;
  if (msg.type !== "status") return;
  spinnerEl.hidden = msg.state !== "checking" && msg.state !== "downloading";
  progressEl.hidden = msg.state !== "downloading";
  switch (msg.state) {
    case "checking":
      textEl.textContent = "Checking for updates…";
      actions([]);
      break;
    case "upToDate":
      textEl.textContent = "You're up to date.";
      actions([]);
      break;
    case "available":
      textEl.textContent = `Update available: v${msg.latestVersion}` + (msg.message ? ` — ${msg.message}` : "");
      actions(
        msg.canAutoUpdate
          ? [{ label: "Update now", message: { type: "downloadUpdate" }, primary: true }]
          : [{ label: "Open releases page", message: { type: "openReleases" }, primary: true }]
      );
      break;
    case "downloading":
      textEl.textContent = `Downloading v${msg.latestVersion}… ${msg.percent ?? 0}%`;
      progressEl.value = msg.percent ?? 0;
      actions([]);
      break;
    case "downloaded":
      textEl.textContent = `v${msg.latestVersion} downloaded.`;
      actions([{ label: "Restart to update", message: { type: "installUpdate" }, primary: true }]);
      break;
    case "error":
      textEl.textContent = msg.message ?? "Couldn't check for updates.";
      actions([
        { label: "Retry", message: { type: "checkUpdates" } },
        { label: "Open releases page", message: { type: "openReleases" } },
      ]);
      break;
  }
});

byId<HTMLButtonElement>("docs-btn").addEventListener("click", () => api.post({ type: "openDocs" }));
byId<HTMLButtonElement>("close-btn").addEventListener("click", () => api.post({ type: "close" }));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.post({ type: "close" });
});

export {};
