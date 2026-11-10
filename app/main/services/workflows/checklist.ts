// Study checklist (sequencing half): turns the readiness
// states `readiness()` already derives into ordered steps and the single next
// action. Pure; nothing here computes or runs anything.
export type StepState = 'ready' | 'stale' | 'missing' | string;
export interface ChecklistStep { id: 'geometry' | 'mesh' | 'case' | 'run' | 'review'; state: 'done' | 'todo' | 'redo' | 'blocked'; action: string; tool?: string; why?: string }

const STAGES = ['geometry', 'mesh', 'case', 'run', 'review'] as const;

export function buildChecklist(r: Record<string, StepState>): { steps: ChecklistStep[]; next?: ChecklistStep } {
  const steps: ChecklistStep[] = [];
  let blocker: string | undefined;
  const push = (id: ChecklistStep['id'], state: ChecklistStep['state'], action: string, tool?: string, why?: string) => {
    steps.push({ id, state, action, ...(tool ? { tool } : {}), ...(why ? { why } : {}) });
  };
  const gate = (id: string, ok: boolean) => { if (!ok && !blocker) blocker = id; };
  const g = r.geometry, m = r.mesh, c = r.case;
  push('geometry', g === 'ready' ? 'done' : g === 'stale' ? 'redo' : 'todo', g === 'ready' ? 'Geometry is current.' : g === 'stale' ? 'The geometry file changed; relink or refresh it.' : 'Attach a geometry file to the study.', g === 'ready' ? undefined : g === 'stale' ? 'app__study_relink_source' : 'app__study_create');
  gate('geometry', g === 'ready');
  const meshState = blocker ? 'blocked' : m === 'ready' ? 'done' : m === 'stale' ? 'redo' : 'todo';
  push('mesh', meshState, m === 'ready' ? 'Mesh is current.' : 'Export a mesh from CAD and attach it.', m === 'ready' ? undefined : 'app__study_attach_mesh', blocker ? `needs ${blocker}` : undefined);
  gate('mesh', m === 'ready');
  const caseState = blocker ? 'blocked' : c === 'ready' ? 'done' : c === 'stale' ? 'redo' : 'todo';
  push('case', caseState, c === 'ready' ? 'Case setup matches the mesh.' : 'Set up the Problemtype case on the attached mesh in Post-Processing.', undefined, blocker ? `needs ${blocker}` : undefined);
  gate('case', c === 'ready');
  const runDone = r.run === 'succeeded';
  const runState = blocker ? 'blocked' : runDone ? 'done' : ['failed', 'cancelled', 'uncertain'].includes(r.run) ? 'redo' : 'todo';
  push('run', runState, runDone ? 'A run succeeded.' : r.run === 'uncertain' ? 'The last run is uncertain; inspect it before starting another.' : 'Preview, enqueue and start a run.', runDone ? undefined : 'app__queue_plan_preview', blocker ? `needs ${blocker}` : undefined);
  gate('run', runDone);
  push('review', blocker ? 'blocked' : r.results === 'ready' ? 'todo' : 'blocked', 'Review the run: convergence evidence, mesh quality and result quantities.', 'app__run_review', blocker ? `needs ${blocker}` : r.results === 'ready' ? undefined : 'no result artifact');
  const next = steps.find(s => s.state === 'todo' || s.state === 'redo');
  return { steps, ...(next ? { next } : {}) };
}
export { STAGES };

/** What the chat's context suffix carries: the study and its single next action. */
export interface NextStepContext { studyId: string; name: string; step: ChecklistStep['id']; tool?: string }
export function nextStepContext(c: { studyId: string; name: string; next?: ChecklistStep }): NextStepContext | undefined {
  return c.next ? { studyId: c.studyId, name: c.name, step: c.next.id, ...(c.next.tool ? { tool: c.next.tool } : {}) } : undefined;
}
