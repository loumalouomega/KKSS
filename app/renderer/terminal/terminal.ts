/** Embedded terminal panel: xterm.js wired to the main-process pty service. */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TermToWebview } from "../../main/ipc";

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

/** xterm theme from the same --vscode-* variables the rest of the app uses. */
function themeFromCss(): { background: string; foreground: string; cursor: string } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--vscode-editor-background", "#1e1e1e"),
    foreground: v("--vscode-editor-foreground", "#cccccc"),
    cursor: v("--vscode-editor-foreground", "#cccccc"),
  };
}

const term = new Terminal({
  fontSize: 13,
  fontFamily: "Consolas, 'Courier New', monospace",
  theme: themeFromCss(),
  cursorBlink: true,
  scrollback: 5000,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(container);
fit.fit();

let exited = false;

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
      term.write(`\r\n\x1b[90m[process exited with code ${msg.code} — press Enter to restart]\x1b[0m\r\n`);
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
