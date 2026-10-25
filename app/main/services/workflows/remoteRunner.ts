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
import { aliveCommand, cancelCommand, launchCommand, mkdirCommand, readReceiptCommand, remoteRunScript, shQuote, uploadCommand } from '../cloud/providerCore/sshCore';
import type { Receipt, Task, TaskState } from './contracts';
import type { ProjectStore } from './project';
import type { Runner } from './queue';

export interface RemoteSolveSpec {
  /** Local directory whose files are uploaded to `<remoteDir>/input`. */
  inputDir: string;
  /** Remote run directory; relative paths resolve from the login directory. */
  remoteDir: string;
  argv: string[];
  env?: Record<string, string>;
}
const STATES: readonly TaskState[] = ['running', 'succeeded', 'failed', 'cancelled', 'uncertain'];
const TERMINAL: readonly TaskState[] = ['succeeded', 'failed', 'cancelled'];

export class RemoteRunner implements Pick<Runner, 'validate' | 'dispatch' | 'lookup' | 'cancel'> {
  constructor(private readonly host: string, private readonly ssh: SshRunner,
    private readonly spec: (task: Task, store: ProjectStore) => RemoteSolveSpec,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {}
  async validate(task: Task, store: ProjectStore): Promise<string[]> {
    const { argv } = this.spec(task, store);
    const probe = await this.ssh(this.host, `command -v ${shQuote(argv[0])} >/dev/null`).catch(() => undefined);
    return probe?.code === 0 ? [] : [`Remote host ${this.host} is unreachable or has no '${argv[0]}'.`];
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
    return { ...this.base(task), state: finalState, ...(message ? { message } : {}) };
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
