/**
 * Embedded terminal backend: any number of node-pty shell sessions (VS Code
 * style, up to MAX_TERMINALS) bridged to the xterm.js panel renderer over
 * term:toHost / term:toWebview, every message carrying its session id. node-pty is the
 * app's only native module (N-API, so its prebuilt/compiled binaries work
 * unchanged under Electron); it stays `external` in esbuild.mjs and ships as
 * node_modules/node-pty in the package (see electron-builder.yml).
 */
import { app, ipcMain, WebContents } from "electron";
import * as os from "node:os";
import * as pty from "node-pty";
import type { TermSessionInfo, TermToHost, TermToWebview } from "../ipc";
import { stateStore } from "./stateStore";
import { endShell } from "./terminalShutdown";
import { isValidHost } from "./cloud/providerCore/sshCore";
import { externalProcessEnv } from "./childEnv";

/** Settings ▸ Terminal Shell override, else the platform default. */
function configuredShell(): string {
  const saved = stateStore.get<string>("terminalShell");
  if (saved) return saved;
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}

/** How many terminals may be open at once (the "+" button stops at this). */
export const MAX_TERMINALS = 8;
/** Output kept per terminal so a reloaded panel can repaint it. */
export const MAX_SCROLLBACK_CHARS = 200_000;

interface Session {
  id: number;
  title: string;
  proc: pty.IPty | null;
  /** Settles when the current process's exit has been observed (set in `spawn`). */
  exited: Promise<void> | null;
  scrollback: string;
  /** The panel's last report for a restart of an exited shell. */
  exitedCode: number | null;
}

export class TerminalService {
  private sessions = new Map<number, Session>();
  private nextId = 1;
  private target: WebContents | null = null;
  private lastCols = 80;
  private lastRows = 24;
  /** True once the panel has said `termReady` (output sent earlier is lost). */
  private panelReady = false;
  /** `ssh -t <host>` shells requested before the panel was up. */
  private pendingRemote: string[] = [];
  /** Shells being closed: quit must still observe their exits (see `shutdown`). */
  private closing = new Set<Promise<void>>();

  /**
   * @param cwdProvider Directory for new shells (current file's dir, or home).
   * @param onHide Hide the panel (the ✕ button; the ptys keep running).
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
          this.panelReady = true;
          if (this.sessions.size === 0) {
            const remotes = this.pendingRemote.splice(0);
            if (remotes.length === 0) this.open();
            for (const host of remotes) this.open(host);
          } else {
            this.pendingRemote.splice(0).forEach((host) => this.open(host));
          }
          this.send({ type: "sessions", sessions: [...this.sessions.values()].map(info) });
          break;
        case "create":
          this.lastCols = msg.cols;
          this.lastRows = msg.rows;
          this.announce(this.open());
          break;
        case "input":
          this.sessions.get(msg.id)?.proc?.write(msg.data);
          break;
        case "resize":
          this.lastCols = msg.cols;
          this.lastRows = msg.rows;
          this.sessions.get(msg.id)?.proc?.resize(msg.cols, msg.rows);
          break;
        case "restart": {
          const session = this.sessions.get(msg.id);
          if (session && !session.proc) this.spawn(session);
          break;
        }
        case "close":
          this.close(msg.id);
          break;
        case "hide":
          this.onHide();
          break;
      }
    });
    app.on("will-quit", () => this.dispose());
  }

  /** Points the sessions at the terminal panel's WebContents (idempotent). */
  attach(target: WebContents): void {
    this.target = target;
  }

  private send(message: TermToWebview): void {
    if (this.target && !this.target.isDestroyed()) this.target.send("term:toWebview", message);
  }

  /** Tells an already-ready panel about a session created on the main side. */
  private announce(session: Session | undefined): void {
    if (session && this.panelReady) this.send({ type: "created", session: info(session) });
  }

  /** Creates a session and starts its shell; `remote` makes it `ssh -t <host>`. Undefined at the cap. */
  private open(remote?: string): Session | undefined {
    if (this.sessions.size >= MAX_TERMINALS) return undefined;
    const session: Session = { id: this.nextId++, title: "", proc: null, exited: null, scrollback: "", exitedCode: null };
    this.sessions.set(session.id, session);
    this.spawn(session, remote);
    return session;
  }

  private spawn(session: Session, remote?: string): void {
    // The system client keeps ~/.ssh/config, the agent and known-hosts handling
    // authoritative; a local cwd means nothing on the other machine.
    const shell = remote ? "ssh" : configuredShell();
    session.title = remote ? `ssh ${remote}` : shellName(shell);
    session.exitedCode = null;
    const proc = pty.spawn(shell, remote ? ["-t", remote] : [], {
      name: "xterm-256color",
      cols: this.lastCols,
      rows: this.lastRows,
      cwd: (remote ? undefined : this.cwdProvider()) ?? os.homedir(),
      env: externalProcessEnv(process.env) as Record<string, string>,
    });
    session.proc = proc;
    let markExited = (): void => undefined;
    session.exited = new Promise<void>((resolve) => {
      markExited = () => resolve();
    });
    proc.onData((data) => {
      session.scrollback += data;
      if (session.scrollback.length > MAX_SCROLLBACK_CHARS) session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK_CHARS);
      this.send({ type: "data", id: session.id, data });
    });
    // node-pty calls this from a native callback with no exception guard, so
    // nothing may throw out of it: an escape aborts the whole app. Resolving
    // first lets `shutdown()` finish even if the notice below fails.
    proc.onExit(({ exitCode }) => {
      markExited();
      if (session.proc === proc) session.proc = null;
      session.exitedCode = exitCode;
      // A closed session is already gone from the panel: nothing to tell it.
      if (this.sessions.get(session.id) !== session) return;
      try {
        this.send({ type: "exit", id: session.id, code: exitCode });
      } catch (error) {
        console.error("Terminal exit notice failed", error);
      }
    });
  }

  /** Ends one terminal and drops it; quit still waits for its exit. */
  private close(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.send({ type: "closed", id });
    const proc = session.proc;
    const exited = session.exited;
    if (!proc || !exited) return;
    const ending = endShell({ kill: (signal) => proc.kill(signal), exited }, process.platform).then(() => undefined);
    this.closing.add(ending);
    void ending.finally(() => this.closing.delete(ending));
  }

  /**
   * Opens `ssh -t <host>` in a NEW terminal (the existing shells are left
   * alone, as in VS Code). Takes effect immediately when the panel is up;
   * otherwise at its first `termReady`.
   */
  async openRemote(host: string): Promise<void> {
    if (!isValidHost(host)) return;
    if (!this.panelReady) {
      this.pendingRemote.push(host);
      return;
    }
    this.announce(this.open(host));
  }

  /** Whether any shell process is running (its exit has not been observed yet). */
  hasLiveShell(): boolean {
    for (const session of this.sessions.values()) if (session.proc) return true;
    return this.closing.size > 0;
  }

  /**
   * Ends every shell and resolves once all exits have been observed, or the
   * bounded waits in `endShell` gave up — concurrently, so quit waits no longer
   * than it did with one. Quit awaits this in `before-quit`, so node-pty's exit
   * callback is delivered while the app is still alive to take it.
   */
  async shutdown(): Promise<void> {
    const ending: Promise<unknown>[] = [...this.closing];
    for (const session of this.sessions.values()) {
      const proc = session.proc;
      const exited = session.exited;
      if (proc && exited) ending.push(endShell({ kill: (signal) => proc.kill(signal), exited }, process.platform));
    }
    await Promise.all(ending);
  }

  /** Last-resort kill for `will-quit`, for shells `shutdown()` did not reap. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.proc?.kill();
      session.proc = null;
    }
  }
}

function info(session: Session): TermSessionInfo {
  return { id: session.id, title: session.title, exited: session.proc === null, scrollback: session.scrollback };
}

function shellName(shell: string): string {
  const name = shell.split(/[\\/]/).pop() || shell;
  return name.replace(/\.exe$/i, "");
}
