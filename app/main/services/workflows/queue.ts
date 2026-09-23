/** Queue observes runners; it never spawns or adopts solver processes. */
import type { Receipt, Study, Task } from './contracts';
import { fingerprint, ProjectStore, validateOrder } from './project';
export interface Runner {
  validate(task: Task, store: ProjectStore): Promise<string[]>;
  dispatch(task: Task, store: ProjectStore): Promise<Receipt>;
  lookup(task: Task, store: ProjectStore): Promise<Receipt | undefined>;
  cancel(task: Task, store: ProjectStore): Promise<Receipt>;
}
const active = (task: Task) => ['dispatching', 'running', 'uncertain'].includes(task.state);
const failed = (task: Task) => ['failed', 'cancelled', 'blocked'].includes(task.state);
/** One coordinator owns all project queues, providing the global heavy-task slot. */
export class ExecutionQueue {
  private stores = new Set<ProjectStore>();
  private ticking?: Promise<void>;
  constructor(private readonly runner: Runner) {}
  async register(store: ProjectStore): Promise<void> {
    if (this.stores.has(store)) return;
    const existing = await store.read();
    this.stores.add(store);
    if (!existing) return;
    await store.update(p => { p.queue.paused = true; });
    for (const task of existing.queue.tasks.filter(active)) {
      const receipt = await this.runner.lookup(task, store).catch(() => undefined);
      await store.update(p => {
        const row = p.queue.tasks.find(t => t.id === task.id)!;
        row.receipt = receipt ?? row.receipt;
        row.state = receipt?.state ?? 'uncertain';
        if (!receipt) row.error = 'Dispatch could not be reconciled. Resolve the existing job before launching more work.';
      });
    }
  }
  async enqueue(store: ProjectStore, tasks: Task[], studies: Study[] = []): Promise<string> {
    if (!tasks.length) throw new Error('A queue plan must contain at least one task.');
    await this.register(store);
    await store.update(p => {
      const ids = new Set(p.queue.tasks.map(t => t.id));
      if (studies.some(s => p.studies.some(existing => existing.id === s.id)) || studies.some((s, i) => studies.slice(0, i).some(other => other.id === s.id))) throw new Error('Queue plan has a duplicate study identity.');
      p.studies.push(...structuredClone(studies));
      const studyIds = new Set(p.studies.map(study => study.id));
      if (tasks.some(t => ids.has(t.id) || !studyIds.has(t.studyId))) throw new Error('Queue plan has a duplicate task or unknown study.');
      const queued = tasks.map(t => ({ ...structuredClone(t), state: 'waiting' as const, receipt: undefined, error: undefined }));
      const combined = [...p.queue.tasks, ...queued];
      validateOrder(combined);
      p.queue.tasks = combined;
      p.queue.paused = true;
    });
    const project = await store.read();
    if (!project) throw new Error('Queue plan could not be persisted.');
    return planRevision(project.queue.tasks);
  }
  async reorder(store: ProjectStore, ids: string[]): Promise<void> {
    await store.update(p => {
      if (ids.length !== p.queue.tasks.length || new Set(ids).size !== ids.length) throw new Error('Reorder must include every task exactly once.');
      const next = ids.map(id => { const t = p.queue.tasks.find(t => t.id === id); if (!t) throw new Error('Unknown task.'); return t; });
      p.queue.tasks.forEach((t, i) => { if (t.state !== 'waiting' && next[i].id !== t.id) throw new Error('Only waiting tasks can move.'); });
      validateOrder(next); p.queue.tasks = next;
    });
  }
  async pause(store: ProjectStore): Promise<void> { await store.update(p => { p.queue.paused = true; }); }
  async resume(store: ProjectStore, expectedPlan: string): Promise<void> {
    await this.register(store);
    await store.update(p => {
      if (planRevision(p.queue.tasks) !== expectedPlan) throw new Error('The concrete plan changed. Preview and approve it again.');
      // A held task was never dispatched. Resume is an explicit request to
      // re-run its preflight after the user has corrected configuration.
      for (const task of p.queue.tasks) if (task.state === 'held') { task.state = 'waiting'; delete task.error; }
      p.queue.paused = false;
    });
    await this.tick();
  }
  async cancel(store: ProjectStore, id: string): Promise<void> {
    const task = (await store.read())?.queue.tasks.find(t => t.id === id);
    if (!task) throw new Error('Unknown task.');
    if (['succeeded', 'failed', 'cancelled'].includes(task.state)) return;
    const receipt = active(task) ? await this.runner.cancel(task, store) : undefined;
    await store.update(p => { const row = p.queue.tasks.find(t => t.id === id)!; row.receipt = receipt ?? row.receipt; row.state = receipt?.state ?? 'cancelled'; });
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.step().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async step(): Promise<void> {
    // Reconcile every active task before considering any new dispatch.
    let occupied = false;
    for (const store of this.stores) {
      for (const task of (await store.read())?.queue.tasks.filter(active) ?? []) {
        const receipt = await this.runner.lookup(task, store).catch(() => undefined);
        await store.update(p => {
          const row = p.queue.tasks.find(t => t.id === task.id)!;
          row.state = receipt?.state ?? 'uncertain'; row.receipt = receipt ?? row.receipt;
          occupied ||= active(row);
        });
      }
    }
    if (occupied) return;
    for (const store of this.stores) {
      const snapshot = await store.read();
      if (!snapshot || snapshot.queue.paused) continue;
      for (const task of snapshot.queue.tasks.filter(t => t.state === 'waiting')) {
        const dependencies = task.dependencies.map(id => snapshot.queue.tasks.find(t => t.id === id)!);
        if (dependencies.some(failed)) {
          await store.update(p => { p.queue.tasks.find(t => t.id === task.id)!.state = 'blocked'; });
          task.state = 'blocked'; continue;
        }
        if (dependencies.some(t => t.state !== 'succeeded')) continue;
        const errors = await this.runner.validate(task, store).catch(e => [String(e)]);
        if (errors.length) {
          await store.update(p => { const row = p.queue.tasks.find(t => t.id === task.id)!; row.state = 'held'; row.error = errors.join('\n'); });
          continue;
        }
        let dispatch: Task | undefined;
        await store.update(p => {
          const row = p.queue.tasks.find(t => t.id === task.id)!;
          if (p.queue.paused || row.state !== 'waiting' || fingerprint(row.args) !== fingerprint(task.args)) return;
          row.state = 'dispatching';
          row.receipt = { version: 1, requestId: row.id, ownerId: row.studyId, state: 'dispatching', artifacts: [] };
          dispatch = structuredClone(row);
        });
        if (!dispatch) continue;
        // A thrown transport error is ambiguous: never silently retry it.
        const receipt = await this.runner.dispatch(dispatch, store).catch(() => undefined);
        await store.update(p => { const row = p.queue.tasks.find(t => t.id === task.id)!; row.state = receipt?.state ?? 'uncertain'; row.receipt = receipt ?? row.receipt; if (receipt?.message) row.error = receipt.message; });
        if (!receipt || active({ ...task, state: receipt.state })) return;
        return this.step();
      }
    }
  }
}
export function planRevision(tasks: Task[]): string {
  return fingerprint(tasks.map(({ id, studyId, runId, kind, dependencies, args, inputRevision, requiredArtifacts }) => ({ id, studyId, runId, kind, dependencies, args, inputRevision, requiredArtifacts })));
}
