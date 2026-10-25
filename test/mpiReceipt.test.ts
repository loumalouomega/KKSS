import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { mpiPlanArgs, mpiResources, parseMpiReceipt, reconcileMpi } from '../app/main/services/workflows/mpiReceipt';
import { ExecutionQueue, planRevision } from '../app/main/services/workflows/queue';
import { ProjectStore } from '../app/main/services/workflows/project';
import type { Study, Task } from '../app/main/services/workflows/contracts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
const ref = { id: 't', studyId: 's' };
const raw = (over: object = {}) => ({ version: 1, requestId: 't', ownerId: 's', launcher: 'mpirun', ranks: 4, threadsPerRank: 2, state: 'running', ...over });
const study: Study = { id: 's', name: 's', source: { kind: 'project', path: 'a.step', revision: 'r' }, meshing: {}, caseSettings: {}, runs: [] };
const mpiTask = (ranks: number): Task => ({
  id: 't', kind: 'solve', studyId: 's', runId: 't', state: 'waiting', inputRevision: 'i', dependencies: [], requiredArtifacts: [],
  args: mpiPlanArgs({ ranks, threadsPerRank: 2, launcher: 'mpirun' }), resources: mpiResources({ ranks, threadsPerRank: 2, launcher: 'mpirun' }),
});

describe('MPI receipt contract', () => {
  it('validates intent and totals slots', () => {
    expect(mpiResources({ ranks: 4, threadsPerRank: 2, launcher: 'mpirun' })).toEqual({ threads: 8, verified: true });
    for (const ranks of [0, 1.5, -1, NaN]) expect(() => mpiResources({ ranks, threadsPerRank: 1, launcher: 'srun' })).toThrow();
    expect(() => mpiResources({ ranks: 1, threadsPerRank: 1, launcher: 'bash' as never })).toThrow();
  });
  it('parses defensively and refuses another owner', () => {
    expect(parseMpiReceipt(null, ref)).toBeUndefined();
    expect(parseMpiReceipt(raw({ ranks: 0 }), ref)).toBeUndefined();
    expect(() => parseMpiReceipt(raw({ requestId: 'x' }), ref)).toThrow();
    expect(() => parseMpiReceipt(raw({ ownerId: 'x' }), ref)).toThrow();
    expect(parseMpiReceipt(raw({ state: 'weird' }), ref)?.state).toBe('uncertain');
  });
  it('maps states without inferring convergence', () => {
    const rec = (over: object, alive?: boolean) => reconcileMpi(parseMpiReceipt(raw(over), ref), alive);
    expect(rec({}, true)?.state).toBe('running');
    expect(rec({}, false)?.state).toBe('uncertain');
    expect(rec({ state: 'failed', exitCode: 1 }, false)?.state).toBe('failed');
    expect(rec({ state: 'succeeded' })?.message).toMatch(/convergence is not established/);
    const mismatch = rec({ state: 'succeeded', effectiveRanks: 3 });
    expect(mismatch?.state).toBe('uncertain');
    expect(mismatch?.resources).toEqual({ requestedThreads: 8, effectiveThreads: 6 });
    expect(reconcileMpi(undefined)).toBeUndefined();
  });
  it('freezes ranks into the plan fingerprint', () => {
    expect(planRevision([mpiTask(2)])).not.toBe(planRevision([mpiTask(4)]));
  });
  it('reconciles after restart without redispatching; a missing receipt stays uncertain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mpi-')); roots.push(root);
    const store = new ProjectStore(root); await store.update(() => {});
    const sent: string[] = [];
    let disk: unknown = raw();
    const runner = {
      validate: async () => [],
      dispatch: async (t: Task) => { sent.push(t.id); return reconcileMpi(parseMpiReceipt(disk, t), true)!; },
      lookup: async (t: Task) => reconcileMpi(parseMpiReceipt(disk, t), true),
      cancel: async (t: Task) => ({ version: 1 as const, requestId: t.id, ownerId: t.studyId, state: 'cancelled' as const, artifacts: [] }),
    };
    const first = new ExecutionQueue(runner, () => 16);
    await first.enqueue(store, [mpiTask(4)], [study]);
    await first.resume(store, planRevision((await store.read())!.queue.tasks));
    expect(sent).toEqual(['t']);
    const second = new ExecutionQueue(runner, () => 16);
    await second.register(store);
    expect((await store.read())!.queue.tasks[0].state).toBe('running');
    expect(sent).toHaveLength(1);
    disk = undefined;
    const third = new ExecutionQueue(runner, () => 16);
    await third.register(store);
    const row = (await store.read())!.queue.tasks[0];
    expect(row.state).toBe('uncertain');
    expect((await store.read())!.queue.paused).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
