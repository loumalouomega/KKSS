import type { Json, Receipt, Task, TaskState } from './contracts';

/**
 * Pure launch/receipt contract for the MPI runner (`mpiRunner.ts`): it fixes the shape a rank-set
 * receipt must have so the queue can reconcile it after a restart. Ambiguity always reads `uncertain`, never success.
 */
/** Modules an MPI-enabled Kratos build must import; shared by the environment probe and the runner. */
export const MPI_MODULES = ['KratosMultiphysics.mpi', 'KratosMultiphysics.TrilinosApplication', 'KratosMultiphysics.MetisApplication'] as const;
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
 * receipt. A dead launcher with no terminal receipt, a live launcher with dead ranks, or a
 * succeeded run whose started-rank count differs from the request, is `uncertain`. Exit status alone never establishes numerical convergence.
 */
export function reconcileMpi(parsed: MpiReceipt | undefined, alive?: boolean, deadRanks = 0): Receipt | undefined {
  if (!parsed) return undefined;
  let state: TaskState = parsed.state;
  let message = parsed.message;
  if (state === 'running' && alive === false) {
    state = 'uncertain';
    message = 'The MPI launcher is no longer running and wrote no final receipt.';
  } else if (state === 'running' && deadRanks > 0) {
    state = 'uncertain';
    message = `${deadRanks} of ${parsed.ranks} MPI ranks are no longer running while the launcher is; cancel the run or resolve it on the host.`;
  } else if (state === 'succeeded' && parsed.effectiveRanks !== undefined && parsed.effectiveRanks !== parsed.ranks) {
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

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Detached `sh` script that owns the receipt of one MPI launch: `running` with its pid first, then
 * a terminal state when the launcher exits (a `cancel` marker turns that into `cancelled`). The
 * rank count is argv-quoted into the launcher line; `OMP_NUM_THREADS` carries threads per rank.
 * Each rank runs through a tiny wrapper that records `ranks/<rank>.pid` before `exec`ing the real
 * command (rank read from the launcher's environment; a launcher that exports none fails the run
 * rather than being guessed at). The terminal receipt's `effectiveRanks` is the number of ranks
 * that actually started, so a short rank set reads `uncertain`, never `succeeded`. Pids are only
 * meaningful on the launching node: this is a single-node contract.
 * Exit 0 is `succeeded` with the no-convergence note. `dir` holds `receipt.json` and `stdout.log`;
 * the command runs from `<dir>/input`.
 */
export function mpiRunScript(opts: {
  dir: string; requestId: string; ownerId: string; intent: MpiLaunchIntent; argv: readonly string[];
  env?: Readonly<Record<string, string>>;
}): string {
  checkIntent(opts.intent);
  if (!SAFE.test(opts.requestId) || !SAFE.test(opts.ownerId)) throw new Error('Unsafe request or owner id.');
  if (!opts.argv.length) throw new Error('MPI launch needs a command.');
  const envs = Object.entries(opts.env ?? {}).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || k === 'OMP_NUM_THREADS' || k === 'KKSS_RUN_DIR') throw new Error(`Invalid environment variable name: ${k}`);
    return `${k}=${shQuote(v)}`;
  });
  const { ranks, threadsPerRank, launcher } = opts.intent;
  const flag = launcher === 'srun' ? '-n' : '-np';
  const head = `{"version":1,"requestId":"${opts.requestId}","ownerId":"${opts.ownerId}","launcher":"${launcher}","ranks":${ranks},"threadsPerRank":${threadsPerRank}`;
  const rank = 'r=${OMPI_COMM_WORLD_RANK:-${PMI_RANK:-${PMIX_RANK:-$SLURM_PROCID}}}; [ -n "$r" ] || exit 97; echo $$ > "$KKSS_RUN_DIR/ranks/$r.pid"; exec "$@"';
  return [
    '#!/bin/sh',
    'trap : TERM',
    `d=$(cd ${shQuote(opts.dir)} 2>/dev/null && pwd) || exit 1`,
    `w() { printf '%s\\n' "$1" > "$d/receipt.json.tmp" && mv -f "$d/receipt.json.tmp" "$d/receipt.json"; }`,
    `w '${head},"state":"running","pid":'$$'}'`,
    'rm -rf "$d/ranks"; mkdir -p "$d/ranks"',
    `cd "$d/input" || { w '${head},"state":"failed","message":"Input directory is missing."}'; exit 1; }`,
    `KKSS_RUN_DIR="$d" OMP_NUM_THREADS=${threadsPerRank} ${envs.join(' ')} ${launcher} ${flag} ${ranks} sh -c ${shQuote(rank)} kkss-rank ${opts.argv.map(shQuote).join(' ')} > "$d/stdout.log" 2>&1`,
    'rc=$?',
    'n=$(ls "$d/ranks" 2>/dev/null | wc -l | tr -d " ")',
    `if [ -e "$d/cancel" ]; then w '${head},"state":"cancelled","exitCode":'$rc',"effectiveRanks":'$n'}'`,
    `elif [ $rc -eq 0 ]; then w '${head},"state":"succeeded","exitCode":0,"effectiveRanks":'$n',"message":"MPI launcher exited 0; convergence is not established by exit status."}'`,
    `else w '${head},"state":"failed","exitCode":'$rc',"effectiveRanks":'$n'}'; fi`,
    '',
  ].join('\n');
}
