// Bounded in-memory diagnostics history (roadmap item 22) — the pure half.
// Holds recent view crash / unresponsive events and a tail of main-process
// warn/error output so Help ▸ Export Diagnostics… has something to report.
// Nothing here touches disk or the network, and nothing here may throw.

export const MAX_EVENTS = 100;
export const MAX_LOG_LINES = 200;
export const MAX_LINE_CHARS = 500;
export const MAX_EVENT_TEXT = 200;

export interface DiagEvent {
  at: string;
  kind: "crash" | "unresponsive" | "responsive" | "unresponsive-answer";
  view: string;
  detail?: string;
}

/** Fixed-capacity FIFO: the oldest entry is dropped first. */
export class Ring<T> {
  private items: T[] = [];
  constructor(readonly capacity: number) {}
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  snapshot(): T[] { return this.items.slice(); }
  get size(): number { return this.items.length; }
  clear(): void { this.items = []; }
}

/** Mask credential-shaped tokens before they can enter the buffer. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <SECRET>")
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, "<SECRET>")
    .replace(/\b(api[-_]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, "$1$2<SECRET>");
}

export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [+${text.length - max} chars]` : text;
}

/** One console argument as text; never throws (cyclic objects, getters, …). */
export function formatArg(arg: unknown): string {
  try {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
    if (typeof arg === "object" && arg !== null) return JSON.stringify(arg) ?? String(arg);
    return String(arg);
  } catch {
    return "[unprintable]";
  }
}

export class EventLog {
  private eventRing = new Ring<DiagEvent>(MAX_EVENTS);
  private lineRing = new Ring<string>(MAX_LOG_LINES);
  constructor(private now: () => Date = () => new Date()) {}

  event(kind: DiagEvent["kind"], view: string, detail?: string): void {
    try {
      this.eventRing.push({
        at: this.now().toISOString(),
        kind,
        view: capText(scrubSecrets(String(view)), MAX_EVENT_TEXT),
        ...(detail ? { detail: capText(scrubSecrets(String(detail)), MAX_EVENT_TEXT) } : {}),
      });
    } catch { /* logging must never throw */ }
  }

  /** Record one console call; a multi-line message becomes several capped lines. */
  log(level: "warn" | "error", args: readonly unknown[]): void {
    try {
      const stamp = this.now().toISOString();
      const text = scrubSecrets(args.map(formatArg).join(" "));
      for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        this.lineRing.push(`${stamp} [${level}] ${capText(raw, MAX_LINE_CHARS)}`);
      }
    } catch { /* logging must never throw */ }
  }

  events(): DiagEvent[] { return this.eventRing.snapshot(); }
  tail(): string[] { return this.lineRing.snapshot(); }
}
