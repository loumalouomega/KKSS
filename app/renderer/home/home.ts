/**
 * Home screen: the config-driven main menu shown on launch (see homeConfig.ts),
 * plus the recent-files list.
 *
 * The buttons are static config; the recents list and the project-root line are
 * pushed from main over home:toWebview and re-pushed on `homeReady`, so a
 * reload replays them. Both arrive pre-formatted because this is a browser
 * bundle with no node:path.
 */
import { HOME_BUTTONS } from "./homeConfig";
import { TOOLBAR_ICONS } from "../shell/shellIcons";
import type { HomeToWebview, ProjectRootInfo, RecentEntry } from "../../main/ipc";

declare global {
  interface Window {
    homeApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.homeApi;
const menu = document.getElementById("menu") as HTMLDivElement;

for (const { action, icon, label, description } of HOME_BUTTONS) {
  const button = document.createElement("button");
  button.className = "menu-btn";
  button.title = description;

  const glyph = document.createElement("span");
  glyph.className = "menu-btn-icon toolbar-icon";
  glyph.innerHTML = TOOLBAR_ICONS[icon];
  const text = document.createElement("span");
  text.className = "menu-btn-text";
  const title = document.createElement("span");
  title.className = "menu-btn-label";
  title.textContent = label;
  const detail = document.createElement("span");
  detail.className = "menu-btn-description";
  detail.textContent = description;
  text.append(title, detail);
  button.append(glyph, text);

  button.addEventListener("click", () => api.post({ type: "action", action }));
  menu.appendChild(button);
}

const recents = document.getElementById("recents") as HTMLElement;
const recentsList = document.getElementById("recents-list") as HTMLDivElement;

document
  .getElementById("recents-clear")!
  .addEventListener("click", () => api.post({ type: "clearRecents" }));

function renderRecents(entries: RecentEntry[]): void {
  recentsList.replaceChildren();
  for (const entry of entries) {
    const button = document.createElement("button");
    button.className = "recent-btn";
    // Folder in the tooltip, mirroring the native menu's row; and textContent
    // throughout — a file name is data, never markup.
    button.title = entry.description;

    const glyph = document.createElement("span");
    glyph.className = "recent-btn-icon toolbar-icon";
    glyph.innerHTML = TOOLBAR_ICONS[entry.mode === "cad" ? "preMode" : "postMode"];
    const label = document.createElement("span");
    label.className = "recent-btn-label";
    label.textContent = entry.label;
    button.append(glyph, label);

    button.addEventListener("click", () =>
      api.post({ type: "openRecent", path: entry.path, mode: entry.mode })
    );
    recentsList.appendChild(button);
  }
  recents.hidden = entries.length === 0;
}

const projectRootSection = document.getElementById("project-root") as HTMLElement;
const projectRootPath = document.getElementById("project-root-path") as HTMLElement;

document
  .getElementById("project-root-change")!
  .addEventListener("click", () => api.post({ type: "chooseProjectRoot" }));
document
  .getElementById("project-root-clear")!
  .addEventListener("click", () => api.post({ type: "clearProjectRoot" }));

function renderProjectRoot(info: ProjectRootInfo): void {
  // Only an explicitly chosen root is shown; an inferred one would change every
  // time the focused document did.
  projectRootPath.textContent = info.display ?? "";
  projectRootPath.title = info.path ?? "";
  projectRootSection.hidden = !info.path;
}

api.onMessage((raw) => {
  const message = raw as HomeToWebview;
  if (message?.type === "recents") renderRecents(message.entries);
  else if (message?.type === "projectRoot") renderProjectRoot(message);
});

api.post({ type: "homeReady" });
