/**
 * `kkss --headless study run <project>`: run a study's
 * already-persisted queue plan without a window and report JSON. Electron-free
 * so the whole flow is tested against a fake workflow; `studyRunCli.ts` wires
 * the real `WorkflowService`.
 *
 * Two invariants decide the design. It never starts work that was not already
 * persisted: it resumes the exact plan revision found in `.kkss/project.json`
 * (an explicit `--plan` must equal it) and never previews or enqueues anything.
 * And exit code 0 means every task finished `succeeded` — a process exit is not
 * numerical convergence, so the report carries each run's convergence state
 * from the review and `--require-converged` turns "not established" into a
 * failure.
 */
import { planRevision } from "../services/workflows/queue";
import type { Task } from "../services/workflows/contracts";

export const EXIT = {
  ok: 0,
  failed: 1,
  uncertain: 2,
  usage: 3,
  refused: 4,
  timeout: 5,
  notConverged: 6,
} as const;

export interface CliOptions {
  project: string;
  study?: string;
  plan?: string;
  /** Wall-clock limit for the whole run; on expiry the queue is paused and running tasks are cancelled. */
  timeoutSeconds: number;
  /** A saved `state.json` read (never written) for the Kratos runtime settings the plan was frozen with. */
  settings?: string;
  python?: string;
  /** Also write the JSON report here (a GUI-subsystem Windows build has no stdout). */
  output?: string;
  review: boolean;
  requireConverged: boolean;
  userDataDir?: string;
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

const VALUE_FLAGS = new Set(["--study", "--plan", "--timeout", "--settings", "--python", "--output", "--user-data-dir"]);
const BOOL_FLAGS = new Set(["--no-review", "--require-converged"]);
const DEFAULT_TIMEOUT_SECONDS = 24 * 3600;

/** `undefined` when argv is not a headless command at all; a failed parse says what to fix. */
export function parseHeadlessCli(argv: readonly string[]): ParseResult | undefined {
  const at = argv.indexOf("--headless");
  if (at < 0) return undefined;
  const rest = argv.slice(at + 1);
  if (rest[0] !== "study" || rest[1] !== "run") return { ok: false, error: "Usage: kkss --headless study run <project> [--study <id>] [--plan <revision>] [--timeout <seconds>] [--settings <state.json>] [--python <path>] [--output <file>] [--no-review] [--require-converged] [--user-data-dir <dir>]" };
  const positional: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 2; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (BOOL_FLAGS.has(name)) { flags.add(name); continue; }
    if (VALUE_FLAGS.has(name)) {
      const value = eq > 0 && arg.startsWith("--") ? arg.slice(eq + 1) : rest[++i];
      if (value === undefined || value === "" || value.startsWith("--")) return { ok: false, error: `${name} needs a value.` };
      values.set(name, value);
      continue;
    }
    if (arg.startsWith("--")) return { ok: false, error: `Unknown option ${arg}.` };
    positional.push(arg);
  }
  if (positional.length !== 1) return { ok: false, error: "Give exactly one project folder." };
  const timeoutText = values.get("--timeout");
  const timeout = timeoutText === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(timeoutText);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 30 * 24 * 3600) return { ok: false, error: "--timeout must be a positive number of seconds (at most 30 days)." };
  return {
    ok: true,
    options: {
      project: positional[0],
      ...(values.has("--study") ? { study: values.get("--study") } : {}),
      ...(values.has("--plan") ? { plan: values.get("--plan") } : {}),
      timeoutSeconds: timeout,
      ...(values.has("--settings") ? { settings: values.get("--settings") } : {}),
      ...(values.has("--python") ? { python: values.get("--python") } : {}),
      ...(values.has("--output") ? { output: values.get("--output") } : {}),
      review: !flags.has("--no-review"),
      requireConverged: flags.has("--require-converged"),
      ...(values.has("--user-data-dir") ? { userDataDir: values.get("--user-data-dir") } : {}),
    },
  };
}

/** What the runner needs of the workflow service; the real one is `WorkflowService`. */
export interface HeadlessWorkflow {
  snapshot(): Promise<unknown>;
  /** Invokes `app__<tool>`; throws on an error result. */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface Clock { now(): number; sleep(ms: number): Promise<void> }

export interface TaskReport {
  id: string;
  studyId: string;
  runId: string;
  kind: string;
  state: string;
  message?: string;
  artifacts: number;
}
export interface RunReport {
  studyId: string;
  runId: string;
  state: string;
  convergence?: string;
  findings?: { severity: string; message: string }[];
  review?: "built" | "unavailable";
  reviewError?: string;
}
export interface StudyRunReport {
  version: 1;
  project: string;
  outcome: "succeeded" | "failed" | "uncertain" | "refused" | "timeout" | "not-converged" | "error";
  exitCode: number;
  /** Set once the plan was resumed; absent when nothing was started. */
  planRevision?: string;
  started: boolean;
  message?: string;
  tasks: TaskReport[];
  runs: RunReport[];
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "blocked", "uncertain"]);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const report = (project: string, outcome: StudyRunReport["outcome"], exitCode: number, message: string, extra: Partial<StudyRunReport> = {}): StudyRunReport =>
  ({ version: 1, project, outcome, exitCode, started: false, message, tasks: [], runs: [], ...extra });

function readProject(snapshot: unknown): { tasks: Task[]; studies: { id: string; runs: { id: string; state: string }[] }[] } | undefined {
  const project = record(snapshot) && record(snapshot.project) ? snapshot.project : undefined;
  if (!project || !record(project.queue) || !Array.isArray(project.queue.tasks) || !Array.isArray(project.studies)) return undefined;
  const studies = (project.studies as unknown[]).filter(record).map((s) => ({
    id: str(s.id) ?? "",
    runs: (Array.isArray(s.runs) ? (s.runs as unknown[]) : []).filter(record).map((r) => ({ id: str(r.id) ?? "", state: str(r.state) ?? "unknown" })),
  }));
  return { tasks: project.queue.tasks as Task[], studies };
}

const taskReport = (t: Task): TaskReport => ({
  id: t.id, studyId: t.studyId, runId: t.runId, kind: t.kind, state: t.state,
  ...(t.receipt?.message ? { message: t.receipt.message } : t.error ? { message: t.error } : {}),
  artifacts: t.receipt?.artifacts?.length ?? 0,
});

export async function runStudy(workflow: HeadlessWorkflow, options: CliOptions, clock: Clock, pollMs = 2000): Promise<StudyRunReport> {
  const fail = (outcome: StudyRunReport["outcome"], exit: number, message: string, extra: Partial<StudyRunReport> = {}) => report(options.project, outcome, exit, message, extra);
  let read = readProject(await workflow.snapshot());
  if (!read) return fail("error", EXIT.usage, "The project folder holds no KKSS project (.kkss/project.json).");
  if (options.study && !read.studies.some((s) => s.id === options.study)) return fail("error", EXIT.usage, `Unknown study ${options.study}.`);
  if (read.tasks.length === 0) return fail("refused", EXIT.refused, "The project has no persisted queue plan; this command never creates one. Preview and enqueue a plan in KKSS first.");
  const revision = planRevision(read.tasks);
  if (options.plan && options.plan !== revision) {
    return fail("refused", EXIT.refused, `The persisted plan revision is ${revision}, not ${options.plan}; nothing was started.`, { planRevision: revision });
  }
  const scoped = (tasks: Task[]) => (options.study ? tasks.filter((t) => t.studyId === options.study) : tasks);
  const waiting = read.tasks.some((t) => t.state === "waiting" || t.state === "held");
  let started = false;
  if (waiting) {
    try { await workflow.call("queue_resume", { planRevision: revision }); started = true; }
    catch (error) { return fail("refused", EXIT.refused, `The plan was refused: ${(error as Error).message}`, { planRevision: revision }); }
  }

  // After a resume a task still `held` was refused by validation (the reason is on the task); `waiting`, `dispatching` and `running` are in flight.
  const settled = (t: Task) => TERMINAL.has(t.state) || (started && t.state === "held");
  const deadline = clock.now() + options.timeoutSeconds * 1000;
  let timedOut = false;
  for (;;) {
    read = readProject(await workflow.snapshot()) ?? read;
    if (scoped(read.tasks).every(settled)) break;
    if (clock.now() >= deadline) { timedOut = true; break; }
    await clock.sleep(pollMs);
  }
  if (timedOut) {
    // Leave nothing running behind a process that is about to exit.
    try { await workflow.call("queue_pause", {}); } catch { /* best effort */ }
    for (const t of scoped(read.tasks).filter((x) => x.state === "running" || x.state === "dispatching")) {
      try { await workflow.call("queue_cancel", { taskId: t.id }); } catch { /* reported through the task state below */ }
    }
    read = readProject(await workflow.snapshot()) ?? read;
  }

  const tasks = scoped(read.tasks);
  const runIds = [...new Set(tasks.filter((t) => t.kind === "solve").map((t) => `${t.studyId}\u0000${t.runId}`))];
  const runs: RunReport[] = [];
  for (const key of runIds) {
    const [studyId, runId] = key.split("\u0000");
    const state = read.studies.find((s) => s.id === studyId)?.runs.find((r) => r.id === runId)?.state ?? "unknown";
    const entry: RunReport = { studyId, runId, state };
    if (options.review && state !== "unknown" && TERMINAL.has(state)) {
      try {
        const review = await workflow.call("run_review", { studyId, runId });
        const evidence = record(review) && record(review.evidence) ? review.evidence : undefined;
        const findings = Array.isArray(evidence?.findings) ? (evidence!.findings as unknown[]).filter(record).map((f) => ({ severity: str(f.severity) ?? "unavailable", message: str(f.message) ?? "" })) : [];
        const convergence = record(evidence?.convergence) ? str(evidence!.convergence.state) : undefined;
        entry.review = "built"; entry.findings = findings;
        if (convergence) entry.convergence = convergence;
      } catch (error) { entry.review = "unavailable"; entry.reviewError = (error as Error).message; }
    }
    runs.push(entry);
  }

  const states = tasks.map((t) => t.state);
  let outcome: StudyRunReport["outcome"], exitCode: number, message: string;
  if (timedOut) { outcome = "timeout"; exitCode = EXIT.timeout; message = `Timed out after ${options.timeoutSeconds} s; the queue was paused and running tasks were cancelled.`; }
  else if (states.includes("uncertain")) { outcome = "uncertain"; exitCode = EXIT.uncertain; message = "A task ended uncertain; it is never retried automatically. Inspect its receipt before running again."; }
  else if (states.some((s) => s !== "succeeded")) { outcome = "failed"; exitCode = EXIT.failed; message = "At least one task did not succeed."; }
  else if (options.requireConverged && runs.some((r) => r.convergence !== "converged")) { outcome = "not-converged"; exitCode = EXIT.notConverged; message = "Every task succeeded but numerical convergence was not established for every run."; }
  else { outcome = "succeeded"; exitCode = EXIT.ok; message = "Every task succeeded. This does not by itself establish numerical convergence; see each run's convergence state."; }
  return { version: 1, project: options.project, outcome, exitCode, planRevision: revision, started, message, tasks: tasks.map(taskReport), runs };
}
