// The Output panel's data model — the pure half (Messages, Log, Progress, memory).
// Nothing here touches Electron, disk or the network, and nothing here may
// throw: callers are logging hooks sprinkled through code that must not fail
// because a message could not be recorded. Same shape as eventLogCore.ts.
import { capText, scrubSecrets } from "./eventLogCore";

export type EntryLevel = "info" | "warn" | "error";

/** Where an entry came from; free text so new sources need no schema change. */
export type EntrySource = string;

export interface OutputEntry {
  /** Monotonic per log, so the renderer can append without re-reading. */
  id: number;
  /** ISO-8601 UTC. */
  at: string;
  level: EntryLevel;
  source: EntrySource;
  text: string;
}

export const MESSAGE_CAPACITY = 2000;
export const LOG_CAPACITY = 5000;
export const MAX_ENTRY_CHARS = 2000;

/** Bounded, append-only list of timestamped entries with change subscription. */
export class EntryLog {
  private items: OutputEntry[] = [];
  private nextId = 1;
  private listeners = new Set<(entry: OutputEntry) => void>();
  constructor(readonly capacity: number, private now: () => Date = () => new Date()) {}

  add(level: EntryLevel, source: EntrySource, text: string): void {
    try {
      const entry: OutputEntry = {
        id: this.nextId++,
        at: this.now().toISOString(),
        level,
        source: capText(String(source), 40),
        text: capText(scrubSecrets(String(text)), MAX_ENTRY_CHARS),
      };
      this.items.push(entry);
      if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
      for (const listener of this.listeners) {
        try { listener(entry); } catch { /* a listener must never break logging */ }
      }
    } catch { /* logging must never throw */ }
  }

  snapshot(): OutputEntry[] { return this.items.slice(); }
  get size(): number { return this.items.length; }
  clear(): void { this.items = []; }
  subscribe(listener: (entry: OutputEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Plain text, one entry per line — what the Copy button puts on the clipboard. */
export function entriesToText(entries: readonly OutputEntry[]): string {
  return entries.map((e) => `[${e.at}] ${e.level === "info" ? "" : `${e.level.toUpperCase()} `}${e.source}: ${e.text}`).join("\n");
}

// ---- Progress ---------------------------------------------------------------

export type ProgressState = "running" | "done" | "failed" | "cancelled";

export interface ProgressItem {
  id: number;
  source: EntrySource;
  label: string;
  state: ProgressState;
  /** 0..1, or null when the work cannot say how far along it is. */
  fraction: number | null;
  startedAt: number;
  endedAt?: number;
  detail?: string;
  cancellable: boolean;
  /** Set while a cancel has been requested but the work has not stopped yet. */
  cancelling?: boolean;
}

export interface ProgressStart {
  source: EntrySource;
  label: string;
  /** Stable key for state-driven sources (queue tasks, jobs): a second `begin` with the same running key updates instead of duplicating. */
  key?: string;
  fraction?: number | null;
  cancel?: () => void;
}

export const FINISHED_RETAINED = 20;

export class ProgressRegistry {
  private items: ProgressItem[] = [];
  private cancels = new Map<number, () => void>();
  private keys = new Map<string, number>();
  private nextId = 1;
  private listeners = new Set<() => void>();
  constructor(private now: () => number = () => Date.now()) {}

  /** Returns the item id; never throws. */
  begin(start: ProgressStart): number {
    try {
      const existing = start.key !== undefined ? this.keys.get(start.key) : undefined;
      if (existing !== undefined && this.get(existing)?.state === "running") {
        this.update(existing, { label: start.label, fraction: start.fraction });
        return existing;
      }
      const id = this.nextId++;
      this.items.push({
        id,
        source: capText(String(start.source), 40),
        label: capText(String(start.label), 200),
        state: "running",
        fraction: normalizeFraction(start.fraction),
        startedAt: this.now(),
        cancellable: typeof start.cancel === "function",
      });
      if (start.cancel) this.cancels.set(id, start.cancel);
      if (start.key !== undefined) this.keys.set(start.key, id);
      this.trim();
      this.emit();
      return id;
    } catch {
      return -1;
    }
  }

  update(id: number, patch: { label?: string; fraction?: number | null }): void {
    try {
      const item = this.get(id);
      if (!item || item.state !== "running") return;
      let changed = false;
      if (patch.label !== undefined && patch.label !== item.label) { item.label = capText(String(patch.label), 200); changed = true; }
      if ("fraction" in patch && patch.fraction !== undefined) {
        const next = normalizeFraction(patch.fraction);
        if (next !== item.fraction) { item.fraction = next; changed = true; }
      }
      if (changed) this.emit();
    } catch { /* never throw */ }
  }

  finish(id: number, state: Exclude<ProgressState, "running"> = "done", detail?: string): void {
    try {
      const item = this.get(id);
      if (!item || item.state !== "running") return;
      item.state = state;
      item.endedAt = this.now();
      item.cancelling = undefined;
      if (state === "done") item.fraction = 1;
      if (detail) item.detail = capText(scrubSecrets(detail), 300);
      this.cancels.delete(id);
      for (const [key, value] of this.keys) if (value === id) this.keys.delete(key);
      this.trim();
      this.emit();
    } catch { /* never throw */ }
  }

  finishKey(key: string, state: Exclude<ProgressState, "running"> = "done", detail?: string): void {
    const id = this.keys.get(key);
    if (id !== undefined) this.finish(id, state, detail);
  }

  /** Asks the work to stop. The work reports `cancelled` itself via `finish`; a cancel that throws is reported as a failure. */
  cancel(id: number): boolean {
    const item = this.get(id);
    const cancel = this.cancels.get(id);
    if (!item || item.state !== "running" || !cancel) return false;
    item.cancelling = true;
    this.emit();
    try {
      cancel();
    } catch (error) {
      this.finish(id, "failed", error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  clearFinished(): void {
    this.items = this.items.filter((i) => i.state === "running");
    this.emit();
  }

  snapshot(): ProgressItem[] { return this.items.map((i) => ({ ...i })); }
  get activeCount(): number { return this.items.filter((i) => i.state === "running").length; }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private get(id: number): ProgressItem | undefined { return this.items.find((i) => i.id === id); }
  private trim(): void {
    const finished = this.items.filter((i) => i.state !== "running");
    const drop = finished.length - FINISHED_RETAINED;
    if (drop > 0) {
      const dropIds = new Set(finished.slice(0, drop).map((i) => i.id));
      this.items = this.items.filter((i) => !dropIds.has(i.id));
    }
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a listener must never break progress reporting */ }
    }
  }
}

function normalizeFraction(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

// ---- Memory -----------------------------------------------------------------

export interface MemorySample {
  /** Working set of every process Electron manages (main, viewers, GPU, workers). */
  appBytes: number;
  /** System memory in use (total − available). */
  usedBytes: number;
  totalBytes: number;
}

export interface ProcessMetric { memory?: { workingSetSize?: number } }

/** `getAppMetrics()` reports the working set in KiB. */
export function sampleMemory(metrics: readonly ProcessMetric[], totalBytes: number, freeBytes: number): MemorySample {
  const appKiB = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0);
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const free = Number.isFinite(freeBytes) ? Math.min(Math.max(freeBytes, 0), total) : 0;
  return { appBytes: appKiB * 1024, usedBytes: total - free, totalBytes: total };
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
