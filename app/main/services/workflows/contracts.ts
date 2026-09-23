/** Portable workflow contracts. Absolute runtime paths never identify a study. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Reference = { kind: 'project' | 'external'; path: string; revision: string };
export interface Artifact { role: string; reference: Reference; ownerId: string }
export interface Finding { severity: 'error' | 'warning' | 'unavailable'; message: string; target?: string }
export interface Handoff {
  version: 1; exportId: string; source: Reference; replayRevision: string;
  units: { length: string | null; scale: number }; options: Json; engine: string;
  artifacts: Artifact[]; groups: { name: string; id: string; dimension: number; count: number }[];
  findings: Finding[];
}
export interface Quantity {
  field: string; component: string; region: string; time: number; reduction: string;
  unit: string; value: number | null; runId: string;
}
export interface Evidence {
  version: 1; runId: string; findings: Finding[];
  mesh: { nodes?: number; elements?: number; quality?: Json };
  convergence: { adapter: string; state: 'converged' | 'diverged' | 'unavailable'; samples: { iteration: number; residual: number }[] };
  quantities: Quantity[];
}
export type TaskState = 'waiting' | 'held' | 'dispatching' | 'running' | 'uncertain' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
export interface Receipt { version: 1; requestId: string; ownerId: string; jobId?: string; state: TaskState; artifacts: Artifact[] }
export interface Run {
  id: string; studyId: string; sourceRevision: string; meshRevision: string;
  settings: Json; directory: string; state: TaskState; artifacts: Artifact[];
  receipt?: Receipt; evidence?: Evidence; startedAt?: number; finishedAt?: number;
}
export interface Study {
  id: string; name: string; source: Reference; meshing: Json; mesh?: Reference;
  meshSourceRevision?: string; meshOptionsRevision?: string; caseSettings: Json;
  caseMeshRevision?: string; runs: Run[]; parentId?: string;
}
export interface Task {
  id: string; studyId: string; runId: string; kind: 'mesh' | 'generate' | 'solve';
  dependencies: string[]; args: { [key: string]: Json }; inputRevision: string;
  requiredArtifacts: string[]; state: TaskState; receipt?: Receipt; error?: string;
}
export interface Project {
  version: 1; id: string; revision: number; activeStudyId?: string; activeRunId?: string;
  studies: Study[]; queue: { paused: boolean; tasks: Task[] };
}
