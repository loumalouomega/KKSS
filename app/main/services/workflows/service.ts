import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../atomicWrite';
import type { AppTool } from '../chat/appTools';
import { checkEnvironment, type EnvironmentReport } from './environment';
import { ProjectStore, fileRevision, fingerprint, readiness, reference, resolveReference, duplicateStudy, previewVariants } from './project';
import type { Handoff, Json, Project, Quantity, Study } from './contracts';
import type { Run } from './contracts';
import type { KratosRuntime } from '../chat/kratosRuntime';
import { ExecutionQueue, planRevision } from './queue';
import type { Runner } from './queue';
import type { Receipt, Task, TaskState } from './contracts';
import { BUILTIN_PROBLEMTYPES } from '../../../../mesh/src/problemtype/builtins';
import { defaultCaseState } from '../../../../mesh/src/problemtype/api';
import { parseCaseJson, caseFilePath, runFilePath } from '../../../../mesh/src/problemtype/caseFile';
import { parseRunJson, reconcileStatus } from '../../../../mesh/src/problemtype/runFile';
import { isPidAlive } from '../../../../mesh/src/problemtype/runProcess';
import { latestResultFile } from '../../../../mesh/src/problemtype/runCore';
import { meshStem } from '../../../../mesh/src/parser/meshFormats';
import { makeReview, reviewHtml } from './review';
import { compareVariants, comparisonHtml } from './comparison';
export interface WorkflowDeps {
  root(): string | undefined;
  activeMesh(): string | undefined;
  runtime: Pick<KratosRuntime, 'discover'>;
  environment(): { python: string; env: NodeJS.ProcessEnv; bundledPython?: string; installPath?: string; extraEnv?: Record<string, string> };
  open(file: string): Promise<void>;
  changed(): void;
  callMcpTool?(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: string }[] }>;
  toolReady?(key: 'cad' | 'mesh'): boolean;
  prepareQueue?(): Promise<void>;
}
interface QueuePreview { projectRevision: number; studyRevision: string; studyId: string; tasks: Task[]; summary: string[]; studies?: Study[] }
const text = (args: Record<string, unknown>, key: string): string => {
  if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`${key} is required.`);
  return args[key];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
class WorkflowToolError extends Error { constructor(message: string, readonly uncertain: boolean) { super(message); } }
const relativeOutput = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`${what} must be a safe project-relative path.`);
  return value;
};
const appReceiptState = (value: unknown): TaskState => {
  if (value === 'succeeded' || value === 'failed' || value === 'cancelled' || value === 'running' || value === 'dispatching' || value === 'uncertain') return value;
  return 'uncertain';
};
function changedJsonPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (fingerprint(before) === fingerprint(after)) return [];
  if (object(before) && object(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap(key => changedJsonPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
  }
  return [prefix || '(root)'];
}
export class WorkflowService {
  private stores = new Map<string, ProjectStore>();
  private report?: { key: string; baseKey: string; value: EnvironmentReport };
  private selected?: { projectId: string; studyId?: string; runId?: string };
  private queue: ExecutionQueue;
  private previews = new Map<string, QueuePreview>();
  private queueTimer?: ReturnType<typeof setInterval>;
  private queueContext: unknown[] = [];
  constructor(private readonly deps: WorkflowDeps) {
    this.queue = new ExecutionQueue({
      validate: (task, store) => this.validateQueuedTask(task, store),
      dispatch: (task, store) => this.dispatchQueuedTask(task, store),
      lookup: (task, store) => this.lookupQueuedTask(task, store),
      cancel: (task, store) => this.cancelQueuedTask(task, store),
    } satisfies Runner);
  }
  store(): ProjectStore {
    const root = this.deps.root();
    if (!root) throw new Error('Choose a project folder on Home first.');
    let store = this.stores.get(root);
    if (!store) { store = new ProjectStore(root); this.stores.set(root, store); }
    return store;
  }
  context(): string {
    const baseKey = fingerprint({ ...this.deps.environment(), root: this.deps.root(), mesh: this.deps.activeMesh() });
    const report = this.report?.baseKey === baseKey ? this.report.value : undefined;
    return JSON.stringify({ ...this.selected, runtime: report ? { manual: report.manual.available, tools: report.tools.available, checkedAt: report.checkedAt } : 'not checked or settings changed', queue: this.queueContext });
  }
  async environment(): Promise<EnvironmentReport> {
    let problemtype: string | undefined;
    const mesh = this.deps.activeMesh();
    if (this.deps.root()) {
      const project = await this.store().read();
      const study = project?.studies.find(s => s.id === project.activeStudyId);
      if (object(study?.caseSettings)) problemtype = typeof study.caseSettings.problemtypeId === 'string' ? study.caseSettings.problemtypeId : undefined;
    }
    if (!problemtype && mesh) {
      try { problemtype = parseCaseJson(await fs.readFile(caseFilePath(mesh), 'utf8')).state?.problemtypeId; } catch { /* No selected case. */ }
    }
    const baseKey = fingerprint({ ...this.deps.environment(), root: this.deps.root(), mesh });
    const key = fingerprint({ baseKey, problemtype });
    if (this.report?.key === key) return this.report.value;
    const value = await this.environmentFor(problemtype, this.deps.root() ?? (mesh ? path.dirname(mesh) : process.cwd()));
    this.report = { key, baseKey, value };
    this.deps.changed();
    return value;
  }
  private async environmentFor(problemtype: string | undefined, directory: string): Promise<EnvironmentReport> {
    const config = this.deps.environment();
    const stage = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtype)?.decl.analysisStage;
    const application = stage?.match(/^(KratosMultiphysics\.[A-Za-z_][A-Za-z0-9_]*Application)\./)?.[1];
    return checkEnvironment({ ...config, directory, applications: application ? [application] : [], requirementsComplete: !!application, runtime: this.deps.runtime });
  }
  async snapshot(): Promise<unknown> {
    if (!this.deps.root()) { this.selected = undefined; return { project: null }; }
    const store = this.store();
    await this.queue.register(store);
    this.startQueuePolling();
    const project = await store.read();
    this.selected = project && { projectId: project.id, studyId: project.activeStudyId, runId: project.activeRunId };
    const activeStudy = project?.studies.find(s => s.id === project.activeStudyId);
    let problemtypeId = object(activeStudy?.caseSettings) && typeof activeStudy.caseSettings.problemtypeId === 'string' ? activeStudy.caseSettings.problemtypeId : undefined;
    if (!problemtypeId && this.deps.activeMesh()) {
      try { problemtypeId = parseCaseJson(await fs.readFile(caseFilePath(this.deps.activeMesh()!), 'utf8')).state?.problemtypeId; } catch { /* No case sidecar. */ }
    }
    const reportKey = fingerprint({ baseKey: fingerprint({ ...this.deps.environment(), root: this.deps.root(), mesh: this.deps.activeMesh() }), problemtype: problemtypeId });
    if (this.report && this.report.key !== reportKey) this.report = undefined;
    this.queueContext = project?.queue.tasks.filter(t => ['dispatching', 'running', 'uncertain'].includes(t.state)).map(t => ({ id: t.id, studyId: t.studyId, runId: t.runId, kind: t.kind, state: t.state })) ?? [];
    return { project: project ?? null, queuePlanRevision: project ? planRevision(project.queue.tasks) : undefined,
      readiness: Object.fromEntries(await Promise.all((project?.studies ?? []).map(async s => [s.id, await readiness(store.root, s)]))), environment: this.report?.value };
  }
  private startQueuePolling(): void {
    if (this.queueTimer) return;
    this.queueTimer = setInterval(() => {
      void (async () => {
        await this.queue.tick();
        for (const store of this.stores.values()) await this.persistTerminalQueueRuns(store);
        await this.snapshot();
        this.deps.changed();
      })().catch(error => console.error('[workflow queue]', error));
    }, 3000);
    this.queueTimer.unref?.();
  }
  private async change<T>(fn: (project: Project, store: ProjectStore) => T | Promise<T>): Promise<T> {
    const store = this.store();
    const result = await store.update(p => fn(p, store));
    this.report = undefined;
    await this.snapshot(); this.deps.changed();
    return result;
  }
  private study(project: Project, id: string): Study {
    const study = project.studies.find(s => s.id === id);
    if (!study) throw new Error('Unknown study.');
    return study;
  }
  private async attachMesh(args: Record<string, unknown>): Promise<unknown> {
    const file = path.resolve(text(args, 'meshPath')), revision = await fileRevision(file);
    let caseState: Json | undefined;
    try {
      const parsed = parseCaseJson(await fs.readFile(caseFilePath(file), 'utf8'));
      if (parsed.state) caseState = JSON.parse(JSON.stringify(parsed.state)) as Json;
    } catch { /* The mesh can be attached before case setup. */ }
    return this.change((p, store) => {
      const study = this.study(p, text(args, 'studyId'));
      study.mesh = reference(store.root, file, revision);
      study.meshSourceRevision = study.source.revision;
      study.meshOptionsRevision = fingerprint(study.meshing);
      study.caseSettings = caseState ?? null;
      study.caseMeshRevision = caseState ? revision : undefined;
      p.activeStudyId = study.id; delete p.activeRunId;
      return { mesh: study.mesh, caseAvailable: !!caseState };
    });
  }
  private async importHandoff(args: Record<string, unknown>): Promise<Study> {
    const store = this.store();
    let raw: unknown;
    try { raw = JSON.parse(await fs.readFile(path.resolve(text(args, 'manifestPath')), 'utf8')); }
    catch (error) { throw new Error(`Cannot read handoff manifest: ${error instanceof Error ? error.message : String(error)}`); }
    if (!object(raw)) throw new Error('Handoff manifest must be a JSON object.');
    if (raw.version !== 1) throw new Error(`Unsupported CAD handoff schema version ${String(raw.version)}. The project was not modified.`);
    const validReference = (value: unknown): value is { kind: 'project' | 'external'; path: string; revision: string } => object(value) &&
      (value.kind === 'project' || value.kind === 'external') && typeof value.path === 'string' && typeof value.revision === 'string' && /^[a-f0-9]{64}$/i.test(value.revision);
    if (typeof raw.exportId !== 'string' || !raw.exportId || !validReference(raw.source) || typeof raw.replayRevision !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(raw.replayRevision) || !object(raw.units) || typeof raw.units.scale !== 'number' ||
        !object(raw.options) || typeof raw.engine !== 'string' || typeof raw.engineVersion !== 'string' ||
        typeof raw.engineVersionSource !== 'string' || !Array.isArray(raw.artifacts) || !Array.isArray(raw.groups) ||
        !object(raw.boundaryCoverage) || typeof raw.boundaryCoverage.state !== 'string' || typeof raw.boundaryCoverage.reason !== 'string' || !Array.isArray(raw.findings)) {
      throw new Error('Handoff manifest is missing required version-1 fields. The project was not modified.');
    }
    const meshArtifact = raw.artifacts.find((entry: unknown) => object(entry) && entry.role === 'mesh' && entry.ownerId === raw.exportId && validReference(entry.reference));
    if (!object(meshArtifact) || !validReference(meshArtifact.reference)) throw new Error('Handoff has no owned mesh artifact. The project was not modified.');
    const sourceFile = resolveReference(store.root, raw.source);
    const meshFile = resolveReference(store.root, meshArtifact.reference);
    const [sourceRevision, meshRevision] = await Promise.all([fileRevision(sourceFile), fileRevision(meshFile)]);
    if (sourceRevision !== raw.source.revision) throw new Error('Handoff source is missing or changed. Relink the geometry and export a fresh handoff.');
    if (meshRevision !== meshArtifact.reference.revision) throw new Error('Handoff mesh is missing or changed. Export a fresh handoff before attaching it.');
    const source = reference(store.root, sourceFile, raw.source.revision);
    const mesh = reference(store.root, meshFile, meshArtifact.reference.revision);
    const handoff: Handoff = {
      version: 1,
      exportId: raw.exportId,
      source,
      replayRevision: raw.replayRevision,
      units: { length: typeof raw.units.length === 'string' ? raw.units.length : null, scale: raw.units.scale },
      options: JSON.parse(JSON.stringify(raw.options)) as Json,
      engine: raw.engine,
      engineVersion: raw.engineVersion,
      engineVersionSource: raw.engineVersionSource,
      artifacts: raw.artifacts.filter((entry: unknown) => object(entry) && typeof entry.role === 'string' && typeof entry.ownerId === 'string' && validReference(entry.reference))
        .map((entry: Record<string, unknown>) => {
          const artifactReference = entry.reference as Handoff['source'];
          return { role: entry.role as string, ownerId: entry.ownerId as string, reference: reference(store.root, resolveReference(store.root, artifactReference), artifactReference.revision) };
        }),
      groups: raw.groups.filter((group: unknown) => object(group) && typeof group.name === 'string' && typeof group.id === 'string' && Number.isInteger(group.dimension) && typeof group.count === 'number') as Handoff['groups'],
      boundaryCoverage: { state: raw.boundaryCoverage.state === 'checked' ? 'checked' : 'unavailable', reason: raw.boundaryCoverage.reason },
      findings: raw.findings.filter((finding: unknown) => object(finding) && ['error', 'warning', 'unavailable'].includes(String(finding.severity)) && typeof finding.message === 'string') as Handoff['findings'],
    };
    const meshing = JSON.parse(JSON.stringify(raw.options)) as Json;
    const study: Study = { id: randomUUID(), name: text(args, 'name'), source, mesh, meshing, meshSourceRevision: source.revision,
      meshOptionsRevision: fingerprint(meshing), caseSettings: null, runs: [], handoff };
    return this.change(p => { p.studies.push(study); p.activeStudyId = study.id; delete p.activeRunId; return study; });
  }
  private setStudySettings(project: Project, studyId: string, args: Record<string, unknown>): unknown {
    const study = this.study(project, studyId);
    if (args.meshing !== undefined) {
      if (!object(args.meshing)) throw new Error('Meshing settings must be a JSON object.');
      study.meshing = JSON.parse(JSON.stringify(args.meshing)) as Json;
    }
    if (args.caseSettings !== undefined) {
      if (args.caseSettings !== null && !object(args.caseSettings)) throw new Error('Case settings must be a JSON object or null.');
      study.caseSettings = JSON.parse(JSON.stringify(args.caseSettings)) as Json;
      study.caseMeshRevision = study.mesh?.revision;
    }
    return { studyId: study.id, meshOptionsRevision: fingerprint(study.meshing), caseMeshRevision: study.caseMeshRevision };
  }
  private async importRun(args: Record<string, unknown>): Promise<Run> {
    const store = this.store();
    const project = await store.read(); if (!project) throw new Error('No project.');
    const study = this.study(project, text(args, 'studyId'));
    if (!study.mesh) throw new Error('Attach the study mesh first.');
    const meshPath = resolveReference(store.root, study.mesh);
    const parsedRun = parseRunJson(await fs.readFile(runFilePath(meshPath), 'utf8'));
    if (!parsedRun.sidecar) throw new Error(`No usable run record: ${parsedRun.warnings.join(' ')}`);
    const resolved = reconcileStatus(parsedRun.sidecar, parsedRun.sidecar.pid === undefined ? undefined : isPidAlive(parsedRun.sidecar.pid));
    if (!['finished', 'failed', 'cancelled'].includes(resolved.status)) throw new Error(`Cannot import a ${resolved.status} run. Wait for a terminal state or repair the source run record.`);
    const parsedCase = parseCaseJson(await fs.readFile(caseFilePath(meshPath), 'utf8'));
    if (!parsedCase.state) throw new Error(`No usable case snapshot: ${parsedCase.warnings.join(' ')}`);
    const id = randomUUID(), directory = `.kkss/runs/${id}`, inputDir = path.join(store.root, directory, 'input');
    await fs.mkdir(inputDir, { recursive: true });
    const savedMesh = path.join(inputDir, path.basename(meshPath));
    await fs.copyFile(meshPath, savedMesh);
    const copied = [savedMesh];
    const stem = meshStem(meshPath);
    const names = new Set([path.basename(caseFilePath(meshPath)), 'ProjectParameters.json', 'MainKratos.py', 'kkss-convergence-v1.jsonl', `${stem}_case.mdpa`]);
    const materials = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === parsedCase.state!.problemtypeId)?.decl.materialsFileName;
    if (materials) names.add(materials);
    try { for (const name of await fs.readdir(path.dirname(meshPath))) if (/materials.*\.json$/i.test(name)) names.add(name); } catch { /* Snapshot omissions stay explicit. */ }
    for (const name of names) {
      const from = path.join(path.dirname(meshPath), name);
      try {
        const stat = await fs.stat(from);
        if (stat.isFile() && stat.size <= 25_000_000) { const to = path.join(inputDir, name); await fs.copyFile(from, to); copied.push(to); }
      } catch { /* Missing input files remain visible as omitted review evidence. */ }
    }
    const runState = resolved.status === 'finished' ? 'succeeded' : resolved.status === 'failed' ? 'failed' : 'cancelled';
    const artifacts = await Promise.all(copied.map(async file => ({ role: path.resolve(file) === path.resolve(savedMesh) ? 'mesh' : path.basename(file) === 'kkss-convergence-v1.jsonl' ? 'convergence' : 'input', ownerId: id, reference: reference(store.root, file, await fileRevision(file)) })));
    const run: Run = { id, studyId: study.id, sourceRevision: study.source.revision, meshRevision: study.mesh.revision,
      settings: JSON.parse(JSON.stringify(parsedCase.state)) as Json, directory, state: runState, artifacts,
      startedAt: parsedRun.sidecar.startedAt,
      ...(parsedRun.sidecar.endedAt !== undefined ? { finishedAt: parsedRun.sidecar.endedAt } : {}) };
    try {
      const outputDir = path.join(path.dirname(meshPath), 'vtk_output');
      const latest = latestResultFile(await fs.readdir(outputDir));
      if (latest) { const result = path.join(outputDir, latest.fileName); run.artifacts.push({ role: 'result', ownerId: id, reference: reference(store.root, result, await fileRevision(result)) }); }
    } catch { /* Review records a missing result. */ }
    await store.update(p => { this.study(p, study.id).runs.push(run); p.activeStudyId = study.id; p.activeRunId = id; });
    await this.snapshot(); this.deps.changed(); return run;
  }
  private async buildRunReview(studyId: string, runId: string) {
    const store = this.store(), project = await store.read(); if (!project) throw new Error('No project.');
    const study = this.study(project, studyId), run = study.runs.find(r => r.id === runId);
    if (!run || run.studyId !== study.id) throw new Error('Run does not belong to this study.');
    const mesh = run.artifacts.find(a => a.role === 'mesh' && a.ownerId === run.id);
    const convergenceArtifact = run.artifacts.find(a => a.role === 'convergence' && a.ownerId === run.id);
    const resultArtifacts = run.artifacts.filter(a => a.role === 'result' && a.ownerId === run.id);
    let meshText: string | undefined;
    let convergenceText: string | undefined;
    const currentResultReferences = new Set<string>();
    let staleResults = 0;
    if (mesh) {
      const file = resolveReference(store.root, mesh.reference);
      if (await fileRevision(file) === mesh.reference.revision && path.extname(file).toLowerCase() === '.mdpa') meshText = await fs.readFile(file, 'utf8');
    }
    if (convergenceArtifact) {
      const file = resolveReference(store.root, convergenceArtifact.reference);
      if (await fileRevision(file) === convergenceArtifact.reference.revision) convergenceText = await fs.readFile(file, 'utf8');
    }
    for (const artifact of resultArtifacts) {
      try {
        const file = resolveReference(store.root, artifact.reference);
        if (await fileRevision(file) === artifact.reference.revision) currentResultReferences.add(fingerprint(artifact.reference));
        else staleResults++;
      } catch { staleResults++; }
    }
    const savedQuantities = run.evidence?.quantities ?? [];
    const currentQuantities = savedQuantities.filter(quantity => quantity.runId === run.id && currentResultReferences.has(fingerprint(quantity.source)));
    const staleQuantities = savedQuantities.length - currentQuantities.length;
    const review = makeReview(project.revision, study, run, meshText, convergenceText, currentQuantities, staleQuantities);
    if (!resultArtifacts.length) review.evidence.findings.push({ severity: 'unavailable', message: 'No result artifact is attached to this run.' });
    if (staleResults) review.evidence.findings.push({ severity: 'unavailable', message: `${staleResults} result artifact(s) are missing or differ from their recorded content revision.` });
    return { store, run, review };
  }
  private async evaluateRunQuantity(args: Record<string, unknown>) {
    const store = this.store(), project = await store.read();
    if (!project) throw new Error('No project.');
    const study = this.study(project, text(args, 'studyId'));
    const run = study.runs.find(row => row.id === text(args, 'runId'));
    if (!run || run.studyId !== study.id) throw new Error('Run does not belong to this study.');
    const field = text(args, 'field'), kind = text(args, 'kind'), component = text(args, 'component');
    const reduction = text(args, 'reduction'), unit = text(args, 'unit'), region = typeof args.region === 'string' && args.region.trim() ? args.region.trim() : 'global';
    if (!['Nodal', 'Elemental', 'Conditional'].includes(kind)) throw new Error('Choose Nodal, Elemental or Conditional field data.');
    if (!['scalar', 'x', 'y', 'z', 'magnitude'].includes(component)) throw new Error('Choose scalar, x, y, z or magnitude.');
    const supportedReductions = ['min', 'max', 'minAbs', 'maxAbs', 'mean', 'std', 'median', 'sum', 'count', 'q1', 'q3', 'iqr'];
    if (!supportedReductions.includes(reduction)) throw new Error('Unsupported scalar reduction.');
    if (!unit.trim()) throw new Error('Declare the quantity unit explicitly.');
    const existing = run.artifacts.find(artifact => artifact.role === 'result' && artifact.ownerId === run.id);
    let resultPath: string, resultRevision: string, resultReference: ReturnType<typeof reference>;
    if (typeof args.resultPath === 'string' && args.resultPath.trim()) {
      resultPath = path.resolve(args.resultPath);
      const knownArtifact = run.artifacts.find(artifact => artifact.role === 'result' && artifact.ownerId === run.id && resolveReference(store.root, artifact.reference) === resultPath);
      const knownPath = !!knownArtifact;
      if (!knownPath) {
        const runDirectory = path.resolve(store.root, run.directory), relative = path.relative(runDirectory, resultPath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('An explicit result file must be owned by this run directory.');
      }
      const stat = await fs.stat(resultPath);
      if (!stat.isFile()) throw new Error('Choose one concrete result file.');
      resultRevision = await fileRevision(resultPath);
      if (knownArtifact && resultRevision !== knownArtifact.reference.revision) throw new Error('The attached result changed after import. Preserve it and attach a new run before evaluating.');
      resultReference = knownArtifact?.reference ?? reference(store.root, resultPath, resultRevision);
    } else {
      if (!existing) throw new Error('This run has no attached result. Choose a result file inside its isolated run directory.');
      resultPath = resolveReference(store.root, existing.reference);
      resultRevision = await fileRevision(resultPath);
      if (resultRevision !== existing.reference.revision) throw new Error('The attached result is stale. Import or attach the correct run result before evaluating.');
      resultReference = existing.reference;
    }
    const timeStep = typeof args.timeStep === 'number' && Number.isInteger(args.timeStep) ? args.timeStep : undefined;
    const raw = await this.invokeMcp('mesh__case_evaluate_quantity', {
      path: resultPath, runId: run.id, field, kind, component, region, reduction, unit: unit.trim(), ...(timeStep !== undefined ? { timeStep } : {}),
    });
    if (raw.version !== 1 || raw.runId !== run.id || !object(raw.source) || path.resolve(String(raw.source.path ?? '')) !== resultPath || String(raw.source.revision ?? '').replace(/^sha256:/, '') !== resultRevision || !object(raw.evaluation) || !object(raw.quantity)) {
      throw new Error('Mesh returned a quantity record that does not match the selected run and result revision.');
    }
    const measured = raw.quantity;
    const evaluated = raw.evaluation;
    if (measured.runId !== run.id || measured.field !== field || measured.kind !== kind || measured.component !== component || measured.region !== region || measured.reduction !== reduction || measured.unit !== unit.trim() || !Number.isFinite(evaluated.time)) {
      throw new Error('Mesh returned a quantity record with a different evaluation definition.');
    }
    const quantity: Quantity = {
      field, kind: kind as Quantity['kind'], component, region, time: Number(evaluated.time), reduction,
      unit: unit.trim(), value: typeof measured.value === 'number' && Number.isFinite(measured.value) ? measured.value : null,
      runId: run.id, source: resultReference,
    };
    await store.update(p => {
      const currentStudy = this.study(p, study.id), currentRun = currentStudy.runs.find(row => row.id === run.id);
      if (!currentRun || currentRun.studyId !== currentStudy.id) throw new Error('Run ownership changed during evaluation.');
      const currentResult = currentRun.artifacts.find(artifact => artifact.role === 'result' && artifact.ownerId === currentRun.id && resolveReference(store.root, artifact.reference) === resultPath);
      if (currentResult && currentResult.reference.revision !== resultRevision) throw new Error('Result revision changed during evaluation.');
      if (!currentResult) currentRun.artifacts.push({ role: 'result', ownerId: currentRun.id, reference: resultReference });
      const evidence = currentRun.evidence ?? makeReview(p.revision, currentStudy, currentRun).evidence;
      const duplicate = evidence.quantities.findIndex(value => value.field === quantity.field && value.kind === quantity.kind && value.component === quantity.component && value.region === quantity.region && value.time === quantity.time && value.reduction === quantity.reduction && value.unit === quantity.unit && fingerprint(value.source) === fingerprint(quantity.source));
      if (duplicate >= 0) evidence.quantities[duplicate] = quantity; else evidence.quantities.push(quantity);
      evidence.findings = evidence.findings.filter(finding => !finding.message.startsWith('No current scalar quantity evaluation'));
      if (quantity.value === null) evidence.findings.push({ severity: 'unavailable', message: `The selected ${field} reduction had no finite values in region ${region} at time ${quantity.time}.` });
      currentRun.evidence = evidence;
      p.activeStudyId = currentStudy.id; p.activeRunId = currentRun.id;
    });
    this.deps.changed();
    return { quantity, runId: run.id, sourceRevision: resultRevision };
  }
  private async buildVariantComparison(studyId: string) {
    const store = this.store(), project = await store.read(); if (!project) throw new Error('No project.');
    const selected = this.study(project, studyId), parent = selected.parentId ? project.studies.find(s => s.id === selected.parentId) : selected;
    if (!parent) throw new Error('The parent study is missing; relink the variant group before comparison.');
    const studies = [parent, ...project.studies.filter(s => s.parentId === parent.id)];
    const candidates = await Promise.all(studies.map(async study => {
      const run = study.runs[study.runs.length - 1];
      const evidence = run ? (await this.buildRunReview(study.id, run.id)).review.evidence : undefined;
      return { study, ...(run ? { run } : {}), ...(evidence ? { evidence } : {}) };
    }));
    return { store, comparison: compareVariants(parent, candidates) };
  }
  private async invokeMcp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.deps.callMcpTool) throw new WorkflowToolError('MCP execution is not connected.', true);
    const result = await this.deps.callMcpTool(name, args);
    const content = result.content?.filter(row => row.type === 'text' && typeof row.text === 'string').map(row => row.text!) ?? [];
    const message = content.join('\n');
    if (result.isError) throw new WorkflowToolError(message || `${name} failed.`, /unavailable|Tool call failed|timeout|timed out|connection|closed/i.test(message));
    if (object(result.structuredContent)) return result.structuredContent;
    if (message) {
      try { const value: unknown = JSON.parse(message); if (object(value)) return value; }
      catch { /* Some read tools return plain text. */ }
    }
    return message ? { text: message } : {};
  }
  private async buildQueueTasks(store: ProjectStore, study: Study, reuseMesh: boolean, caseState: Json): Promise<{ runId: string; tasks: Task[]; problemtypeId: string; runtime: string }> {
    if (reuseMesh && !study.mesh) throw new Error('This study has no mesh to reuse.');
    if (reuseMesh && (await readiness(store.root, study)).mesh !== 'ready') throw new Error('The study mesh is stale or missing; regenerate it or repair the study before reuse.');
    const problemtypeId = object(caseState) && typeof caseState.problemtypeId === 'string' ? caseState.problemtypeId : 'structural';
    const problemtype = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtypeId);
    if (!problemtype) throw new Error(`Problemtype "${problemtypeId}" has no declared environment requirements or supported queue adapter.`);
    const runId = randomUUID();
    const runRoot = `.kkss/runs/${runId}`;
    const meshName = reuseMesh ? path.basename(study.mesh!.path) : path.basename(study.source.path).replace(/\.[^.]+$/, '.mdpa');
    const meshPath = `${runRoot}/input/${meshName}`;
    const meshTaskId = reuseMesh ? undefined : randomUUID();
    const generateTaskId = randomUUID(), solveTaskId = randomUUID();
    const caseStem = meshStem(meshPath);
    const casePath = `${path.posix.dirname(meshPath)}/${caseStem}.kratoscase.json`;
    const sourceRevision = await fileRevision(resolveReference(store.root, study.source));
    if (sourceRevision !== study.source.revision) throw new Error('Study geometry changed. Refresh or relink it before planning.');
    const environment = this.deps.environment();
    const runtimeRevision = fingerprint({ python: environment.python, installPath: environment.installPath ?? '', extraEnv: environment.extraEnv ?? {} });
    const meshOptions = object(study.meshing) ? JSON.parse(JSON.stringify(study.meshing)) as Json : {};
    const tasks: Task[] = [];
    if (meshTaskId) tasks.push({ id: meshTaskId, studyId: study.id, runId, kind: 'mesh', dependencies: [],
      args: { source: study.source as unknown as Json, output: `${runRoot}/input/${caseStem}.mdpa`, handoff: `${runRoot}/handoff.json`, options: meshOptions, sourceRevision },
      inputRevision: fingerprint({ sourceRevision, meshing: meshOptions }), requiredArtifacts: [`${runRoot}/input/${caseStem}.mdpa`, `${runRoot}/handoff.json`], state: 'waiting' });
    const generationRevision = fingerprint({ mesh: reuseMesh ? study.mesh!.revision : meshTaskId, caseState });
    tasks.push({ id: generateTaskId, studyId: study.id, runId, kind: 'generate', dependencies: meshTaskId ? [meshTaskId] : [],
      args: { mesh: meshPath, casePath, caseState, problemtype: problemtypeId,
        caseSettingsRevision: fingerprint(study.caseSettings), sourceRevision: study.source.revision,
        ...(reuseMesh ? { meshSource: study.mesh as unknown as Json, meshRevision: study.mesh!.revision } : {}) },
      inputRevision: generationRevision, requiredArtifacts: [casePath, `${runRoot}/input/ProjectParameters.json`, `${runRoot}/input/MainKratos.py`], state: 'waiting' });
    tasks.push({ id: solveTaskId, studyId: study.id, runId, kind: 'solve', dependencies: [generateTaskId],
      args: { mesh: meshPath, casePath, caseState, problemtype: problemtypeId, runDirectory: `${runRoot}/solve`, runtimeRevision,
        caseSettingsRevision: fingerprint(study.caseSettings), sourceRevision: study.source.revision,
        ...(reuseMesh ? { meshSource: study.mesh as unknown as Json, meshRevision: study.mesh!.revision } : {}) },
      inputRevision: fingerprint({ generationRevision, runtimeRevision }), requiredArtifacts: [`${runRoot}/solve/vtk_output`], state: 'waiting' });
    return { runId, tasks, problemtypeId, runtime: environment.python };
  }
  private async previewQueuePlan(studyId: string, reuseMesh: boolean): Promise<Record<string, unknown>> {
    const store = this.store(), project = await store.read();
    if (!project) throw new Error('Create a study before planning a run.');
    const study = this.study(project, studyId);
    const problemtypeId = object(study.caseSettings) && typeof study.caseSettings.problemtypeId === 'string' ? study.caseSettings.problemtypeId : 'structural';
    const problemtype = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtypeId);
    if (!problemtype) throw new Error(`Problemtype "${problemtypeId}" has no declared environment requirements or supported queue adapter.`);
    const caseState = study.caseSettings && object(study.caseSettings) ? JSON.parse(JSON.stringify(study.caseSettings)) as Json : JSON.parse(JSON.stringify(defaultCaseState(problemtype.decl))) as Json;
    const built = await this.buildQueueTasks(store, study, reuseMesh, caseState);
    const previewId = randomUUID();
    const studyRevision = fingerprint({ source: study.source, mesh: study.mesh, meshing: study.meshing, caseSettings: study.caseSettings });
    const summary = [`${built.tasks.length} tasks: ${built.tasks.map(t => t.kind).join(' → ')}`, `Run directory: .kkss/runs/${built.runId}`, `Problemtype: ${built.problemtypeId}`, `Python: ${built.runtime}`];
    this.previews.set(previewId, { projectRevision: project.revision, studyRevision, studyId, tasks: built.tasks, summary });
    while (this.previews.size > 25) this.previews.delete(this.previews.keys().next().value!);
    return { previewId, studyId, runId: built.runId, tasks: built.tasks, summary, runCount: 1, reuseMesh };
  }
  private async previewVariantQueue(studyId: string, reuseMesh: boolean, rows: { name: string; settings: Json }[]): Promise<Record<string, unknown>> {
    const store = this.store(), project = await store.read();
    if (!project) throw new Error('Create a study before planning variants.');
    if (!rows.length || rows.length > 50) throw new Error('A sweep must contain 1–50 explicit variant rows.');
    const source = this.study(project, studyId);
    const baseType = object(source.caseSettings) && typeof source.caseSettings.problemtypeId === 'string' ? source.caseSettings.problemtypeId : 'structural';
    const baseDecl = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === baseType)?.decl;
    if (!baseDecl) throw new Error(`Problemtype "${baseType}" has no declared variant schema.`);
    const baselineSettings: Json = source.caseSettings && object(source.caseSettings) ? source.caseSettings : JSON.parse(JSON.stringify(defaultCaseState(baseDecl))) as Json;
    if (rows.some(row => !object(row.settings) || row.settings.problemtypeId !== undefined && row.settings.problemtypeId !== baseType)) throw new Error('Variant rows must keep the source problemtype and provide a case settings object.');
    const studies = rows.map(row => duplicateStudy(source, row.name, reuseMesh, row.settings));
    const built = await Promise.all(studies.map(async study => {
      const plan = await this.buildQueueTasks(store, study, reuseMesh, study.caseSettings);
      return { study, ...plan };
    }));
    const previewId = randomUUID(), tasks = built.flatMap(plan => plan.tasks);
    const studyRevision = fingerprint({ source: source.source, mesh: source.mesh, meshing: source.meshing, caseSettings: source.caseSettings });
    const summary = [`${tasks.length} tasks for ${rows.length} variants`, `Mesh: ${reuseMesh ? 'reuse immutable source mesh' : 'regenerate for each variant'}`,
      ...built.map(({ study, runId }) => `${study.name}: ${changedJsonPaths(baselineSettings, study.caseSettings).join(', ') || 'no setting differences'} → .kkss/runs/${runId}`)];
    this.previews.set(previewId, { projectRevision: project.revision, studyRevision, studyId, tasks, summary, studies });
    while (this.previews.size > 25) this.previews.delete(this.previews.keys().next().value!);
    return { previewId, studyId, runCount: rows.length, reuseMesh, summary, variants: built.map(({ study, runId }) => ({ id: study.id, name: study.name, runId, destination: `.kkss/runs/${runId}`, differences: changedJsonPaths(baselineSettings, study.caseSettings) })) };
  }
  private async previewParameterQueue(studyId: string, reuseMesh: boolean, parameterPath: string, values: Json[]): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(parameterPath)) throw new Error('Parameter path must use dotted object keys.');
    if (!values.length || values.length > 50) throw new Error('A parameter sweep must contain 1–50 values.');
    const project = await this.store().read();
    if (!project) throw new Error('Create a study before planning variants.');
    const source = this.study(project, studyId);
    const problemtypeId = object(source.caseSettings) && typeof source.caseSettings.problemtypeId === 'string' ? source.caseSettings.problemtypeId : 'structural';
    const decl = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtypeId)?.decl;
    if (!decl) throw new Error(`Problemtype "${problemtypeId}" has no declared parameter schema.`);
    const base = source.caseSettings && object(source.caseSettings) ? source.caseSettings : defaultCaseState(decl) as unknown as Json;
    const keys = parameterPath.split('.');
    const rows = values.map(value => {
      const settings = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      let target = settings;
      for (const key of keys.slice(0, -1)) {
        if (!object(target[key])) throw new Error(`Parameter path "${parameterPath}" does not exist in the case settings.`);
        target = target[key] as Record<string, unknown>;
      }
      const last = keys[keys.length - 1];
      if (!(last in target)) throw new Error(`Parameter path "${parameterPath}" does not exist in the case settings.`);
      target[last] = value;
      return { name: `${parameterPath}=${typeof value === 'string' ? value : JSON.stringify(value)}`, settings: settings as Json };
    });
    return this.previewVariantQueue(studyId, reuseMesh, rows);
  }
  private async enqueuePreview(previewId: string): Promise<{ planRevision: string; tasks: Task[] }> {
    const preview = this.previews.get(previewId);
    if (!preview) throw new Error('That queue preview expired. Preview the concrete plan again.');
    const store = this.store(), project = await store.read();
    const study = project?.studies.find(s => s.id === preview.studyId);
    if (!project || !study || fingerprint({ source: study.source, mesh: study.mesh, meshing: study.meshing, caseSettings: study.caseSettings }) !== preview.studyRevision) {
      throw new Error('Study inputs changed after preview. Build and approve a new concrete plan.');
    }
    this.previews.delete(previewId);
    const revision = await this.queue.enqueue(store, preview.tasks, preview.studies);
    await this.snapshot(); this.deps.changed();
    return { planRevision: revision, tasks: preview.tasks };
  }
  private async queuedTool(task: Task, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const key = name.startsWith('cad__') ? 'cad' : 'mesh';
    if (this.deps.toolReady && !this.deps.toolReady(key)) throw new WorkflowToolError(`${key} MCP server is unavailable. Start it and resume the paused queue.`, true);
    return this.invokeMcp(name, args);
  }
  private async validateQueuedTask(task: Task, store: ProjectStore): Promise<string[]> {
    const errors: string[] = [], project = await store.read();
    if (!project) return ['Project metadata is missing.'];
    const study = project.studies.find(s => s.id === task.studyId);
    if (!study) return ['The task study no longer exists.'];
    const runtime = this.deps.environment();
    if (typeof task.args.caseSettingsRevision === 'string' && fingerprint(study.caseSettings) !== task.args.caseSettingsRevision) errors.push('Case settings changed after preview; approve a new plan.');
    if (task.kind === 'mesh') {
      if (this.deps.toolReady && !this.deps.toolReady('cad')) errors.push('CAD MCP server is unavailable.');
      if (fingerprint(study.meshing) !== fingerprint(task.args.options)) errors.push('Meshing settings changed after preview; approve a new plan.');
      const source = task.args.source as unknown as Study['source'];
      try {
        if (resolveReference(store.root, source) !== resolveReference(store.root, study.source) || await fileRevision(resolveReference(store.root, source)) !== source.revision) errors.push('Geometry source changed after queue preview.');
      } catch { errors.push('Geometry source is missing; relink it before dispatch.'); }
      return errors;
    }
    if (this.deps.toolReady && !this.deps.toolReady('mesh')) errors.push('Mesh MCP server is unavailable.');
    const mesh = resolveReference(store.root, { kind: 'project', path: relativeOutput(task.args.mesh, 'Mesh path'), revision: '' });
    let validationMesh = mesh;
    try { await fs.access(mesh); }
    catch {
      if (object(task.args.meshSource)) {
        const source = task.args.meshSource as unknown as NonNullable<Study['mesh']>;
        try {
          validationMesh = resolveReference(store.root, source);
          if (await fileRevision(validationMesh) !== source.revision) errors.push('Reused mesh changed after preview.');
        } catch { errors.push('Reused mesh is missing.'); }
      } else errors.push('Mesh artifact is missing; complete its dependency first.');
    }
    const state = task.args.caseState;
    const problemtype = typeof task.args.problemtype === 'string' ? task.args.problemtype : undefined;
    if (!object(state) || !problemtype) return [...errors, 'Case state or problemtype is incomplete.'];
    const validation = await this.queuedTool(task, 'mesh__case_validate', { meshPath: validationMesh, problemtype, state }).catch(error => {
      errors.push(error instanceof Error ? error.message : String(error)); return undefined;
    });
    if (validation && validation.ok !== true) errors.push(...(Array.isArray(validation.issues) ? validation.issues.filter((v): v is string => typeof v === 'string') : ['Case validation did not confirm the inputs.']));
    if (task.kind === 'solve') {
      const report = await this.environmentFor(problemtype, store.root);
      if (!report.requirementsComplete) errors.push('Problemtype prerequisites are incomplete or not declared.');
      if (!report.manual.available) errors.push(report.manual.reason ?? 'Manual solver runtime is unavailable.');
      if (fingerprint({ python: runtime.python, installPath: runtime.installPath ?? '', extraEnv: runtime.extraEnv ?? {} }) !== task.args.runtimeRevision) errors.push('Solver runtime settings changed after preview; approve a new plan.');
    }
    return errors;
  }
  private async dispatchQueuedTask(task: Task, store: ProjectStore): Promise<Receipt> {
    const root = store.root, ownerId = task.studyId;
    const outputReceipt = async (state: TaskState, files: { role: string; path: string; revision?: string }[], jobId?: string, message?: string): Promise<Receipt> => ({
      version: 1, requestId: task.id, ownerId, ...(jobId ? { jobId } : {}), state,
      artifacts: await Promise.all(files.map(async file => ({ role: file.role, ownerId: task.runId,
        reference: reference(root, file.path, file.revision ?? await fileRevision(file.path)) }))), ...(message ? { message } : {}),
    });
    const abs = (rel: unknown, what: string) => resolveReference(root, { kind: 'project', path: relativeOutput(rel, what), revision: '' });
    try {
      if (task.kind === 'mesh') {
        const source = task.args.source as unknown as Study['source'];
        const outputPath = abs(task.args.output, 'Mesh destination'), handoffPath = abs(task.args.handoff, 'Handoff destination');
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const result = await this.queuedTool(task, 'cad__export_mesh', { path: resolveReference(root, source), format: 'mdpaElements', outputPath,
          handoffPath, options: task.args.options as Record<string, unknown> });
        const written = Array.isArray(result.written) ? result.written.filter((row): row is { path: string } => object(row) && typeof row.path === 'string') : [];
        const artifacts = await Promise.all(written.map(async file => ({ role: 'mesh', path: file.path, revision: await fileRevision(file.path) })));
        const handoffFile = await fs.readFile(handoffPath, 'utf8');
        const handoff = JSON.parse(handoffFile) as Record<string, unknown>;
        if (handoff.version !== 1 || !Array.isArray(handoff.artifacts) || !artifacts.some(a => path.resolve(a.path) === outputPath)) throw new WorkflowToolError('CAD export did not produce the requested version-1 mesh handoff.', false);
        artifacts.push({ role: 'handoff', path: handoffPath, revision: await fileRevision(handoffPath) });
        return outputReceipt('succeeded', artifacts, undefined, Array.isArray(result.warnings) ? result.warnings.join('\n') : undefined);
      }
      const meshPath = abs(task.args.mesh, 'Mesh path'), casePath = abs(task.args.casePath, 'Case state path');
      const state = task.args.caseState as Record<string, unknown>, problemtype = String(task.args.problemtype);
      if (task.kind === 'generate') {
        if (object(task.args.meshSource) && !await fs.access(meshPath).then(() => true, () => false)) {
          const source = task.args.meshSource as unknown as NonNullable<Study['mesh']>;
          const sourcePath = resolveReference(root, source);
          if (await fileRevision(sourcePath) !== source.revision) throw new WorkflowToolError('Reused mesh changed or disappeared before snapshot.', false);
          await fs.mkdir(path.dirname(meshPath), { recursive: true });
          await fs.copyFile(sourcePath, meshPath, fsConstants.COPYFILE_EXCL);
        }
        await this.queuedTool(task, 'mesh__case_write_state', { meshPath, state });
        const generated = await this.queuedTool(task, 'mesh__case_generate', { meshPath, problemtype, state, casePath });
        const written = Array.isArray(generated.written) ? generated.written.filter((value): value is string => typeof value === 'string') : [];
        const files = [casePath, ...written];
        const unique = [...new Set(files)];
        return outputReceipt('succeeded', await Promise.all(unique.map(async file => ({ role: file === casePath ? 'case' : 'input', path: file, revision: await fileRevision(file) }))));
      }
      const runDirectory = abs(task.args.runDirectory, 'Run directory');
      const runtime = this.deps.environment();
      const response = await this.queuedTool(task, 'mesh__case_run', { meshPath, casePath, problemtype, generate: true, waitSeconds: 0,
        python: runtime.python, installPath: runtime.installPath ?? '', extraEnv: runtime.extraEnv ?? {},
        requestId: task.id, ownerId, runDirectory });
      if (!object(response.executionReceipt)) throw new WorkflowToolError('Runner returned no durable execution receipt; status is uncertain.', true);
      return this.receiptFromMesh(response.executionReceipt, root, task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const uncertain = error instanceof WorkflowToolError ? error.uncertain : true;
      return { version: 1, requestId: task.id, ownerId, state: uncertain ? 'uncertain' : 'failed', artifacts: [], message };
    }
  }
  private async receiptFromMesh(raw: Record<string, unknown>, root: string, task: Task): Promise<Receipt> {
    const artifacts: Receipt['artifacts'] = [];
    const omitted: string[] = [];
    if (Array.isArray(raw.artifacts)) for (const entry of raw.artifacts) {
      if (!object(entry) || typeof entry.role !== 'string' || typeof entry.path !== 'string') continue;
      const file = path.resolve(entry.path), revision = typeof entry.revision === 'string' ? entry.revision.replace(/^sha256:/, '') : '';
      if (!revision) { omitted.push(`${entry.role}: ${typeof entry.revisionUnavailable === 'string' ? entry.revisionUnavailable : 'no stable content revision was provided'}`); continue; }
      artifacts.push({ role: entry.role, ownerId: task.runId, reference: reference(root, file, revision) });
    }
    return { version: 1, requestId: task.id, ownerId: task.studyId, ...(typeof raw.jobId === 'string' ? { jobId: raw.jobId } : {}),
      state: appReceiptState(raw.state), artifacts, ...((typeof raw.message === 'string' || omitted.length) ? { message: [typeof raw.message === 'string' ? raw.message : undefined, ...(omitted.length ? [`${omitted.length} artifact(s) were not attached because they have no bounded revision: ${omitted.join('; ')}`] : [])].filter(Boolean).join('\n') } : {}),
      ...(typeof raw.createdAt === 'number' ? { startedAt: raw.createdAt } : {}), ...(typeof raw.updatedAt === 'number' ? { finishedAt: raw.updatedAt } : {}) };
  }
  private async lookupQueuedTask(task: Task, store: ProjectStore): Promise<Receipt | undefined> {
    const root = store.root;
    if (task.kind === 'solve') {
      const response = await this.queuedTool(task, 'mesh__case_status', { requestId: task.id, ownerId: task.studyId, runDirectory: resolveReference(root, { kind: 'project', path: relativeOutput(task.args.runDirectory, 'Run directory'), revision: '' }) }).catch(() => undefined);
      return response && object(response.executionReceipt) ? this.receiptFromMesh(response.executionReceipt, root, task) : undefined;
    }
    const files = task.requiredArtifacts.map(p => resolveReference(root, { kind: 'project', path: relativeOutput(p, 'Required artifact'), revision: '' }));
    try {
      for (const file of files) await fs.access(file);
      if (task.kind === 'mesh') {
        const manifestPath = resolveReference(root, { kind: 'project', path: relativeOutput(task.args.handoff, 'Handoff'), revision: '' });
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
        if (manifest.version !== 1 || !Array.isArray(manifest.artifacts)) return undefined;
        const artifact = manifest.artifacts.find((v: unknown) => object(v) && v.role === 'mesh' && object(v.reference) && v.reference.path === files[0]);
        if (!object(artifact) || !object(artifact.reference) || typeof artifact.reference.revision !== 'string' || await fileRevision(files[0]) !== artifact.reference.revision) return undefined;
      } else {
        const caseText = await fs.readFile(files[0], 'utf8'), parsed = parseCaseJson(caseText);
        if (!parsed.state || parsed.state.problemtypeId !== task.args.problemtype) return undefined;
        const projectParameters = await fs.readFile(files[1], 'utf8'); JSON.parse(projectParameters);
      }
      return { version: 1, requestId: task.id, ownerId: task.studyId, state: 'succeeded', artifacts: await Promise.all(files.map(async file => ({ role: task.kind === 'mesh' ? 'mesh' : 'input', ownerId: task.runId, reference: reference(root, file, await fileRevision(file)) }))) };
    } catch { return undefined; }
  }
  private async cancelQueuedTask(task: Task, store: ProjectStore): Promise<Receipt> {
    if (task.kind !== 'solve') return { version: 1, requestId: task.id, ownerId: task.studyId, state: 'uncertain', artifacts: [], message: 'This synchronous task has no owner-scoped cancellation endpoint.' };
    const response = await this.queuedTool(task, 'mesh__case_stop', { requestId: task.id, ownerId: task.studyId,
      runDirectory: resolveReference(store.root, { kind: 'project', path: relativeOutput(task.args.runDirectory, 'Run directory'), revision: '' }) });
    return object(response.executionReceipt) ? this.receiptFromMesh(response.executionReceipt, store.root, task) : { version: 1, requestId: task.id, ownerId: task.studyId, state: 'uncertain', artifacts: [] };
  }
  private async persistTerminalQueueRuns(store: ProjectStore = this.store()): Promise<void> {
    const project = await store.read();
    if (!project) return;
    const meshes = project.queue.tasks.filter(t => t.kind === 'mesh' && t.state === 'succeeded' && t.receipt);
    const generations = project.queue.tasks.filter(t => t.kind === 'generate' && t.state === 'succeeded' && (() => {
      const study = project.studies.find(s => s.id === t.studyId);
      return !!study && typeof t.args.caseSettingsRevision === 'string' && fingerprint(study.caseSettings) === t.args.caseSettingsRevision &&
        (fingerprint(study.caseSettings) !== fingerprint(t.args.caseState) || study.caseMeshRevision !== study.mesh?.revision);
    })());
    const terminal = project.queue.tasks.filter(t => t.kind === 'solve' && ['succeeded', 'failed', 'cancelled', 'blocked'].includes(t.state) && !project.studies.find(s => s.id === t.studyId)?.runs.some(r => r.id === t.runId));
    const attachments: { studyId: string; source: Study['source']; mesh: Study['mesh']; handoff: Handoff; sourceRevision: string; meshingRevision: string }[] = [];
    for (const task of meshes) {
      try {
        const manifestPath = resolveReference(store.root, { kind: 'project', path: relativeOutput(task.args.handoff, 'Handoff'), revision: '' });
        const raw: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (!object(raw) || raw.version !== 1 || !object(raw.source) || typeof raw.source.path !== 'string' || typeof raw.source.revision !== 'string' ||
            !object(raw.units) || typeof raw.units.scale !== 'number' || !object(raw.options) || typeof raw.engine !== 'string' ||
            typeof raw.engineVersion !== 'string' || typeof raw.engineVersionSource !== 'string' || !Array.isArray(raw.artifacts) ||
            !Array.isArray(raw.groups) || !object(raw.boundaryCoverage) || typeof raw.boundaryCoverage.state !== 'string' || typeof raw.boundaryCoverage.reason !== 'string' || !Array.isArray(raw.findings)) continue;
        const meshFile = resolveReference(store.root, { kind: 'project', path: relativeOutput(task.args.output, 'Mesh output'), revision: '' });
        const meshRevision = await fileRevision(meshFile);
        const sourceFile = raw.source.kind === 'project' || raw.source.kind === 'external' ? resolveReference(store.root, raw.source as unknown as Study['source']) : '';
        if (!sourceFile) continue;
        const sourceRevision = await fileRevision(sourceFile);
        const receiptMesh = task.receipt!.artifacts.some(a => a.role === 'mesh' && resolveReference(store.root, a.reference) === meshFile && a.reference.revision === meshRevision);
        if (!receiptMesh) continue;
        const currentStudy = project.studies.find(s => s.id === task.studyId);
        if (currentStudy?.mesh?.revision === meshRevision && currentStudy.meshSourceRevision === task.args.sourceRevision &&
            currentStudy.meshOptionsRevision === fingerprint(task.args.options) && currentStudy.handoff?.exportId === raw.exportId) continue;
        const source = reference(store.root, sourceFile, raw.source.revision);
        const mesh = reference(store.root, meshFile, meshRevision);
        const artifacts = raw.artifacts.flatMap((entry: unknown) => {
          if (!object(entry) || typeof entry.role !== 'string' || typeof entry.ownerId !== 'string' || !object(entry.reference) || typeof entry.reference.path !== 'string' || typeof entry.reference.revision !== 'string') return [];
          try { return [{ role: entry.role, ownerId: entry.ownerId, reference: reference(store.root, resolveReference(store.root, entry.reference as unknown as Study['source']), entry.reference.revision) }]; }
          catch { return []; }
        });
        attachments.push({ studyId: task.studyId, source, mesh, sourceRevision: typeof task.args.sourceRevision === 'string' ? task.args.sourceRevision : sourceRevision,
          meshingRevision: fingerprint(task.args.options), handoff: { version: 1, exportId: String(raw.exportId ?? task.id), source,
            replayRevision: String(raw.replayRevision ?? ''), units: { length: typeof raw.units.length === 'string' ? raw.units.length : null, scale: raw.units.scale },
            options: JSON.parse(JSON.stringify(raw.options)) as Json, engine: raw.engine, engineVersion: raw.engineVersion, engineVersionSource: raw.engineVersionSource,
            artifacts, groups: raw.groups as Handoff['groups'], boundaryCoverage: raw.boundaryCoverage as Handoff['boundaryCoverage'], findings: raw.findings as Handoff['findings'] } });
      } catch { /* Preserve the mesh export, but attach only verified evidence. */ }
    }
    if (!terminal.length && !attachments.length && !generations.length) return;
    await store.update(p => {
      for (const attached of attachments) {
        const study = p.studies.find(s => s.id === attached.studyId); if (!study) continue;
        study.mesh = attached.mesh; study.meshSourceRevision = attached.sourceRevision;
        study.meshOptionsRevision = attached.meshingRevision; study.handoff = attached.handoff;
      }
      for (const task of generations) {
        const study = p.studies.find(s => s.id === task.studyId); if (!study) continue;
        if (typeof task.args.caseSettingsRevision === 'string' && fingerprint(study.caseSettings) === task.args.caseSettingsRevision) {
          study.caseSettings = JSON.parse(JSON.stringify(task.args.caseState)) as Json;
          study.caseMeshRevision = study.mesh?.revision;
        }
      }
      for (const task of terminal) {
        const study = p.studies.find(s => s.id === task.studyId); if (!study) continue;
        const meshTask = p.queue.tasks.find(t => t.runId === task.runId && t.kind === 'mesh');
        const receipt = task.receipt ?? { version: 1 as const, requestId: task.id, ownerId: task.studyId, state: task.state, artifacts: [], message: task.error ?? 'A dependency did not complete.' };
        const meshArtifact = receipt.artifacts.find(a => a.role === 'mesh') ?? meshTask?.receipt?.artifacts.find(a => a.role === 'mesh');
        const meshRevision = meshArtifact?.reference.revision ?? study.mesh?.revision ?? 'missing';
        study.runs.push({ id: task.runId, studyId: study.id, sourceRevision: typeof task.args.sourceRevision === 'string' ? task.args.sourceRevision : study.source.revision, meshRevision,
          settings: task.args.caseState ?? null, directory: `.kkss/runs/${task.runId}`, state: task.state, artifacts: receipt.artifacts,
          receipt, ...(receipt.startedAt !== undefined ? { startedAt: receipt.startedAt } : {}), ...(receipt.finishedAt !== undefined ? { finishedAt: receipt.finishedAt } : {}) });
        p.activeStudyId = study.id; p.activeRunId = task.runId;
      }
    });
  }
  tools(): AppTool[] {
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], invoke: AppTool['invoke']): AppTool => ({ name: `app__${name}`, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, invoke });
    const str = { type: 'string', minLength: 1 };
    return [
      tool('check_simulation_environment', 'Check manual and tool-server runtimes independently without installing software. Reports selected case requirements and available resources.', {}, [], () => this.environment()),
      tool('study_list', 'List the current project studies and geometry-to-results readiness.', {}, [], () => this.snapshot()),
      tool('study_import_handoff', 'Import a version-1 CAD MDPA handoff after verifying current source and mesh hashes. Converts references to portable project-relative paths where possible.', { name: str, manifestPath: str }, ['name', 'manifestPath'], args => this.importHandoff(args)),
      tool('study_create', 'Create an opt-in study in the selected project, referencing existing geometry without changing it.', { name: str, source: str }, ['name', 'source'], async args => {
        const source = path.resolve(text(args, 'source')), revision = await fileRevision(source);
        return this.change((p, store) => {
          const study: Study = { id: randomUUID(), name: text(args, 'name'), source: reference(store.root, source, revision), meshing: {}, caseSettings: null, runs: [] };
          p.studies.push(study); p.activeStudyId = study.id; delete p.activeRunId; return study;
        });
      }),
      tool('study_select', 'Select a study and optionally one of its owned runs.', { studyId: str, runId: str }, ['studyId'], args => this.change(p => {
        const study = this.study(p, text(args, 'studyId'));
        if (args.runId && !study.runs.some(r => r.id === args.runId)) throw new Error('Run does not belong to this study.');
        p.activeStudyId = study.id; p.activeRunId = typeof args.runId === 'string' ? args.runId : undefined;
        return { studyId: p.activeStudyId, runId: p.activeRunId };
      })),
      tool('study_open', 'Open a study geometry, mesh/case setup, or owned result in the existing viewer.', { studyId: str, stage: { enum: ['geometry', 'mesh', 'case', 'results'] }, runId: str }, ['studyId', 'stage'], async args => {
        const store = this.store(), project = await store.read();
        if (!project) throw new Error('No project studies.');
        const study = this.study(project, text(args, 'studyId'));
        const run = study.runs.find(r => r.id === args.runId);
        const ref = args.stage === 'geometry' ? study.source : args.stage === 'mesh' || args.stage === 'case' ? study.mesh : args.stage === 'results' ? run?.artifacts.find(a => a.role === 'result' && a.ownerId === run.id)?.reference : undefined;
        if (!ref) throw new Error('No artifact at this step. Select an owned run for results.');
        const file = resolveReference(store.root, ref); await fs.access(file); await this.deps.open(file); return { opened: file };
      }),
      tool('study_duplicate', 'Duplicate settings and source references with fresh identity, without copying process or result ownership. Choose whether to reuse the mesh.', { studyId: str, name: str, reuseMesh: { type: 'boolean' } }, ['studyId', 'name', 'reuseMesh'], args => this.change(p => {
        if (typeof args.reuseMesh !== 'boolean') throw new Error('Choose whether to reuse the mesh.');
        const study = duplicateStudy(this.study(p, text(args, 'studyId')), text(args, 'name'), args.reuseMesh);
        p.studies.push(study); p.activeStudyId = study.id; delete p.activeRunId; return study;
      })),
      tool('study_attach_mesh', 'Attach an existing exported mesh to a study and record its content revision. Imports a neighboring case setup when present.', { studyId: str, meshPath: str }, ['studyId', 'meshPath'], args => this.attachMesh(args)),
      tool('study_relink_source', 'Explicitly relink a study to a geometry file after verifying it exists. Existing mesh and run artifacts are retained and become stale when their source revision differs.', { studyId: str, sourcePath: str }, ['studyId', 'sourcePath'], async args => {
        const file = path.resolve(text(args, 'sourcePath')), revision = await fileRevision(file);
        return this.change((project, current) => {
          const study = this.study(project, text(args, 'studyId'));
          study.source = reference(current.root, file, revision);
          project.activeStudyId = study.id; delete project.activeRunId;
          return { studyId: study.id, source: study.source, readiness: undefined };
        });
      }),
      tool('study_copy_source_into_project', 'Copy the currently referenced geometry into .kkss/sources without changing the source file, then switch this study to the project-local copy.', { studyId: str }, ['studyId'], async args => {
        const store = this.store(), project = await store.read(); if (!project) throw new Error('No project.');
        const study = this.study(project, text(args, 'studyId')), sourcePath = resolveReference(store.root, study.source);
        const name = `${study.id}-${randomUUID()}${path.extname(sourcePath)}`;
        const directory = path.join(store.root, '.kkss', 'sources');
        const target = path.join(directory, name), temp = `${target}.${randomUUID()}.tmp`;
        await fs.mkdir(directory, { recursive: true });
        try { await fs.copyFile(sourcePath, temp, fsConstants.COPYFILE_EXCL); await fs.rename(temp, target); }
        catch (error) { await fs.rm(temp, { force: true }); throw error; }
        const revision = await fileRevision(target);
        return this.change(p => {
          const current = this.study(p, text(args, 'studyId'));
          current.source = reference(store.root, target, revision);
          p.activeStudyId = current.id; delete p.activeRunId;
          return { studyId: current.id, source: current.source };
        });
      }),
      tool('study_set_settings', 'Set a study’s meshing options or a case-state snapshot. Changing meshing options makes the attached mesh stale.', { studyId: str, meshing: { type: 'object' }, caseSettings: { type: ['object', 'null'] } }, ['studyId'], args => this.change(p => this.setStudySettings(p, text(args, 'studyId'), args))),
      tool('study_import_run', 'Import the attached mesh’s latest completed, failed or cancelled run as an immutable study snapshot; live and unverified orphaned runs are rejected.', { studyId: str }, ['studyId'], args => this.importRun(args)),
      tool('variants_create', 'Create up to 50 explicit study variants from a preview. This creates studies only; it does not queue or run a solve.', { studyId: str, reuseMesh: { type: 'boolean' }, rows: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { name: str, settings: { type: 'object' } }, required: ['name', 'settings'], additionalProperties: false } } }, ['studyId', 'reuseMesh', 'rows'], args => this.change(p => {
        const reuseMesh = args.reuseMesh;
        if (typeof reuseMesh !== 'boolean' || !Array.isArray(args.rows) || args.rows.some(r => !object(r) || typeof r.name !== 'string' || !object(r.settings))) throw new Error('Choose mesh reuse and provide explicit variant rows.');
        const source = this.study(p, text(args, 'studyId'));
        const rows = previewVariants(source, args.rows as { name: string; settings: Json }[]);
        const variants = rows.map(row => duplicateStudy(source, row.name, reuseMesh, row.settings));
        p.studies.push(...variants); return variants;
      })),
      tool('run_review', 'Build a structured review for a terminal run. Saved scalar quantities are included only while their source result revision is current; unsupported convergence and residual diagnostics remain explicitly unavailable.', { studyId: str, runId: str }, ['studyId', 'runId'], async args => (await this.buildRunReview(text(args, 'studyId'), text(args, 'runId'))).review),
      tool('run_quantity_evaluate', 'Evaluate one explicitly selected result field and save its definition, unit, value and exact source artifact revision into the owning run evidence.', {
        studyId: str, runId: str, resultPath: str,
        field: str, kind: { enum: ['Nodal', 'Elemental', 'Conditional'] },
        component: { enum: ['scalar', 'x', 'y', 'z', 'magnitude'] }, region: str,
        timeStep: { type: 'integer' }, reduction: { enum: ['min', 'max', 'minAbs', 'maxAbs', 'mean', 'std', 'median', 'sum', 'count', 'q1', 'q3', 'iqr'] }, unit: str,
      }, ['studyId', 'runId', 'field', 'kind', 'component', 'reduction', 'unit'], args => this.evaluateRunQuantity(args)),
      tool('run_review_export', 'Export a selected run review as JSON and self-contained offline HTML.', { studyId: str, runId: str }, ['studyId', 'runId'], async args => {
        const { store, run, review } = await this.buildRunReview(text(args, 'studyId'), text(args, 'runId'));
        const directory = path.join(store.root, '.kkss', 'reviews');
        const jsonFile = path.join(directory, `${run.id}.json`), htmlFile = path.join(directory, `${run.id}.html`);
        await writeFileAtomic(jsonFile, JSON.stringify(review, null, 2) + '\n');
        await writeFileAtomic(htmlFile, reviewHtml(review));
        return { jsonFile, htmlFile, findings: review.evidence.findings };
      }),
      tool('queue_plan_preview', 'Preview a concrete mesh → case-generation → solve plan with exact project-relative destinations. This does not persist tasks or launch work.',
        { studyId: str, reuseMesh: { type: 'boolean' } }, ['studyId', 'reuseMesh'], args => {
          if (typeof args.reuseMesh !== 'boolean') throw new Error('Choose whether to reuse the study mesh.');
          return this.previewQueuePlan(text(args, 'studyId'), args.reuseMesh);
        }),
      tool('queue_variants_preview', 'Preview a capped 1–50 row simulation sweep. Creates fresh variant identities only when enqueued; this preview does not write studies or launch tasks.',
        { studyId: str, reuseMesh: { type: 'boolean' }, rows: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { name: str, settings: { type: 'object' } }, required: ['name', 'settings'], additionalProperties: false } } }, ['studyId', 'reuseMesh', 'rows'], args => {
          if (typeof args.reuseMesh !== 'boolean' || !Array.isArray(args.rows) || args.rows.some(row => !object(row) || typeof row.name !== 'string' || !object(row.settings))) throw new Error('Choose mesh reuse and provide explicit variant rows.');
          return this.previewVariantQueue(text(args, 'studyId'), args.reuseMesh, args.rows as { name: string; settings: Json }[]);
        }),
      tool('queue_parameter_sweep_preview', 'Expand one case setting dotted path and up to 50 values into a concrete paused-queue plan. This preview writes nothing and starts no runs.',
        { studyId: str, reuseMesh: { type: 'boolean' }, parameterPath: str, values: { type: 'array', minItems: 1, maxItems: 50, items: {} } }, ['studyId', 'reuseMesh', 'parameterPath', 'values'], args => {
          if (typeof args.reuseMesh !== 'boolean' || !Array.isArray(args.values)) throw new Error('Choose mesh reuse and provide parameter values.');
          return this.previewParameterQueue(text(args, 'studyId'), args.reuseMesh, text(args, 'parameterPath'), args.values as Json[]);
        }),
      tool('queue_enqueue', 'Persist a previously previewed task plan in the paused queue. No runner is called until queue_resume approves its exact plan revision.',
        { previewId: str }, ['previewId'], args => this.enqueuePreview(text(args, 'previewId'))),
      tool('queue_inspect', 'Read the persistent queue and its task receipts.', {}, [], async () => (await this.store().read())?.queue ?? { paused: true, tasks: [] }),
      tool('queue_reorder', 'Reorder waiting tasks only; dependency order is validated before persistence.',
        { taskIds: { type: 'array', items: str } }, ['taskIds'], async args => {
          if (!Array.isArray(args.taskIds) || args.taskIds.some(id => typeof id !== 'string')) throw new Error('taskIds must be a string array.');
          const store = this.store(); await this.queue.reorder(store, args.taskIds as string[]); await this.snapshot(); return (await store.read())?.queue;
        }),
      tool('queue_pause', 'Pause the persistent queue. Active owner-tracked work continues, but no waiting task is dispatched.', {}, [], async () => {
        const store = this.store(); await this.queue.pause(store); await this.snapshot(); return (await store.read())?.queue;
      }),
      tool('queue_resume', 'Resume an exact approved plan revision. The revision binds every task argument, input revision, dependency and destination.',
        { planRevision: str }, ['planRevision'], async args => {
          await this.deps.prepareQueue?.();
          const store = this.store(); await this.queue.resume(store, text(args, 'planRevision')); await this.persistTerminalQueueRuns(store); await this.snapshot(); return (await store.read())?.queue;
        }),
      tool('queue_cancel', 'Cancel a waiting task or request owner-scoped cancellation for a running solver task.', { taskId: str }, ['taskId'], async args => {
        const store = this.store(); await this.queue.cancel(store, text(args, 'taskId')); await this.snapshot(); return (await store.read())?.queue;
      }),
      tool('variants_preview', 'Preview 1–50 explicit case-setting variants without writing or launching anything.', { studyId: str, rows: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { name: str, settings: { type: 'object' } }, required: ['name', 'settings'], additionalProperties: false } } }, ['studyId', 'rows'], async args => {
        const p = await this.store().read(); if (!p) throw new Error('No project.');
        if (!Array.isArray(args.rows) || args.rows.some(r => !object(r) || typeof r.name !== 'string' || !object(r.settings))) throw new Error('Invalid variant rows.');
        return previewVariants(this.study(p, text(args, 'studyId')), args.rows as {name: string; settings: Json}[]);
      }),
      tool('variants_compare', 'Compare the parent study and its variants, retaining failed/unconverged/missing rows and comparing only saved scalar definitions with compatible units.', { studyId: str }, ['studyId'], async args => (await this.buildVariantComparison(text(args, 'studyId'))).comparison),
      tool('variants_compare_export', 'Write the current variant comparison as portable JSON and self-contained offline HTML.', { studyId: str }, ['studyId'], async args => {
        const { store, comparison } = await this.buildVariantComparison(text(args, 'studyId'));
        const directory = path.join(store.root, '.kkss', 'reviews');
        const jsonFile = path.join(directory, `variants-${comparison.parentStudyId}.json`), htmlFile = path.join(directory, `variants-${comparison.parentStudyId}.html`);
        await writeFileAtomic(jsonFile, JSON.stringify(comparison, null, 2) + '\n');
        await writeFileAtomic(htmlFile, comparisonHtml(comparison));
        return { jsonFile, htmlFile, findings: comparison.findings };
      }),
    ];
  }
}
