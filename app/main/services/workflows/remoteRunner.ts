/**
 * Runs a queued solve on an ssh host. Never spawns anything locally: every
 * effect goes through the injected SshRunner. Intent is already persisted by
 * ExecutionQueue before dispatch(); any ambiguity after the launch command
 * throws so the queue records `uncertain` and never retries.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SshRunner } from '../cloud/providers/ssh';
import { aliveCommand, cancelCommand, cpuCountCommand, downloadCommand, kratosProbeCommand, launchCommand, listOutputsCommand, mkdirCommand, parseOutputs, readReceiptCommand, remoteRunScript, shQuote, uploadCommand } from '../cloud/providerCore/sshCore';
import type { Artifact, Receipt, Task, TaskState } from './contracts';
import { fileRevision, reference, type ProjectStore } from './project';
import type { Runner } from './queue';

export interface RemoteSolveSpec {
  /** Local directory whose files are uploaded to `<remoteDir>/input`. */
  inputDir: string;
  /** Remote run directory; relative paths resolve from the login directory. */
  remoteDir: string;
  argv: string[];
  env?: Record<string, string>;
  /** Absolute local directory the run's outputs are downloaded into. */
  localDir: string;
  /** Project root, for relocatable artifact references. */
  root: string;
}
const MAX_FILES = 500, MAX_BYTES = 2_000_000_000;
const STATES: readonly TaskState[] = ['running', 'succeeded', 'failed', 'cancelled', 'uncertain'];
const TERMINAL: readonly TaskState[] = ['succeeded', 'failed', 'cancelled'];

/** Downloads and verifies the run's outputs; files already present and matching are kept. */
export async function fetchRunArtifacts(ssh: SshRunner, host: string, spec: RemoteSolveSpec, runId: string): Promise<Artifact[]> {
  const listed = await ssh(host, listOutputsCommand(spec.remoteDir));
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || 'listing failed');
  const rows = parseOutputs(listed.stdout);
  if (rows.length > MAX_FILES) throw new Error(`Run produced ${rows.length} files (limit ${MAX_FILES}); refusing a partial download.`);
  const base = path.resolve(spec.localDir);
  const artifacts: Artifact[] = [];
  let bytes = 0;
  for (const row of rows) {
    const rel = row.path.replace(/^input\//, '');
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) continue;
    if (await fileRevision(target).then(r => r === row.sha256, () => false) === false) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const got = await ssh(host, downloadCommand(`${spec.remoteDir}/${row.path}`), { stdoutFile: target });
      if (got.code !== 0) throw new Error(`download of ${rel} failed: ${got.stderr.trim()}`);
      if (await fileRevision(target) !== row.sha256) { await fs.rm(target, { force: true }); throw new Error(`${rel} failed its checksum after download.`); }
    }
    bytes += (await fs.stat(target)).size;
    if (bytes > MAX_BYTES) throw new Error('Run outputs exceed the download limit.');
    artifacts.push({ role: row.path === 'stdout.log' ? 'log' : 'result', ownerId: runId, reference: reference(spec.root, target, row.sha256) });
  }
  return artifacts;
}

export class RemoteRunner implements Pick<Runner, 'validate' | 'dispatch' | 'lookup' | 'cancel'> {
  constructor(private readonly host: string, private readonly ssh: SshRunner,
    private readonly spec: (task: Task, store: ProjectStore) => RemoteSolveSpec,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  /** Remote CPU count from the last successful probe, for the shared queue budget. */
  static lastCpuCount?: number;
  async validate(task: Task, store: ProjectStore): Promise<string[]> {
    const { argv } = this.spec(task, store);
    const run = (c: string) => this.ssh(this.host, c).catch(() => undefined);
    const exe = await run(`command -v ${shQuote(argv[0])} >/dev/null`);
    if (exe?.code !== 0) return [`Remote host ${this.host} is unreachable or has no '${argv[0]}'.`];
    const errors: string[] = [];
    if ((await run(kratosProbeCommand()))?.code !== 0) errors.push(`Kratos (KratosMultiphysics) is not importable by ${argv[0]} on ${this.host}.`);
    const cpus = Number((await run(cpuCountCommand()))?.stdout.trim());
    if (Number.isSafeInteger(cpus) && cpus > 0) {
      RemoteRunner.lastCpuCount = cpus;
      if (typeof task.args.threads === 'number' && task.args.threads > cpus) errors.push(`The plan asks for ${task.args.threads} threads but ${this.host} has ${cpus} CPUs; approve a new plan.`);
    } else errors.push(`Could not determine the CPU count of ${this.host}.`);
    return errors;
  }
  private base(task: Task) { return { version: 1 as const, requestId: task.id, ownerId: task.studyId, artifacts: [] }; }
  async dispatch(task: Task, store: ProjectStore): Promise<Receipt> {
    const spec = this.spec(task, store);
    const fail = (message: string): Receipt => ({ ...this.base(task), state: 'failed', message });
    // Everything before the launch command is retry-safe: nothing is running yet.
    try {
      const run = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'kkss-run-')), 'run.sh');
      await fs.writeFile(run, remoteRunScript({ dir: spec.remoteDir, requestId: task.id, ownerId: task.studyId, argv: spec.argv, env: spec.env }));
      const made = await this.ssh(this.host, mkdirCommand(`${spec.remoteDir}/input`));
      if (made.code !== 0) return fail(`Could not create the remote run directory: ${made.stderr.trim()}`);
      for (const name of await fs.readdir(spec.inputDir)) {
        const from = path.join(spec.inputDir, name);
        if (!(await fs.stat(from)).isFile()) continue;
        const sent = await this.ssh(this.host, uploadCommand(`${spec.remoteDir}/input/${name}`), { stdinFile: from });
        if (sent.code !== 0) return fail(`Upload of ${name} failed: ${sent.stderr.trim()}`);
      }
      const script = await this.ssh(this.host, uploadCommand(`${spec.remoteDir}/run.sh`), { stdinFile: run });
      if (script.code !== 0) return fail(`Upload of the runner script failed: ${script.stderr.trim()}`);
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    // After this point a lost connection cannot say whether the solver started.
    const launched = await this.ssh(this.host, launchCommand(spec.remoteDir));
    if (launched.code !== 0) throw new Error(`Remote launch status is unknown: ${launched.stderr.trim()}`);
    return { ...this.base(task), state: 'running', message: `Running on ${this.host} in ${spec.remoteDir}; outputs stay on the host.` };
  }
  async lookup(task: Task, store: ProjectStore): Promise<Receipt | undefined> {
    const spec = this.spec(task, store);
    const read = await this.ssh(this.host, readReceiptCommand(spec.remoteDir));
    if (read.code !== 0) return undefined;
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(read.stdout); } catch { return undefined; }
    if (raw.version !== 1 || raw.requestId !== task.id || raw.ownerId !== task.studyId) {
      throw new Error('Remote receipt does not match the requested owner and request.');
    }
    const state = STATES.find(s => s === raw.state) ?? 'uncertain';
    let message = typeof raw.message === 'string' ? raw.message : undefined;
    let finalState: TaskState = state;
    if (state === 'running') {
      const alive = typeof raw.pid === 'number' ? await this.ssh(this.host, aliveCommand(raw.pid)) : undefined;
      if (alive?.code !== 0) { finalState = 'uncertain'; message = 'The remote solver process is gone without a terminal receipt.'; }
    }
    if (!TERMINAL.includes(finalState)) return { ...this.base(task), state: finalState, ...(message ? { message } : {}) };
    try {
      const artifacts = await fetchRunArtifacts(this.ssh, this.host, spec, task.runId);
      return { ...this.base(task), state: finalState, artifacts, ...(message ? { message } : {}) };
    } catch (error) {
      // Not terminal for the queue: the next tick retries the (idempotent) download.
      return { ...this.base(task), state: 'uncertain', message: `Remote run finished (${finalState}) but its outputs could not be fetched: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  async cancel(task: Task, store: ProjectStore): Promise<Receipt> {
    const spec = this.spec(task, store);
    const read = await this.ssh(this.host, readReceiptCommand(spec.remoteDir));
    const pid = read.code === 0 ? (() => { try { return JSON.parse(read.stdout).pid; } catch { return undefined; } })() : undefined;
    if (typeof pid !== 'number') return { ...this.base(task), state: 'uncertain', message: 'No remote process id is recorded; resolve the job on the host.' };
    await this.ssh(this.host, cancelCommand(spec.remoteDir, pid));
    for (let i = 0; i < 10; i++) {
      const receipt = await this.lookup(task, store).catch(() => undefined);
      if (receipt && TERMINAL.includes(receipt.state)) return receipt;
      await this.sleep(200);
    }
    return { ...this.base(task), state: 'uncertain', message: 'Cancellation was signalled but the remote receipt is not terminal yet.' };
  }
}
