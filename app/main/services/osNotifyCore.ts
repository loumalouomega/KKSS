/**
 * Operating-system notifications — the pure half. Which events deserve one and
 * what they say; `osNotify.ts` shows them. Nothing here reads or stores any
 * state beyond the previous task states it is handed.
 */
export type NoticeKind = "info" | "warning" | "error";
export interface Notice { title: string; body: string; kind: NoticeKind }

interface TaskLike { id: string; state: string }

/** States in which a task is still in flight. */
const ACTIVE = new Set(["waiting", "dispatching", "running"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "blocked", "uncertain"]);

/**
 * A notice when a plan that had work in flight has just settled, so one plan is
 * one notification rather than one per task. `before` is the previous task
 * states by id (empty when the queue was idle).
 */
export function planNotice(before: ReadonlyMap<string, string>, tasks: readonly TaskLike[]): Notice | undefined {
  const wasActive = [...before.values()].some(s => s === "dispatching" || s === "running");
  if (!wasActive || tasks.length === 0) return undefined;
  if (tasks.some(t => ACTIVE.has(t.state))) return undefined;
  if (!tasks.every(t => TERMINAL.has(t.state) || t.state === "held")) return undefined;
  const states = tasks.map(t => t.state);
  if (states.includes("uncertain")) return { kind: "warning", title: "Queue finished uncertain", body: "A task ended uncertain and is never retried automatically. Inspect its receipt." };
  if (states.some(s => s === "failed" || s === "blocked" || s === "held")) return { kind: "error", title: "Queue failed", body: "At least one task did not succeed." };
  if (states.every(s => s === "cancelled")) return undefined;
  return { kind: "info", title: "Queue finished", body: "Every task succeeded." };
}

/** A Kratos MCP job reaching a terminal state; `undefined` for anything else, including history. */
export function jobNotice(job: { state: string; case_dir: string }, name: string): Notice | undefined {
  if (job.state === "succeeded") return { kind: "info", title: "Kratos job finished", body: `${name} succeeded.` };
  if (job.state === "failed") return { kind: "error", title: "Kratos job failed", body: `${name} failed.` };
  return undefined;
}

/** The only gate: the setting, a window that is not focused, and no e2e run. */
export function shouldShow(enabled: boolean, windowFocused: boolean, e2e: boolean): boolean {
  return enabled && !windowFocused && !e2e;
}
