import "../localization";
import { t } from "../../shared/i18n";
/** Embedded terminal panel: xterm.js wired to the main-process pty service. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TermToWebview } from "../../main/ipc";
import type { Appearance } from "../appearance";
import { glyph } from "../glyphs";

declare global {
  interface Window {
    termApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.termApi;
const container = document.getElementById("terminal") as HTMLDivElement;
document.getElementById("hide-btn")!.innerHTML = `${glyph("x", "sm")}<span>${t("Hide")}</span>`;

/** xterm theme from the same --vscode-* variables the rest of the app uses —
 *  re-read on every appearance change, since the UI theme swaps them. */
function themeFromCss(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--vscode-editor-background", "#1e1e1e"),
    foreground: v("--vscode-editor-foreground", "#cccccc"),
    cursor: v("--vscode-editor-foreground", "#cccccc"),
    selectionBackground: v("--vscode-list-inactiveSelectionBackground", "#37373d"),
  };
}

const DEFAULT_FONT = "Consolas, 'Courier New', monospace";

/** Settings ▸ Terminal (font, scrollback, cursor), applied live. */
function terminalOptions(a: Appearance | undefined) {
  const t = a?.terminal;
  return {
    fontSize: t?.fontSize ?? 13,
    fontFamily: t?.fontFamily || DEFAULT_FONT,
    scrollback: t?.scrollback ?? 5000,
    cursorStyle: t?.cursorStyle ?? "block",
    cursorBlink: t?.cursorBlink ?? true,
    theme: themeFromCss(),
  };
}

const term = new Terminal({ ...terminalOptions(window.kkssAppearance?.current()), screenReaderMode: true });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(container);
fit.fit();

let exited = false;

window.kkssAppearance?.onChange((a) => {
  Object.assign(term.options, terminalOptions(a));
  // A font change alters the cell size, so the grid must be refitted.
  fit.fit();
  api.post({ type: "resize", cols: term.cols, rows: term.rows });
});

term.onData((data) => {
  if (exited) {
    if (data.includes("\r")) {
      exited = false;
      term.clear();
      api.post({ type: "restart" });
    }
    return;
  }
  api.post({ type: "input", data });
});

api.onMessage((raw) => {
  const msg = raw as TermToWebview;
  switch (msg.type) {
    case "data":
      term.write(msg.data);
      break;
    case "exit":
      exited = true;
      term.write(`\r\n\x1b[90m${t("[process exited with code {0} — press Enter to restart]", {0: msg.code})}\x1b[0m\r\n`);
      break;
  }
});

new ResizeObserver(() => {
  fit.fit();
  api.post({ type: "resize", cols: term.cols, rows: term.rows });
}).observe(container);

(document.getElementById("hide-btn") as HTMLButtonElement).addEventListener("click", () =>
  api.post({ type: "hide" })
);

window.addEventListener("focus", () => term.focus());
term.focus();
api.post({ type: "termReady", cols: term.cols, rows: term.rows });
