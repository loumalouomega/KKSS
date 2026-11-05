/** Pure formatting for the Output panel's Messages / Progress / Log lists. */
import type { MemoryWire, ProgressItemWire } from "../../main/ipc";

/** `12:35:07` in the user's local time; falls back to the raw text for a bad stamp. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `1.7 s`, `2 min 5 s`: elapsed time for a progress row. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  if (s < 60) return `${s.toFixed(1)} s`;
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const rest = total % 60;
  if (m < 60) return `${m} min ${rest} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function percent(item: Pick<ProgressItemWire, "fraction">): number | null {
  return item.fraction === null ? null : Math.round(item.fraction * 100);
}

const GB = 1024 ** 3;
const gb = (bytes: number) => (bytes / GB).toFixed(2);

/** The footer text: `App 0.68 GB | System 9.40 / 31.20 GB`. Labels come from the caller (translated). */
export function memoryText(memory: MemoryWire, labels: { app: string; system: string }): string {
  return `${labels.app} ${gb(memory.appBytes)} GB | ${labels.system} ${gb(memory.usedBytes)} / ${gb(memory.totalBytes)} GB`;
}

/** Share of system memory in use, 0..1 — drives the footer's warning colour. */
export function memoryPressure(memory: MemoryWire): number {
  return memory.totalBytes > 0 ? memory.usedBytes / memory.totalBytes : 0;
}

/** Whether a scrollable list is close enough to its end that new rows should keep it pinned there. */
export function nearBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}
