import "../localization";
import { t } from "../../shared/i18n";
/** Shell toolbar: mode toggle, Open button, project-root chip, current-file
 *  title, toasts, tab strip. */
import type { Mode, Screen, ShellTabInfo, ShellToWebview } from "../../main/ipc";
import { TOOLBAR_ICONS, type ToolbarIconId } from "./shellIcons";
import { glyph } from "../glyphs";

/** Same wrapper the submodule providers use for their generated icons. */
function icon(id: ToolbarIconId): string {
  return `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
}

/** Icon markup + label text. The label is a static string, and it sits in its
 *  own node so a button's `textContent` is exactly the label (the e2e harness
 *  reads it: "Jobs (1)"). The gap between the two comes from `.btn`. */
function withLabel(iconHtml: string, label: string): string {
  return `${iconHtml}<span class="btn-label">${label}</span>`;
}

declare global {
  interface Window {
    shellApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.shellApi;
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const homeBtn = byId<HTMLButtonElement>("home-btn");
const btnCad = byId<HTMLButtonElement>("mode-cad");
const btnMesh = byId<HTMLButtonElement>("mode-mesh");
const openBtn = byId<HTMLButtonElement>("open-btn");
const editBtn = byId<HTMLButtonElement>("edit-btn");
const terminalBtn = byId<HTMLButtonElement>("terminal-btn");
const chatBtn = byId<HTMLButtonElement>("chat-btn");
const rootBtn = byId<HTMLButtonElement>("root-btn");
const fileTitle = byId<HTMLSpanElement>("file-title");
const zoomSelect = byId<HTMLSelectElement>("zoom-select");
const toasts = byId<HTMLDivElement>("toasts");
const tabStrip = byId<HTMLDivElement>("tab-strip");

// Interface-scale presets — kept in sync with ZOOM_PRESETS in app/main/windows.ts.
const ZOOM_PRESETS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
for (const f of ZOOM_PRESETS) {
  const opt = document.createElement("option");
  opt.value = String(f);
  opt.textContent = `${Math.round(f * 100)}%`;
  zoomSelect.appendChild(opt);
}
zoomSelect.value = "1";
zoomSelect.addEventListener("change", () =>
  api.post({ type: "setZoom", factor: Number(zoomSelect.value) })
);

/** Reflects the host's applied scale (menu shortcuts change it too). */
function setZoomValue(factor: number): void {
  let nearest = ZOOM_PRESETS[0];
  for (const f of ZOOM_PRESETS) if (Math.abs(f - factor) < Math.abs(nearest - factor)) nearest = f;
  zoomSelect.value = String(nearest);
}

// TikZ-generated, currentColor-based glyphs (icons/tikz-ui — see icons/README.md).
homeBtn.innerHTML = withLabel(icon("home"), t("Home"));
btnCad.innerHTML = withLabel(icon("preMode"), t("Pre-Processing"));
btnMesh.innerHTML = withLabel(icon("postMode"), t("Post-Processing"));
openBtn.innerHTML = withLabel(icon("open"), t("Open…"));
editBtn.innerHTML = withLabel(icon("edit"), t("Edit"));
terminalBtn.innerHTML = withLabel(icon("terminal"), t("Terminal"));
chatBtn.innerHTML = withLabel(icon("chat"), t("Chat"));

let editorTitle: string | null = null;
let editorDirty = false;
let screen: Screen = "home";

/** Per-mode tab-strip state, resynced wholesale on every "tabs" message. */
const tabState: Record<Mode, { tabs: ShellTabInfo[]; activeTabId: string | undefined }> = {
  cad: { tabs: [], activeTabId: undefined },
  mesh: { tabs: [], activeTabId: undefined },
};

/** The unsaved-changes marker (replaces the " ●" text glyph). */
function dirtyDot(): HTMLSpanElement {
  const dot = document.createElement("span");
  dot.className = "ui-dot";
  dot.title = t("Unsaved changes");
  return dot;
}

function renderMode(): void {
  btnCad.classList.toggle("active", screen === "cad");
  btnMesh.classList.toggle("active", screen === "mesh");
  btnCad.setAttribute("aria-selected", String(screen === "cad"));
  btnMesh.setAttribute("aria-selected", String(screen === "mesh"));
  btnCad.tabIndex = screen === "mesh" ? -1 : 0;
  btnMesh.tabIndex = screen === "mesh" ? 0 : -1;
  if (screen === "editor") {
    fileTitle.textContent = editorTitle ?? t("Text editor");
    if (editorTitle && editorDirty) fileTitle.append(dirtyDot());
    return;
  }
  // cad/mesh titles live in the tab strip now — this spacer stays blank there.
  fileTitle.textContent = "";
}

/** Rebuilds the tab-strip row for whichever mode screen is active. */
function renderTabStrip(): void {
  const activeScreen = screen;
  if (activeScreen !== "cad" && activeScreen !== "mesh") {
    tabStrip.hidden = true;
    return;
  }
  const mode = activeScreen;
  tabStrip.hidden = false;
  const focusId = (document.activeElement as HTMLElement)?.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
  const focusClose = document.activeElement?.classList.contains("tab-close");
  tabStrip.innerHTML = "";
  const { tabs, activeTabId } = tabState[mode];
  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = tab.id === activeTabId ? "tab active" : "tab";
    row.setAttribute("role", "presentation");
    row.dataset.tabId = tab.id;
    row.addEventListener("keydown", event => {
      if (!(event.target as HTMLElement).classList.contains("tab-label")) return;
      const index = tabs.indexOf(tab);
      const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1]
        : event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : undefined;
      if (target) {
        event.preventDefault();
        tabStrip.querySelector<HTMLElement>(`[data-tab-id="${target.id}"] .tab-label`)?.focus();
        api.post({ type: "selectTab", mode, tabId: target.id });
      } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); row.click(); }
      else if (event.key === "Delete") { event.preventDefault(); api.post({ type: "closeTab", mode, tabId: tab.id }); }
    });
    // A cloud document's real home is the remote folder, not the staging path,
    // so that is what the tooltip says.
    row.title = tab.cloud
      ? `${tab.cloud.provider} · ${tab.cloud.name}`
      : (tab.fileName ?? t("Untitled"));
    row.addEventListener("click", () => api.post({ type: "selectTab", mode, tabId: tab.id }));

    const label = document.createElement("button");
    label.type = "button";
    label.className = "tab-label";
    label.setAttribute("role", "tab");
    label.setAttribute("aria-selected", String(tab.id === activeTabId));
    label.tabIndex = tab.id === activeTabId ? 0 : -1;
    const cloudMark = tab.cloud ? "☁ " : "";
    label.textContent = `${cloudMark}${tab.fileName ?? t("Untitled")}`;
    row.appendChild(label);
    if (tab.dirty) row.appendChild(dirtyDot());

    const close = document.createElement("button");
    close.className = "tab-close icon-btn";
    close.tabIndex = tab.id === activeTabId ? 0 : -1;
    close.innerHTML = glyph("x", "sm");
    close.title = t("Close tab");
    close.setAttribute("aria-label", t("Close tab"));
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      api.post({ type: "closeTab", mode, tabId: tab.id });
    });
    row.appendChild(close);

    tabStrip.appendChild(row);
  }

  const add = document.createElement("button");
  add.className = "tab-new icon-btn";
  add.innerHTML = glyph("plus");
  add.setAttribute("aria-label", t("New tab"));
  add.title = mode === "cad" ? t("New pre-processing tab") : t("New post-processing tab");
  add.addEventListener("click", () => api.post({ type: "newTab", mode }));
  tabStrip.appendChild(add);
  if (focusId) {
    const target = tabStrip.querySelector<HTMLElement>(`[data-tab-id="${focusId}"]`) ?? tabStrip.querySelector<HTMLElement>(".tab.active");
    target?.querySelector<HTMLElement>(focusClose ? ".tab-close" : ".tab-label")?.focus();
  }
}

homeBtn.addEventListener("click", () => api.post({ type: "goHome" }));
btnCad.addEventListener("click", () => api.post({ type: "setMode", mode: "cad" }));
btnMesh.addEventListener("click", () => api.post({ type: "setMode", mode: "mesh" }));
openBtn.addEventListener("click", () => api.post({ type: "openFile" }));
editBtn.addEventListener("click", () => api.post({ type: "editCurrentFile" }));
terminalBtn.addEventListener("click", () => api.post({ type: "toggleTerminal" }));
chatBtn.addEventListener("click", () => api.post({ type: "toggleChat" }));
rootBtn.addEventListener("click", () => api.post({ type: "chooseProjectRoot" }));

api.onMessage((raw) => {
  const msg = raw as ShellToWebview;
  switch (msg.type) {
    case "screen":
      screen = msg.screen;
      renderMode();
      renderTabStrip();
      break;
    case "title":
      editorTitle = msg.fileName;
      editorDirty = msg.dirty ?? false;
      renderMode();
      break;
    case "projectRoot":
      // Shown only when a root is explicitly set — an inferred one changes with
      // the focused tab, so a chip for it would be noise.
      if (msg.label) {
        rootBtn.innerHTML = `${glyph("folder")}<span id="root-btn-label"></span>`;
        (rootBtn.querySelector("#root-btn-label") as HTMLElement).textContent = msg.label;
        rootBtn.title = t("Project root: {0}\nClick to change", {0: msg.display ?? msg.label});
      }
      rootBtn.hidden = !msg.label;
      break;
    case "tabs":
      tabState[msg.mode] = { tabs: msg.tabs, activeTabId: msg.activeTabId };
      if (screen === msg.mode) renderTabStrip();
      break;
    case "zoom":
      setZoomValue(msg.factor);
      break;
    case "toast": {
      const el = document.createElement("div");
      el.className = `toast ${msg.kind}`;
      el.setAttribute("role", msg.kind === "error" ? "alert" : "status");
      el.dataset.toastId = String(msg.id);
      if (msg.kind === "progress") {
        const spin = document.createElement("span");
        spin.className = "spinner";
        el.appendChild(spin);
      }
      const text = document.createElement("span");
      text.className = "toast-text";
      text.textContent = msg.text;
      el.appendChild(text);
      for (const label of msg.buttons ?? []) {
        const b = document.createElement("button");
        b.className = "btn btn-secondary btn-sm";
        b.textContent = label;
        b.addEventListener("click", () =>
          api.post({ type: "toastButton", id: msg.id, button: label })
        );
        el.appendChild(b);
      }
      if (msg.kind !== "progress" && !(msg.buttons && msg.buttons.length)) {
        setTimeout(() => el.remove(), 6000);
      }
      toasts.appendChild(el);
      break;
    }
    case "toastUpdate": {
      const el = toasts.querySelector(`[data-toast-id="${msg.id}"]`);
      if (!el) break;
      if (msg.done) {
        el.remove();
      } else if (msg.text) {
        const text = el.querySelector(".toast-text");
        if (text) text.textContent = msg.text;
      }
      break;
    }
  }
});

renderMode();


const jobsBtn = byId<HTMLButtonElement>("jobs-btn");
const jobsIcon = glyph("listChecks");
jobsBtn.innerHTML = withLabel(jobsIcon, t("Jobs"));
jobsBtn.addEventListener("click", () => api.post({ type: "toggleJobs" }));
api.onMessage((raw) => {
  const msg = raw as ShellToWebview;
  if (msg.type !== "jobs") return;
  jobsBtn.innerHTML = withLabel(jobsIcon, msg.active ? t("Jobs ({0})", {0: msg.active}) : t("Jobs"));
  jobsBtn.setAttribute("aria-pressed", String(msg.visible));
  jobsBtn.title = msg.stale ? t("Kratos jobs — status unavailable; showing last known count") : t("Kratos background jobs");
});

// Terminal and Chat are plain toggles: the main process is the source of truth
// (menu, shortcut, session restore and Hide buttons all flip them), so the
// buttons only ever reflect what it reports.
api.onMessage((raw) => {
  const msg = raw as ShellToWebview;
  if (msg.type !== "panels") return;
  terminalBtn.setAttribute("aria-pressed", String(msg.terminal));
  chatBtn.setAttribute("aria-pressed", String(msg.chat));
});

api.post({ type: "shellReady" });

for (const button of [btnCad, btnMesh]) button.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === "Home" ? btnCad : event.key === "End" ? btnMesh : button === btnCad ? btnMesh : btnCad;
  target.focus(); target.click();
});
