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

  /** Whether a shell process is alive. Quit holds until `drain()` has run. */
  hasLiveShell(): boolean {
    return this.proc !== null;
  }

  /**
   * Kills the shell and resolves once its exit has been delivered. Quit waits
   * for this because node-pty reports an exit from a native thread: if that
   * report lands after Electron has begun tearing the JS environment down, the
   * N-API call fails and an uncaught Napi::Error aborts the process (SIGABRT),
   * which is what the accessibility acceptance scenario hit in CI. A shell that
   * ignores SIGHUP is escalated to SIGKILL, so it cannot hold quit open.
   */
  async drain(timeoutMs = 1500): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const exited = new Promise<void>((resolve) => proc.onExit(() => resolve()));
    proc.kill();
    if (!(await settledWithin(exited, timeoutMs))) {
      proc.kill("SIGKILL");
      await settledWithin(exited, timeoutMs);
    }
    if (this.proc === proc) this.proc = null;
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

/** Resolves true if `promise` settles within `ms`, false on timeout. */
function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
