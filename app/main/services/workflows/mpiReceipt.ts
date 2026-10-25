import type { Json, Receipt, Task, TaskState } from './contracts';

/**
 * Pure launch/receipt contract for a future MPI runner. Nothing wires it into the queue yet and
 * `EnvironmentReport.mpi` stays `false`: this fixes the shape a rank-set receipt must have so the
 * queue can reconcile it after a restart. Ambiguity always reads `uncertain`, never success.
 */
export type MpiLauncher = 'mpirun' | 'mpiexec' | 'srun';
export interface MpiLaunchIntent { ranks: number; threadsPerRank: number; launcher: MpiLauncher }
export type MpiState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
export interface MpiReceipt {
  version: 1; requestId: string; ownerId: string; launcher: MpiLauncher;
  ranks: number; threadsPerRank: number; state: MpiState;
  pid?: number; exitCode?: number; effectiveRanks?: number; message?: string;
}

const STATES: readonly MpiState[] = ['running', 'succeeded', 'failed', 'cancelled', 'uncertain'];
const LAUNCHERS: readonly MpiLauncher[] = ['mpirun', 'mpiexec', 'srun'];
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

function checkIntent(i: MpiLaunchIntent): void {
  if (!positive(i.ranks)) throw new Error('MPI ranks must be a positive integer.');
  if (!positive(i.threadsPerRank)) throw new Error('Threads per rank must be a positive integer.');
  if (!LAUNCHERS.includes(i.launcher)) throw new Error('Unknown MPI launcher.');
}

/** Total CPU slots, so the existing budget in `canDispatch` needs no per-rank notion. */
export function mpiResources(i: MpiLaunchIntent): NonNullable<Task['resources']> {
  checkIntent(i);
  const threads = i.ranks * i.threadsPerRank;
  if (!Number.isSafeInteger(threads)) throw new Error('MPI allocation is too large.');
  return { threads, verified: true };
}

/** Values to freeze into `task.args` so `planRevision` covers rank count and launcher. */
export function mpiPlanArgs(i: MpiLaunchIntent): { [key: string]: Json } {
  checkIntent(i);
  return { mpiRanks: i.ranks, mpiThreadsPerRank: i.threadsPerRank, mpiLauncher: i.launcher };
}

/** `undefined` for an unreadable receipt; throws when it belongs to another owner/request. */
export function parseMpiReceipt(raw: unknown, task: Pick<Task, 'id' | 'studyId'>): MpiReceipt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || r.requestId !== task.id || r.ownerId !== task.studyId) {
    throw new Error('MPI receipt belongs to a different request.');
  }
  if (!positive(r.ranks) || !positive(r.threadsPerRank) || !LAUNCHERS.includes(r.launcher as MpiLauncher)) return undefined;
  const state = STATES.includes(r.state as MpiState) ? (r.state as MpiState) : 'uncertain';
  const out: MpiReceipt = {
    version: 1, requestId: task.id, ownerId: task.studyId, launcher: r.launcher as MpiLauncher,
    ranks: r.ranks, threadsPerRank: r.threadsPerRank, state,
  };
  if (positive(r.pid)) out.pid = r.pid;
  if (typeof r.exitCode === 'number' && Number.isInteger(r.exitCode)) out.exitCode = r.exitCode;
  if (typeof r.effectiveRanks === 'number' && Number.isInteger(r.effectiveRanks)) out.effectiveRanks = r.effectiveRanks;
  if (typeof r.message === 'string') out.message = r.message;
  return out;
}

/**
 * Maps a parsed receipt (and, for `running`, whether the launcher process is alive) to a queue
 * receipt. A dead launcher with no terminal receipt, or a rank count that differs from the
 * request, is `uncertain`. Exit status alone never establishes numerical convergence.
 */
export function reconcileMpi(parsed: MpiReceipt | undefined, alive?: boolean): Receipt | undefined {
  if (!parsed) return undefined;
  let state: TaskState = parsed.state;
  let message = parsed.message;
  if (state === 'running' && alive === false) {
    state = 'uncertain';
    message = 'The MPI launcher is no longer running and wrote no final receipt.';
  } else if (parsed.effectiveRanks !== undefined && parsed.effectiveRanks !== parsed.ranks) {
    state = 'uncertain';
    message = `Requested ${parsed.ranks} ranks but ${parsed.effectiveRanks} were verified.`;
  } else if (state === 'succeeded') {
    message = message ?? 'MPI launcher exited 0; convergence is not established by exit status.';
  }
  const requested = parsed.ranks * parsed.threadsPerRank;
  return {
    version: 1, requestId: parsed.requestId, ownerId: parsed.ownerId, state, artifacts: [],
    resources: { requestedThreads: requested, ...(parsed.effectiveRanks !== undefined ? { effectiveThreads: parsed.effectiveRanks * parsed.threadsPerRank } : {}) },
    ...(message ? { message } : {}),
  };
}
