/**
 * The Output panel's Messages, Progress and Log tabs and the memory footer.
 * Data comes from main (services/outputPanel.ts) over `outApi`; nothing here
 * keeps state that main does not own, so a reload simply asks for a reset.
 */
import { t } from "../../shared/i18n";
import type { MemoryWire, OutToWebview, OutputEntryWire, ProgressItemWire } from "../../main/ipc";
import { formatClock, formatElapsed, memoryPressure, memoryText, nearBottom, percent } from "./outputFormat";

export interface OutputDeps {
  post: (message: unknown) => void;
  messages: HTMLElement;
  log: HTMLElement;
  progress: HTMLElement;
  memory: HTMLElement;
  /** Fired with the number of running Progress items and of unseen error messages. */
  onBadges: (progressRunning: number, errors: number) => void;
  onTab: (tab: "messages") => void;
}

type Level = "info" | "warn" | "error";

export class Output {
  private messageEntries: OutputEntryWire[] = [];
  private logEntries: OutputEntryWire[] = [];
  private items: ProgressItemWire[] = [];
  private levelFilter: Level | "all" = "all";
  private unseenErrors = 0;
  private visibleTab = "terminal";
  private clock: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: OutputDeps) {}

  handle(msg: OutToWebview): void {
    switch (msg.type) {
      case "reset":
        this.messageEntries = msg.messages;
        this.logEntries = msg.log;
        this.items = msg.progress;
        this.renderList(this.deps.messages, this.messageEntries, true);
        this.renderList(this.deps.log, this.logEntries, true);
        this.renderProgress();
        this.setMemory(msg.memory, msg.showMemory);
        break;
      case "messages":
        this.messageEntries.push(...msg.added);
        this.appendEntries(this.deps.messages, msg.added);
        if (this.visibleTab !== "messages") {
          this.unseenErrors += msg.added.filter((e) => e.level === "error").length;
          this.badges();
        }
        break;
      case "log":
        this.logEntries.push(...msg.added);
        this.appendEntries(this.deps.log, msg.added);
        break;
      case "progress":
        this.items = msg.items;
        this.renderProgress();
        break;
      case "memory":
        this.setMemory(msg.memory, msg.memory !== null);
        break;
      case "cleared":
        if (msg.which === "messages") this.messageEntries = [];
        else this.logEntries = [];
        this.renderList(msg.which === "messages" ? this.deps.messages : this.deps.log, [], true);
        break;
      case "tab":
        this.deps.onTab("messages");
        break;
    }
  }

  /** The panel's active tab changed: errors on the Messages tab count as seen. */
  setVisibleTab(tab: string): void {
    this.visibleTab = tab;
    if (tab === "messages") {
      this.unseenErrors = 0;
      this.pin(this.deps.messages);
    } else if (tab === "log") this.pin(this.deps.log);
    this.badges();
  }

  setLevelFilter(level: Level | "all"): void {
    this.levelFilter = level;
    this.renderList(this.deps.messages, this.messageEntries, true);
  }

  clear(which: "messages" | "log" | "progress"): void {
    this.deps.post({ type: "clear", which });
  }

  /** Plain text of the visible rows of a list, for its Copy button. */
  textOf(which: "messages" | "log"): string {
    const entries = which === "messages" ? this.messageEntries.filter((e) => this.passes(e)) : this.logEntries;
    return entries.map((e) => this.line(e)).join("\n");
  }

  copy(which: "messages" | "log"): void {
    this.deps.post({ type: "copy", text: this.textOf(which) });
  }

  // ---- lists ----------------------------------------------------------------

  private passes(e: OutputEntryWire): boolean {
    return this.levelFilter === "all" || e.level === this.levelFilter;
  }

  private line(e: OutputEntryWire): string {
    return `[${formatClock(e.at)}] ${e.level === "info" ? "" : `${e.level.toUpperCase()} `}${e.source}: ${e.text}`;
  }

  private row(e: OutputEntryWire): HTMLElement {
    const row = document.createElement("div");
    row.className = `out-row level-${e.level}`;
    row.dataset.entryId = String(e.id);
    const time = document.createElement("span");
    time.className = "out-time";
    time.textContent = `[${formatClock(e.at)}]`;
    time.title = e.at;
    const source = document.createElement("span");
    source.className = "out-source";
    source.textContent = e.source;
    const text = document.createElement("span");
    text.className = "out-text";
    text.textContent = e.text;
    row.append(time, source, text);
    return row;
  }

  private renderList(list: HTMLElement, entries: OutputEntryWire[], pinToEnd: boolean): void {
    const shown = list === this.deps.messages ? entries.filter((e) => this.passes(e)) : entries;
    list.replaceChildren(...shown.map((e) => this.row(e)));
    if (pinToEnd) list.scrollTop = list.scrollHeight;
    list.classList.toggle("empty", shown.length === 0);
  }

  private appendEntries(list: HTMLElement, added: OutputEntryWire[]): void {
    const wasPinned = nearBottom(list);
    const shown = list === this.deps.messages ? added.filter((e) => this.passes(e)) : added;
    for (const e of shown) list.appendChild(this.row(e));
    while (list.childElementCount > 2000) list.firstElementChild?.remove();
    if (shown.length) list.classList.remove("empty");
    // Follow the end only while the reader is there: scrolling up to read must not be undone.
    if (wasPinned) list.scrollTop = list.scrollHeight;
  }

  private pin(list: HTMLElement): void {
    list.scrollTop = list.scrollHeight;
  }

  // ---- progress -------------------------------------------------------------

  private renderProgress(): void {
    const host = this.deps.progress;
    const running = this.items.filter((i) => i.state === "running").length;
    host.classList.toggle("empty", this.items.length === 0);
    host.replaceChildren(...[...this.items].reverse().map((i) => this.progressRow(i)));
    this.badges();
    // Elapsed times tick while anything runs; no timer otherwise.
    if (running && !this.clock) this.clock = setInterval(() => this.tickElapsed(), 1000);
    else if (!running && this.clock) { clearInterval(this.clock); this.clock = null; }
  }

  private tickElapsed(): void {
    for (const el of this.deps.progress.querySelectorAll<HTMLElement>("[data-started]")) {
      el.textContent = formatElapsed(Date.now() - Number(el.dataset.started));
    }
  }

  private progressRow(item: ProgressItemWire): HTMLElement {
    const row = document.createElement("div");
    row.className = `prog-row state-${item.state}`;
    row.dataset.progressId = String(item.id);
    const head = document.createElement("div");
    head.className = "prog-head";
    const source = document.createElement("span");
    source.className = "out-source";
    source.textContent = item.source;
    const label = document.createElement("span");
    label.className = "prog-label";
    label.textContent = item.label;
    label.title = item.label;
    const elapsed = document.createElement("span");
    elapsed.className = "prog-elapsed";
    if (item.state === "running") {
      elapsed.dataset.started = String(item.startedAt);
      elapsed.textContent = formatElapsed(Date.now() - item.startedAt);
    } else {
      elapsed.textContent = formatElapsed((item.endedAt ?? item.startedAt) - item.startedAt);
    }
    head.append(source, label, elapsed);

    const bar = document.createElement("progress");
    bar.className = "prog-bar";
    bar.max = 100;
    const pct = percent(item);
    if (item.state === "running") {
      if (pct !== null) bar.value = pct; // no value attribute = the indeterminate animation
    } else bar.value = item.state === "done" ? 100 : pct ?? 0;
    bar.setAttribute("aria-label", item.label);

    const status = document.createElement("span");
    status.className = "prog-status";
    status.textContent =
      item.state === "running"
        ? item.cancelling ? t("Cancelling…") : pct !== null ? `${pct}%` : t("Working…")
        : item.state === "done" ? t("Done")
        : item.state === "cancelled" ? t("Cancelled")
        : `${t("Failed")}${item.detail ? `: ${item.detail}` : ""}`;

    const foot = document.createElement("div");
    foot.className = "prog-foot";
    foot.append(bar, status);
    if (item.state === "running" && item.cancellable) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-secondary btn-sm";
      cancel.textContent = t("Cancel");
      cancel.disabled = item.cancelling === true;
      cancel.addEventListener("click", () => this.deps.post({ type: "cancelProgress", id: item.id }));
      foot.append(cancel);
    }
    row.append(head, foot);
    return row;
  }

  private badges(): void {
    this.deps.onBadges(this.items.filter((i) => i.state === "running").length, this.unseenErrors);
  }

  // ---- memory ---------------------------------------------------------------

  private setMemory(memory: MemoryWire | null, show: boolean): void {
    const el = this.deps.memory;
    el.hidden = !show || memory === null;
    if (!memory) return;
    el.textContent = memoryText(memory, { app: t("App"), system: t("System") });
    el.title = t("Application memory (all processes) | system memory in use / total");
    el.classList.toggle("high", memoryPressure(memory) > 0.9);
  }
}
