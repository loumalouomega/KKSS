/**
 * Runs a queued solve as one MPI launch, on this machine or on the ssh host. Every effect goes
 * through an injected `SshRunner` (a local `sh` stand-in for this machine), so the same
 * dispatch/lookup/cancel code serves both and tests need no real launcher. Intent is persisted by
 * ExecutionQueue before dispatch(); any ambiguity after the launch command throws, so the queue
 * records `uncertain` and never retries. Single-node: rank liveness is checked by pid.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SshResult, SshRunOptions, SshRunner } from '../cloud/providers/ssh';
import { aliveCommand, cancelCommand, cpuCountCommand, mkdirCommand, readReceiptCommand, shQuote, uploadCommand } from '../cloud/providerCore/sshCore';
import type { Receipt, Task } from './contracts';
import { distributeProjectParameters } from './mpiCase';
import { MPI_MODULES, mpiRunScript, parseMpiReceipt, reconcileMpi, type MpiLaunchIntent } from './mpiReceipt';
import type { ProjectStore } from './project';
import type { Runner } from './queue';
import { fetchRunArtifacts, RemoteRunner, type RemoteSolveSpec } from './remoteRunner';

export interface MpiSolveSpec extends RemoteSolveSpec { intent: MpiLaunchIntent }
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

/** `sh -c` on this machine with the `SshRunner` contract (stdin/stdout file piping). */
export const runLocalSh: SshRunner = (_host: string, command: string, options: SshRunOptions = {}) =>
  new Promise<SshResult>((resolve) => {
    const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const sink = options.stdoutFile ? fs.createWriteStream(options.stdoutFile) : undefined;
    if (sink) child.stdout.pipe(sink); else child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', e => resolve({ code: 127, stdout, stderr: String(e) }));
    if (options.stdinFile) fs.createReadStream(options.stdinFile).pipe(child.stdin); else child.stdin.end();
    child.on('close', code => { if (sink) sink.end(() => resolve({ code: code ?? 1, stdout, stderr })); else resolve({ code: code ?? 1, stdout, stderr }); });
  });

/** setsid where it exists (Linux), plain nohup elsewhere; cancel then falls back to the pid alone. */
export const mpiLaunchCommand = (dir: string): string =>
  `d=${shQuote(dir)}; rm -f -- "$d/cancel"; if command -v setsid >/dev/null 2>&1; then setsid nohup sh "$d/run.sh" >/dev/null 2>&1 </dev/null & else nohup sh "$d/run.sh" >/dev/null 2>&1 </dev/null & fi`;
/** Prints `up <n> down <m>` for the recorded rank pids. */
export const ranksAliveCommand = (dir: string): string =>
  `u=0; x=0; for f in ${shQuote(dir)}/ranks/*.pid; do [ -e "$f" ] || continue; if kill -0 "$(cat "$f")" 2>/dev/null; then u=$((u+1)); else x=$((x+1)); fi; done; echo "up $u down $x"`;

export class MpiRunner implements Pick<Runner, 'validate' | 'dispatch' | 'lookup' | 'cancel'> {
  constructor(private readonly host: string, private readonly exec: SshRunner,
    private readonly spec: (task: Task, store: ProjectStore) => MpiSolveSpec,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  /** CPU count from the last successful probe, for the shared queue budget. */
  static lastCpuCount?: number;
  private base(task: Task) { return { version: 1 as const, requestId: task.id, ownerId: task.studyId, artifacts: [] }; }
  async validate(task: Task, store: ProjectStore): Promise<string[]> {
    const { argv, intent, inputDir } = this.spec(task, store);
    const run = (c: string) => this.exec(this.host, c).catch(() => undefined);
    const where = this.host || 'this machine';
    const errors: string[] = [];
    if ((await run(`command -v ${shQuote(intent.launcher)} >/dev/null`))?.code !== 0) errors.push(`MPI launcher '${intent.launcher}' was not found on ${where}.`);
    for (const mod of MPI_MODULES) {
      if ((await run(`${shQuote(argv[0])} -c ${shQuote(`import ${mod}`)}`))?.code !== 0) errors.push(`${mod} is not importable by ${argv[0]} on ${where}; an MPI-enabled Kratos build is required.`);
    }
    const cpus = Number((await run(cpuCountCommand()))?.stdout.trim());
    if (Number.isSafeInteger(cpus) && cpus > 0) {
      MpiRunner.lastCpuCount = cpus;
      if (this.host) RemoteRunner.lastCpuCount = cpus; // the shared queue budget reads the host's CPUs
      if (intent.ranks * intent.threadsPerRank > cpus) errors.push(`The plan asks for ${intent.ranks} ranks × ${intent.threadsPerRank} threads but ${where} has ${cpus} CPUs; approve a new plan.`);
    } else errors.push(`Could not determine the CPU count of ${where}.`);
    try {
      const verdict = distributeProjectParameters(await fsp.readFile(path.join(inputDir, 'ProjectParameters.json'), 'utf8'));
      if (!verdict.ok) errors.push(verdict.reason);
    } catch { errors.push('ProjectParameters.json is missing; complete the generation task first.'); }
    return errors;
  }
  async dispatch(task: Task, store: ProjectStore): Promise<Receipt> {
    const spec = this.spec(task, store);
    const fail = (message: string): Receipt => ({ ...this.base(task), state: 'failed', message });
    // Everything before the launch command is retry-safe: nothing is running yet.
    try {
      const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'kkss-mpi-'));
      const run = path.join(staging, 'run.sh');
      await fsp.writeFile(run, mpiRunScript({ dir: spec.remoteDir, requestId: task.id, ownerId: task.studyId, intent: spec.intent, argv: spec.argv, env: spec.env }));
      const verdict = distributeProjectParameters(await fsp.readFile(path.join(spec.inputDir, 'ProjectParameters.json'), 'utf8'));
      if (!verdict.ok) return fail(verdict.reason);
      const distributed = path.join(staging, 'ProjectParameters.json');
      await fsp.writeFile(distributed, JSON.stringify(verdict.parameters, null, 4));
      const made = await this.exec(this.host, mkdirCommand(`${spec.remoteDir}/input`));
      if (made.code !== 0) return fail(`Could not create the run directory: ${made.stderr.trim()}`);
      for (const name of await fsp.readdir(spec.inputDir)) {
        const from = path.join(spec.inputDir, name);
        if (!(await fsp.stat(from)).isFile()) continue;
        const sent = await this.exec(this.host, uploadCommand(`${spec.remoteDir}/input/${name}`), { stdinFile: name === 'ProjectParameters.json' ? distributed : from });
        if (sent.code !== 0) return fail(`Upload of ${name} failed: ${sent.stderr.trim()}`);
      }
      const script = await this.exec(this.host, uploadCommand(`${spec.remoteDir}/run.sh`), { stdinFile: run });
      if (script.code !== 0) return fail(`Upload of the runner script failed: ${script.stderr.trim()}`);
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    // After this point a lost connection cannot say whether the ranks started.
    const launched = await this.exec(this.host, mpiLaunchCommand(spec.remoteDir));
    if (launched.code !== 0) throw new Error(`MPI launch status is unknown: ${launched.stderr.trim()}`);
    return { ...this.base(task), state: 'running', message: `Running ${spec.intent.ranks} MPI ranks × ${spec.intent.threadsPerRank} threads${this.host ? ` on ${this.host}` : ''} in ${spec.remoteDir}.` };
  }
  async lookup(task: Task, store: ProjectStore): Promise<Receipt | undefined> {
    const spec = this.spec(task, store);
    const read = await this.exec(this.host, readReceiptCommand(spec.remoteDir));
    if (read.code !== 0) return undefined;
    let raw: unknown;
    try { raw = JSON.parse(read.stdout); } catch { return undefined; }
    const parsed = parseMpiReceipt(raw, task); // throws for another owner/request
    if (!parsed) return undefined;
    let alive: boolean | undefined, dead = 0;
    if (parsed.state === 'running') {
      alive = typeof parsed.pid === 'number' ? (await this.exec(this.host, aliveCommand(parsed.pid))).code === 0 : false;
      if (alive) dead = Number(/down (\d+)/.exec((await this.exec(this.host, ranksAliveCommand(spec.remoteDir))).stdout)?.[1] ?? 0);
    }
    const receipt = reconcileMpi(parsed, alive, dead);
    if (!receipt || !TERMINAL.includes(receipt.state)) return receipt;
    try {
      return { ...receipt, artifacts: await fetchRunArtifacts(this.exec, this.host, spec, task.runId) };
    } catch (error) {
      // Not terminal for the queue: the next tick retries the (idempotent) download.
      return { ...this.base(task), state: 'uncertain', message: `MPI run finished (${receipt.state}) but its outputs could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  async cancel(task: Task, store: ProjectStore): Promise<Receipt> {
    const spec = this.spec(task, store);
    const read = await this.exec(this.host, readReceiptCommand(spec.remoteDir));
    const pid = read.code === 0 ? (() => { try { return JSON.parse(read.stdout).pid; } catch { return undefined; } })() : undefined;
    if (typeof pid !== 'number') return { ...this.base(task), state: 'uncertain', message: 'No launcher process id is recorded; resolve the job on the host.' };
    await this.exec(this.host, cancelCommand(spec.remoteDir, pid));
    for (let i = 0; i < 25; i++) {
      const receipt = await this.lookup(task, store).catch(() => undefined);
      if (receipt && TERMINAL.includes(receipt.state)) return receipt;
      await this.sleep(200);
    }
    return { ...this.base(task), state: 'uncertain', message: 'Cancellation was signalled but the receipt is not terminal yet.' };
  }
}
