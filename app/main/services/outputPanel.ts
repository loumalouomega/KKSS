/**
 * The Output panel's data side: streams the Messages/Log rings, the Progress
 * registry and the memory readout to the bottom panel's renderer
 * (app/renderer/terminal/) over out:toHost / out:toWebview. The terminals ride
 * the same view but their own channel (terminal.ts). All the logic lives in
 * outputCore.ts / outputBus.ts; this file is only Electron glue.
 */
import { app, clipboard, ipcMain, type WebContents } from "electron";
import * as os from "node:os";
import type { MemoryWire, OutToHost, OutToWebview, OutputEntryWire, ProgressItemWire } from "../ipc";
import { messageLog, outputLog, progress } from "./outputBus";
import { sampleMemory, type OutputEntry } from "./outputCore";

const FLUSH_MS = 100;
const MEMORY_MS = 2000;
/** The renderer is untrusted: Copy text is bounded before it reaches the clipboard. */
const MAX_COPY_CHARS = 5_000_000;

const wire = (e: OutputEntry): OutputEntryWire => ({ id: e.id, at: e.at, level: e.level, source: e.source, text: e.text });

export interface OutputPanelDeps {
  /** Settings ▸ Terminal ▸ memory readout. */
  showMemory: () => boolean;
  /** Settings ▸ Terminal ▸ open the panel on an error. */
  autoReveal: () => boolean;
  /** Opens the panel (no-op when it already is). */
  reveal: () => void;
  panelVisible: () => boolean;
}

export class OutputPanel {
  private target: WebContents | null = null;
  private ready = false;
  private visible = false;
  private pendingTab: OutToWebview | null = null;
  private queued: { messages: OutputEntryWire[]; log: OutputEntryWire[]; progress: boolean } = { messages: [], log: [], progress: false };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: OutputPanelDeps) {
    ipcMain.on("out:toHost", (event, raw) => {
      if (!this.target || event.sender !== this.target) return;
      this.onMessage(raw as OutToHost);
    });
    this.unsubscribe.push(
      messageLog.subscribe((entry) => {
        this.queued.messages.push(wire(entry));
        this.schedule();
        if (entry.level === "error" && this.deps.autoReveal()) this.revealMessages();
      }),
      outputLog.subscribe((entry) => {
        this.queued.log.push(wire(entry));
        this.schedule();
      }),
      progress.subscribe(() => {
        this.queued.progress = true;
        this.schedule();
      })
    );
    app.on("will-quit", () => this.dispose());
  }

  attach(target: WebContents): void {
    if (this.target !== target) this.ready = false;
    this.target = target;
  }

  /** Called when the panel is shown or hidden: memory is only sampled while it is on screen. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.syncMemoryTimer();
  }

  /** Brings the Messages tab forward, opening the panel when it is hidden. */
  revealMessages(): void {
    this.pendingTab = { type: "tab", tab: "messages" };
    if (!this.deps.panelVisible()) this.deps.reveal();
    else this.flushTab();
  }

  private onMessage(msg: OutToHost): void {
    switch (msg.type) {
      case "outReady":
        this.ready = true;
        this.send({
          type: "reset",
          messages: messageLog.snapshot().map(wire),
          log: outputLog.snapshot().map(wire),
          progress: progress.snapshot() as ProgressItemWire[],
          memory: this.sample(),
          showMemory: this.deps.showMemory(),
        });
        this.queued = { messages: [], log: [], progress: false };
        this.flushTab();
        this.syncMemoryTimer();
        break;
      case "clear":
        if (msg.which === "messages") { messageLog.clear(); this.send({ type: "cleared", which: "messages" }); }
        else if (msg.which === "log") { outputLog.clear(); this.send({ type: "cleared", which: "log" }); }
        else progress.clearFinished();
        break;
      case "cancelProgress":
        if (Number.isSafeInteger(msg.id)) progress.cancel(msg.id);
        break;
      case "copy":
        if (typeof msg.text === "string" && msg.text.length <= MAX_COPY_CHARS) clipboard.writeText(msg.text);
        break;
    }
  }

  private flushTab(): void {
    if (this.pendingTab && this.ready) {
      this.send(this.pendingTab);
      this.pendingTab = null;
    }
  }

  private send(message: OutToWebview): void {
    if (this.target && !this.target.isDestroyed()) this.target.send("out:toWebview", message);
  }

  private schedule(): void {
    if (this.flushTimer || !this.ready) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const q = this.queued;
      this.queued = { messages: [], log: [], progress: false };
      try {
        if (q.messages.length) this.send({ type: "messages", added: q.messages });
        if (q.log.length) this.send({ type: "log", added: q.log });
        if (q.progress) this.send({ type: "progress", items: progress.snapshot() as ProgressItemWire[] });
      } catch (error) {
        console.error("Output panel update failed", error);
      }
    }, FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private sample(): MemoryWire | null {
    if (!this.deps.showMemory()) return null;
    try {
      return sampleMemory(app.getAppMetrics(), os.totalmem(), os.freemem());
    } catch {
      return null;
    }
  }

  private syncMemoryTimer(): void {
    const want = this.visible && this.ready;
    if (want && !this.memoryTimer) {
      this.memoryTimer = setInterval(() => this.send({ type: "memory", memory: this.sample() }), MEMORY_MS);
      this.memoryTimer.unref?.();
      this.send({ type: "memory", memory: this.sample() });
    } else if (!want && this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
  }

  dispose(): void {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.memoryTimer = this.flushTimer = null;
    for (const off of this.unsubscribe.splice(0)) off();
  }
}
