/**
 * Embedded terminal backend: one node-pty shell session bridged to the
 * xterm.js panel renderer over term:toHost / term:toWebview. node-pty is the
 * app's only native module (N-API, so its prebuilt/compiled binaries work
 * unchanged under Electron); it stays `external` in esbuild.mjs and ships as
 * node_modules/node-pty in the package (see electron-builder.yml).
 */
import { app, ipcMain, WebContents } from "electron";
import * as os from "node:os";
import * as pty from "node-pty";
import type { TermToHost, TermToWebview } from "../ipc";
import { stateStore } from "./stateStore";

/** Settings ▸ Terminal Shell override, else the platform default. */
function configuredShell(): string {
  const saved = stateStore.get<string>("terminalShell");
  if (saved) return saved;
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}

export class TerminalService {
  private proc: pty.IPty | null = null;
  private target: WebContents | null = null;
  private lastCols = 80;
  private lastRows = 24;

  /**
   * @param cwdProvider Directory for new shells (current file's dir, or home).
   * @param onHide Hide the panel (the ✕ button; the pty keeps running).
   */
  constructor(
    private readonly cwdProvider: () => string | undefined,
    private readonly onHide: () => void
  ) {
    ipcMain.on("term:toHost", (event, raw) => {
      if (!this.target || event.sender !== this.target) return;
      const msg = raw as TermToHost;
      switch (msg.type) {
        case "termReady":
          this.lastCols = msg.cols;
          this.lastRows = msg.rows;
          if (!this.proc) this.spawn();
          break;
        case "input":
          this.proc?.write(msg.data);
          break;
        case "resize":
          this.lastCols = msg.cols;
          this.lastRows = msg.rows;
          this.proc?.resize(msg.cols, msg.rows);
          break;
        case "restart":
          if (!this.proc) this.spawn();
          break;
        case "hide":
          this.onHide();
          break;
      }
    });
    app.on("will-quit", () => this.dispose());
  }

  /** Points the session at the terminal panel's WebContents (idempotent). */
  attach(target: WebContents): void {
    this.target = target;
  }

  private send(message: TermToWebview): void {
    if (this.target && !this.target.isDestroyed()) this.target.send("term:toWebview", message);
  }

  private spawn(): void {
    const shell = configuredShell();
    const proc = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: this.lastCols,
      rows: this.lastRows,
      cwd: this.cwdProvider() ?? os.homedir(),
      env: process.env as Record<string, string>,
    });
    this.proc = proc;
    proc.onData((data) => this.send({ type: "data", data }));
    proc.onExit(({ exitCode }) => {
      if (this.proc === proc) this.proc = null;
      this.send({ type: "exit", code: exitCode });
    });
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
