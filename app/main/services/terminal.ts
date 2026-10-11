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
import { endShell } from "./terminalShutdown";

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
  /** Settles when the current shell's exit has been observed (set in `spawn`). */
  private exited: Promise<void> | null = null;

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
    let markExited = (): void => undefined;
    this.exited = new Promise<void>((resolve) => {
      markExited = () => resolve();
    });
    proc.onData((data) => this.send({ type: "data", data }));
    // node-pty calls this from a native callback with no exception guard, so
    // nothing may throw out of it: an escape aborts the whole app. Resolving
    // first lets `shutdown()` finish even if the notice below fails.
    proc.onExit(({ exitCode }) => {
      markExited();
      if (this.proc === proc) this.proc = null;
      try {
        this.send({ type: "exit", code: exitCode });
      } catch (error) {
        console.error("Terminal exit notice failed", error);
      }
    });
  }

  /** Whether a shell process is running (its exit has not been observed yet). */
  hasLiveShell(): boolean {
    return this.proc !== null;
  }

  /**
   * Ends the shell and resolves once its exit has been observed, or the bounded
   * waits in `endShell` gave up. Quit awaits this in `before-quit`, so node-pty's
   * exit callback is delivered while the app is still alive to take it.
   */
  async shutdown(): Promise<void> {
    const proc = this.proc;
    const exited = this.exited;
    if (!proc || !exited) return;
    await endShell({ kill: (signal) => proc.kill(signal), exited }, process.platform);
  }

  /** Last-resort kill for `will-quit`, for a shell `shutdown()` did not reap. */
  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
