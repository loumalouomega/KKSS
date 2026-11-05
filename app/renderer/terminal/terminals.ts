/**
 * The Terminal tab: any number of xterm.js sessions (VS Code style), one
 * visible at a time, each bridged by id to a node-pty shell in the main process
 * (services/terminal.ts). A hidden session keeps its scrollback and its shell
 * keeps running; the session list appears once there is more than one.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { t } from "../../shared/i18n";
import type { TermSessionInfo, TermToWebview } from "../../main/ipc";
import { glyph } from "../glyphs";

interface Session {
  info: TermSessionInfo;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  exited: boolean;
}

export interface TerminalsDeps {
  /** Where the xterm hosts live (`#terminal`). */
  stack: HTMLElement;
  /** The session list container (hidden while there is at most one terminal). */
  list: HTMLElement;
  post: (message: unknown) => void;
  /** xterm options from Settings ▸ Terminal and the current UI theme. */
  options: () => Record<string, unknown>;
  /** Fired whenever the number of terminals changes (the "+"/trash state). */
  onCount: (count: number) => void;
}

export class Terminals {
  private sessions = new Map<number, Session>();
  private activeId: number | null = null;

  constructor(private readonly deps: TerminalsDeps) {
    new ResizeObserver(() => this.fitActive()).observe(deps.stack);
  }

  get count(): number { return this.sessions.size; }

  /** Applies new font/theme options to every terminal, then refits the visible one. */
  applyOptions(): void {
    for (const s of this.sessions.values()) Object.assign(s.term.options, this.deps.options());
    this.fitActive();
  }

  /** Fits the visible terminal to its pane and tells its pty (called when the tab or the panel changes size). */
  fitActive(): void {
    const s = this.active();
    if (!s || s.host.hidden || this.deps.stack.clientWidth === 0) return;
    try {
      s.fit.fit();
    } catch {
      return; // not laid out yet
    }
    this.deps.post({ type: "resize", id: s.info.id, cols: s.term.cols, rows: s.term.rows });
  }

  focusActive(): void { this.active()?.term.focus(); }

  newTerminal(): void {
    const s = this.active();
    this.deps.post({ type: "create", cols: s?.term.cols ?? 80, rows: s?.term.rows ?? 24 });
  }

  closeActive(): void {
    if (this.activeId !== null) this.deps.post({ type: "close", id: this.activeId });
  }

  /** Dimensions for the initial `termReady`, before any session exists. */
  probe(): { cols: number; rows: number } {
    const probe = new Terminal({ ...this.deps.options() });
    const fit = new FitAddon();
    probe.loadAddon(fit);
    const host = document.createElement("div");
    host.className = "term-host";
    this.deps.stack.appendChild(host);
    probe.open(host);
    try { fit.fit(); } catch { /* not laid out yet */ }
    const size = { cols: probe.cols, rows: probe.rows };
    probe.dispose();
    host.remove();
    return size;
  }

  handle(msg: TermToWebview): void {
    switch (msg.type) {
      case "sessions": {
        for (const id of [...this.sessions.keys()]) this.remove(id, false);
        for (const info of msg.sessions) this.add(info);
        const last = msg.sessions[msg.sessions.length - 1];
        if (last) this.select(last.id);
        this.render();
        break;
      }
      case "created":
        this.add(msg.session);
        this.select(msg.session.id);
        this.render();
        break;
      case "data":
        this.sessions.get(msg.id)?.term.write(msg.data);
        break;
      case "exit": {
        const s = this.sessions.get(msg.id);
        if (!s) break;
        s.exited = true;
        s.info.exited = true;
        s.term.write(`\r\n\x1b[90m${t("[process exited with code {0} — press Enter to restart]", { 0: msg.code })}\x1b[0m\r\n`);
        this.render();
        break;
      }
      case "closed":
        this.remove(msg.id, true);
        break;
    }
  }

  // ---- internals ------------------------------------------------------------

  private active(): Session | undefined {
    return this.activeId === null ? undefined : this.sessions.get(this.activeId);
  }

  private add(info: TermSessionInfo): void {
    const host = document.createElement("div");
    host.className = "term-host";
    host.hidden = true;
    this.deps.stack.appendChild(host);
    const term = new Terminal({ ...this.deps.options(), screenReaderMode: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const session: Session = { info, term, fit, host, exited: info.exited };
    if (info.scrollback) term.write(info.scrollback);
    if (info.exited) term.write(`\r\n\x1b[90m${t("[process exited — press Enter to restart]")}\x1b[0m\r\n`);
    term.onData((data) => {
      if (session.exited) {
        if (data.includes("\r")) {
          session.exited = false;
          session.info.exited = false;
          term.clear();
          this.deps.post({ type: "restart", id: info.id });
          this.render();
        }
        return;
      }
      this.deps.post({ type: "input", id: info.id, data });
    });
    this.sessions.set(info.id, session);
    this.deps.onCount(this.sessions.size);
  }

  private remove(id: number, rerender: boolean): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.term.dispose();
    s.host.remove();
    this.sessions.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      const ids = [...this.sessions.keys()];
      const next = ids[ids.length - 1];
      if (next !== undefined) this.select(next);
    }
    this.deps.onCount(this.sessions.size);
    if (rerender) this.render();
  }

  private select(id: number): void {
    if (!this.sessions.has(id)) return;
    this.activeId = id;
    for (const [sid, s] of this.sessions) s.host.hidden = sid !== id;
    this.render();
    this.fitActive();
    this.focusActive();
  }

  private render(): void {
    const list = this.deps.list;
    list.hidden = this.sessions.size < 2;
    list.replaceChildren();
    for (const [id, s] of this.sessions) {
      const item = document.createElement("div");
      item.className = "term-item";
      item.setAttribute("role", "tab");
      item.setAttribute("aria-selected", String(id === this.activeId));
      item.tabIndex = id === this.activeId ? 0 : -1;
      item.dataset.termId = String(id);
      const label = document.createElement("span");
      label.className = "term-item-label";
      label.textContent = s.exited ? `${s.info.title} ✕` : s.info.title;
      label.title = s.info.title;
      const close = document.createElement("button");
      close.className = "icon-btn term-item-close";
      close.type = "button";
      close.title = t("Kill terminal");
      close.setAttribute("aria-label", t("Kill terminal {0}", { 0: s.info.title }));
      close.innerHTML = glyph("x", "sm");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        this.deps.post({ type: "close", id });
      });
      item.append(label, close);
      item.addEventListener("click", () => this.select(id));
      item.addEventListener("keydown", (event) => {
        const ids = [...this.sessions.keys()];
        const at = ids.indexOf(id);
        let next: number | undefined;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") next = ids[(at + 1) % ids.length];
        else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = ids[(at - 1 + ids.length) % ids.length];
        else if (event.key === "Delete") this.deps.post({ type: "close", id });
        if (next !== undefined) {
          event.preventDefault();
          this.select(next);
          list.querySelector<HTMLElement>(`[data-term-id="${next}"]`)?.focus();
        }
      });
      list.appendChild(item);
    }
  }
}
