/**
 * Shared by every preload (side-effect import): applies the app appearance —
 * UI theme kind and chrome fonts — to the page, and exposes it to page scripts
 * as `window.kkssAppearance` for the ones with their own renderer to configure
 * (xterm, CodeMirror).
 *
 * The theme kind goes on `<html>` immediately, so vscode-vars.css's palette
 * applies from the first paint, and on `<body>` as soon as it exists, because
 * that is where VS Code puts it and where cad's viewer.css / mesh's
 * design-system.css look for it (app/renderer/view/shim.ts also sets it before
 * the viewer bundles boot). `data-vscode-theme-kind` mirrors VS Code too — it
 * is one of the two attributes cad's MutationObserver watches.
 *
 * Fonts are set as CSSOM custom properties, which a `style-src kkss:` CSP does
 * not block (it governs <style> elements and style attributes, not CSSOM).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { Appearance } from "../main/services/appearanceCore";

const CHANNEL = "kkss:appearance";
const KINDS = ["vscode-dark", "vscode-light", "vscode-high-contrast", "vscode-high-contrast-light"];

let current: Appearance | undefined = (() => {
  try {
    return ipcRenderer.sendSync(CHANNEL) as Appearance;
  } catch {
    return undefined;
  }
})();
const handlers = new Set<(a: Appearance) => void>();

function applyTo(el: HTMLElement, a: Appearance): void {
  el.classList.remove(...KINDS);
  el.classList.add(a.kind);
  el.dataset.vscodeThemeKind = a.kind;
}

function apply(a: Appearance): void {
  const root = document.documentElement;
  if (root) {
    applyTo(root, a);
    if (a.fontFamily) root.style.setProperty("--vscode-font-family", a.fontFamily);
    else root.style.removeProperty("--vscode-font-family");
    root.style.setProperty("--vscode-font-size", `${a.fontSize}px`);
  }
  if (document.body) applyTo(document.body, a);
}

if (current) {
  apply(current);
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", () => current && apply(current), { once: true });
  }
}

ipcRenderer.on(CHANNEL, (_event, a: Appearance) => {
  current = a;
  apply(a);
  for (const h of handlers) h(a);
});

contextBridge.exposeInMainWorld("kkssAppearance", {
  current: () => current,
  onChange: (handler: (a: Appearance) => void) => {
    handlers.add(handler);
  },
});
