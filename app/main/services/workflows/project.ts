import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../atomicWrite';
import type { Json, Project, Reference, Study, Task } from './contracts';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Canonical object keys make revisions independent of JSON formatting. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : record(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function fileRevision(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export function reference(root: string, file: string, revision: string): Reference {
  const relative = path.relative(root, path.resolve(file));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? { kind: 'project', path: relative.split(path.sep).join('/'), revision }
    : { kind: 'external', path: path.resolve(file), revision };
}
export function resolveReference(root: string, ref: Reference): string {
  if (!ref || typeof ref.path !== 'string' || typeof ref.revision !== 'string') throw new Error('Invalid artifact reference.');
  if (ref.kind === 'external' && path.isAbsolute(ref.path)) return ref.path;
  if (ref.kind !== 'project' || path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes('..')) throw new Error('Invalid project-relative reference.');
  return path.resolve(root, ref.path);
}
export function parseProject(raw: unknown): Project {
  if (!record(raw) || raw.version !== 1) throw new Error('Unsupported project schema. The project was not modified.');
  const queue = raw.queue;
  if (typeof raw.id !== 'string' || !Number.isSafeInteger(raw.revision) || !Array.isArray(raw.studies) || !record(queue) || typeof queue.paused !== 'boolean' || !Array.isArray(queue.tasks)) throw new Error('Invalid project metadata.');
  if (queue.dispatchScope !== undefined && (!Array.isArray(queue.dispatchScope) || queue.dispatchScope.some(id => typeof id !== 'string'))) throw new Error('Invalid queue dispatch scope.');
  const ids = new Set<string>();
  for (const study of raw.studies) {
    if (!record(study) || typeof study.id !== 'string' || ids.has(study.id) || typeof study.name !== 'string' || !record(study.source) || !Array.isArray(study.runs)) throw new Error('Invalid or duplicate study.');
    resolveReference('/', study.source as unknown as Reference);
    if (study.mesh) resolveReference('/', study.mesh as unknown as Reference);
    ids.add(study.id);
    for (const run of study.runs) if (!record(run) || typeof run.id !== 'string' || run.studyId !== study.id || !Array.isArray(run.artifacts) || typeof run.directory !== 'string' || run.directory !== `.kkss/runs/${run.id}` || !/^[a-zA-Z0-9-]+$/.test(run.id)) throw new Error('Invalid run ownership.');
  }
  validateOrder(queue.tasks as unknown as Task[]);
  for (const task of queue.tasks as unknown as Task[]) if (!ids.has(task.studyId)) throw new Error('Task references an unknown study.');
  if (queue.dispatchScope && (new Set(queue.dispatchScope).size !== queue.dispatchScope.length || queue.dispatchScope.some(id => !(queue.tasks as unknown as Task[]).some(task => task.id === id)))) throw new Error('Invalid queue dispatch scope.');
  return structuredClone(raw) as unknown as Project;
}
export function validateOrder(tasks: Task[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || seen.has(task.id) || !Array.isArray(task.dependencies) || task.dependencies.some(id => !seen.has(id))) throw new Error('Queue order must keep every dependency before its task.');
    seen.add(task.id);
  }
}
export class ProjectStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  get file(): string { return path.join(this.root, '.kkss', 'project.json'); }
  async read(): Promise<Project | undefined> {
    try { return parseProject(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }
  /** Serialize the entire read/modify/write, not merely the final rename. */
  update<T>(change: (project: Project) => T | Promise<T>): Promise<T> {
    const operation = this.pending.then(async () => {
      const project = await this.read() ?? { version: 1, id: randomUUID(), revision: 0, studies: [], queue: { paused: true, tasks: [] } };
      const result = await change(project);
      project.revision++;
      parseProject(project);
      await writeFileAtomic(this.file, JSON.stringify(project, null, 2) + '\n');
      return result;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
export async function readiness(root: string, study: Study): Promise<Record<string, string>> {
  const state = async (ref?: Reference): Promise<string> => {
    if (!ref) return 'missing';
    try { return await fileRevision(resolveReference(root, ref)) === ref.revision ? 'ready' : 'stale'; }
    catch { return 'missing'; }
  };
  const geometry = await state(study.source);
  let mesh = await state(study.mesh);
  if (mesh === 'ready' && (geometry !== 'ready' || study.meshSourceRevision !== study.source.revision || study.meshOptionsRevision !== fingerprint(study.meshing))) mesh = 'stale';
  const latest = study.runs[study.runs.length - 1];
  const caseState = study.caseSettings === null ? 'missing' : mesh !== 'ready' || study.caseMeshRevision !== study.mesh?.revision ? 'stale' : 'ready';
  return { geometry, mesh, case: caseState,
    run: latest?.state ?? 'missing', results: latest?.artifacts.some(a => a.role === 'result') ? 'ready' : 'missing' };
}
export function duplicateStudy(source: Study, name: string, reuseMesh: boolean, settings: Json = source.caseSettings): Study {
  return { id: randomUUID(), name, parentId: source.id, source: structuredClone(source.source),
    meshing: structuredClone(source.meshing), caseSettings: structuredClone(settings), runs: [],
    ...(reuseMesh ? { mesh: source.mesh && structuredClone(source.mesh), meshSourceRevision: source.meshSourceRevision, meshOptionsRevision: source.meshOptionsRevision, caseMeshRevision: source.caseMeshRevision,
      ...(source.handoff ? { handoff: structuredClone(source.handoff) } : {}) } : {}) };
}
export function previewVariants(source: Study, rows: { name: string; settings: Json }[]): { name: string; settings: Json; changed: boolean }[] {
  if (!rows.length || rows.length > 50) throw new Error('A sweep must contain 1–50 explicit variant rows.');
  return rows.map(row => ({ ...structuredClone(row), changed: fingerprint(row.settings) !== fingerprint(source.caseSettings) }));
}
