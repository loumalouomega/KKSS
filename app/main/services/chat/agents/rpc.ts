import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ProviderError } from '../providers/types';
import { subscriptionEnv } from './runtime';

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };
/** Newline JSON-RPC transport. No child output (potentially credentials) is logged. */
export class AgentRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private failure?: Error;
  onMessage: (message: RpcMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  constructor(executable: string, args: string[], signal: AbortSignal, cwd?: string) {
    this.child = spawn(executable, args, { stdio: 'pipe', env: subscriptionEnv(), windowsHide: true, cwd });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new ProviderError('other', 'Subscription runtime disconnected.')));
    this.child.on('error', () => this.fail(new ProviderError('other', 'Could not start subscription runtime. Check its executable path.')));
    this.child.on('exit', () => this.fail(new ProviderError('other', 'Subscription runtime exited. Update the official tool and retry.')));
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', line => {
      if (line.length > 16 * 1024 * 1024) return this.fail(new ProviderError('other', 'Subscription runtime response was too large.'));
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return this.fail(new ProviderError('other', 'Invalid subscription runtime protocol. Update the official tool.')); }
      if (typeof message.id === 'number' && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new ProviderError('other', message.error.message ?? 'Subscription runtime rejected the request.'));
        else pending.resolve(message.result);
      } else this.onMessage(message);
    });
    const abort = () => this.close();
    signal.addEventListener('abort', abort, { once: true });
    this.child.once('exit', () => { reader.close(); signal.removeEventListener('abort', abort); });
    if (signal.aborted) this.close();
  }
  request(method: string, params: unknown): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ProviderError('other', `Subscription runtime timed out (${method}).`)); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  send(message: RpcMessage): void { if (!this.failure) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.onFailure(error);
  }
  close(): void {
    this.fail(new ProviderError('other', 'Subscription session stopped.'));
    this.child.kill();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 1000);
    timer.unref();
  }
}
