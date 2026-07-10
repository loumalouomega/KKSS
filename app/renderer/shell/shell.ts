/** Shell toolbar: mode toggle, Open button, current-file title, toasts. */
import type { Mode, ShellToWebview } from "../../main/ipc";
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

const btnCad = byId<HTMLButtonElement>("mode-cad");
const btnMesh = byId<HTMLButtonElement>("mode-mesh");
const openBtn = byId<HTMLButtonElement>("open-btn");
const fileTitle = byId<HTMLSpanElement>("file-title");
const toasts = byId<HTMLDivElement>("toasts");

// TikZ-generated, currentColor-based glyphs (icons/tikz-ui — see icons/README.md).
btnCad.innerHTML = `${icon("preMode")} Pre-Processing`;
btnMesh.innerHTML = `${icon("postMode")} Post-Processing`;
openBtn.innerHTML = `${icon("open")} Open…`;

const titles: Record<Mode, string | null> = { cad: null, mesh: null };
let mode: Mode = "cad";

function renderMode(): void {
  btnCad.classList.toggle("active", mode === "cad");
  btnMesh.classList.toggle("active", mode === "mesh");
  const t = titles[mode];
  fileTitle.textContent = t ? t : "No file open — use Open… or File ▸ Open";
}

btnCad.addEventListener("click", () => api.post({ type: "setMode", mode: "cad" }));
btnMesh.addEventListener("click", () => api.post({ type: "setMode", mode: "mesh" }));
openBtn.addEventListener("click", () => api.post({ type: "openFile" }));

api.onMessage((raw) => {
  const msg = raw as ShellToWebview;
  switch (msg.type) {
    case "mode":
      mode = msg.mode;
      renderMode();
      break;
    case "title":
      titles[msg.mode] = msg.fileName;
      renderMode();
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
