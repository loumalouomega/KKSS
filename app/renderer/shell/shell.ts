/** Shell toolbar: mode toggle, Open button, current-file title, toasts. */
import type { Screen, ShellToWebview } from "../../main/ipc";
import { TOOLBAR_ICONS, type ToolbarIconId } from "./shellIcons";

/** Same wrapper the submodule providers use for their generated icons. */
function icon(id: ToolbarIconId): string {
  return `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
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
const fileTitle = byId<HTMLSpanElement>("file-title");
const zoomSelect = byId<HTMLSelectElement>("zoom-select");
const toasts = byId<HTMLDivElement>("toasts");

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
homeBtn.innerHTML = `${icon("home")} Home`;
btnCad.innerHTML = `${icon("preMode")} Pre-Processing`;
btnMesh.innerHTML = `${icon("postMode")} Post-Processing`;
openBtn.innerHTML = `${icon("open")} Open…`;
editBtn.innerHTML = `${icon("edit")} Edit`;
terminalBtn.innerHTML = `${icon("terminal")} Terminal`;
chatBtn.innerHTML = `${icon("chat")} Chat`;

const titles: Record<"cad" | "mesh" | "editor", string | null> = { cad: null, mesh: null, editor: null };
let editorDirty = false;
let screen: Screen = "home";

function renderMode(): void {
  btnCad.classList.toggle("active", screen === "cad");
  btnMesh.classList.toggle("active", screen === "mesh");
  if (screen === "editor") {
    const t = titles.editor;
    fileTitle.textContent = t ? `${t}${editorDirty ? " ●" : ""}` : "Text editor";
    return;
  }
  const t = screen === "home" ? null : titles[screen];
  fileTitle.textContent = t ? t : "No file open — use Open… or File ▸ Open";
}

homeBtn.addEventListener("click", () => api.post({ type: "goHome" }));
btnCad.addEventListener("click", () => api.post({ type: "setMode", mode: "cad" }));
btnMesh.addEventListener("click", () => api.post({ type: "setMode", mode: "mesh" }));
openBtn.addEventListener("click", () => api.post({ type: "openFile" }));
editBtn.addEventListener("click", () => api.post({ type: "editCurrentFile" }));
terminalBtn.addEventListener("click", () => api.post({ type: "toggleTerminal" }));
chatBtn.addEventListener("click", () => api.post({ type: "toggleChat" }));

api.onMessage((raw) => {
  const msg = raw as ShellToWebview;
  switch (msg.type) {
    case "screen":
      screen = msg.screen;
      renderMode();
      break;
    case "title":
      titles[msg.view] = msg.fileName;
      if (msg.view === "editor") editorDirty = msg.dirty ?? false;
      renderMode();
      break;
    case "zoom":
      setZoomValue(msg.factor);
      break;
    case "toast": {
      const el = document.createElement("div");
      el.className = `toast ${msg.kind}`;
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
api.post({ type: "shellReady" });
