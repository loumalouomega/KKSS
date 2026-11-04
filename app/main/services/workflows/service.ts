import { validateRefinement, type Refinement } from './refinement';
import { discoverOutputs, resultCompanions } from '../../../../mesh/src/problemtype/outputDiscovery';
import { availableParallelism } from 'node:os';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../atomicWrite';
import { buildChecklist, type ChecklistStep } from './checklist';
import { nextIterate, type SeekSpec, type Iterate } from './goalSeek';
import { buildArchive, collectProjectReferences, packagedProject, planUnpack, readZip, unresolvedExternal, safeRelative } from './projectArchive';
import type { AppTool } from '../chat/appTools';
import { checkEnvironment, checkRemoteEnvironment, resolveThreads, type EnvironmentReport } from './environment';
import { ProjectStore, staleQuantities, fileRevision, fingerprint, readiness, reference, resolveReference, duplicateStudy, previewVariants } from './project';
import type { Evidence, Handoff, Json, Project, Quantity, Run, Study } from './contracts';
import type { KratosRuntime } from '../chat/kratosRuntime';
import { ExecutionQueue, planRevision } from './queue';
import type { Runner } from './queue';
import { RemoteRunner, type RemoteSolveSpec } from './remoteRunner';
import { MpiRunner, runLocalSh, type MpiSolveSpec } from './mpiRunner';
import { mpiPlanArgs, mpiResources, type MpiLauncher } from './mpiReceipt';
import type { SshRunner } from '../cloud/providers/ssh';
import type { Receipt, Task, TaskState } from './contracts';
import { BUILTIN_PROBLEMTYPES } from '../../../../mesh/src/problemtype/builtins';
import { defaultCaseState } from '../../../../mesh/src/problemtype/api';
import { parseCaseJson, caseFilePath, runFilePath } from '../../../../mesh/src/problemtype/caseFile';
import { parseRunJson, reconcileStatus } from '../../../../mesh/src/problemtype/runFile';
import { isPidAlive } from '../../../../mesh/src/problemtype/runProcess';
import { latestResultFile } from '../../../../mesh/src/problemtype/runCore';
import { meshStem } from '../../../../mesh/src/parser/meshFormats';
import { PREPARATION_FILE, parsePreparationReport } from '../../../../mesh/src/problemtype/preparation';
import { compareRuns } from '../../../../mesh/src/problemtype/runCompare';
import { renderRunComparisonMarkdown } from '../../../../mesh/src/problemtype/runComparisonReport';
import { makeReview, reviewHtml } from './review';
import { compareVariants, comparisonHtml } from './comparison';
import { GEOMETRY_ROW_CAP, geometryDestination, overrideVariable, sidecarCandidates, variableExpressions } from './geometrySweep';
import { parameterTables } from './parameterTable';
import { expandSweep, parseSweepMode, type SweepMode } from './sweepExpansion';
import { applyRenames, carryOverReport, collectReferences, listMdpaRegions, parseRenames, type CarryOverReport } from './regionReferences';
export interface WorkflowDeps {
  root(): string | undefined;
  activeMesh(): string | undefined;
  runtime: Pick<KratosRuntime, 'discover'>;
  environment(): { threads?: number; mpiRanks?: number; python: string; env: NodeJS.ProcessEnv; bundledPython?: string; installPath?: string; extraEnv?: Record<string, string> };
  open(file: string): Promise<void>;
  changed(): void;
  callMcpTool?(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: string }[] }>;
  toolReady?(key: 'cad' | 'mesh'): boolean;
  prepareQueue?(): Promise<void>;
  /** Set while `remote.kratosHost` is configured: solves then run on that host over ssh. */
  remote?(): { host: string; ssh: SshRunner } | undefined;
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
/** What a queue preview freezes about the runtime; `mpiRanks` joins only when set, so threaded plans keep their revision. */
const runtimeFingerprint = (e: { python: string; installPath?: string; extraEnv?: Record<string, string>; threads?: number; mpiRanks?: number }): string =>
  fingerprint({ python: e.python, installPath: e.installPath ?? '', extraEnv: e.extraEnv ?? {}, threads: e.threads ?? 0, ...(e.mpiRanks ? { mpiRanks: e.mpiRanks } : {}) });
const solveSummary = (task?: Task): string => typeof task?.args.mpiRanks === 'number'
  ? `MPI: ${task.args.mpiRanks} ranks × ${task.args.mpiThreadsPerRank} threads (${task.args.mpiLauncher}, one node)`
  : `Solver threads: ${task?.args.threads}`;
export class WorkflowService {
  private stores = new Map<string, ProjectStore>();
  private report?: { key: string; baseKey: string; value: EnvironmentReport };
  private readonly environmentCache = new Map<string, EnvironmentReport>();
  private selected?: { projectId: string; studyId?: string; runId?: string };
  private queue: ExecutionQueue;
  private previews = new Map<string, QueuePreview>();
  private queueTimer?: ReturnType<typeof setInterval>;
  private queueContext: unknown[] = [];
  constructor(private readonly deps: WorkflowDeps) {
    this.queue = new ExecutionQueue({
      validate: (task, store) => this.validateQueuedTask(task, store),
      dispatch: (task, store) => this.solveRunner(task, store)?.dispatch(task, store) ?? this.dispatchQueuedTask(task, store),
      lookup: (task, store) => this.solveRunner(task, store)?.lookup(task, store) ?? this.lookupQueuedTask(task, store),
      cancel: (task, store) => this.solveRunner(task, store)?.cancel(task, store) ?? this.cancelQueuedTask(task, store),
    } satisfies Runner, () => this.deps.remote?.() ? (RemoteRunner.lastCpuCount ?? 1) : availableParallelism());
  }
  /**
   * The ssh runner for a solve task while a remote Kratos host is set, else
   * undefined (local MCP path). Solves run `python3 MainKratos.py` from the
   * uploaded `<run>/input` in `kkss-runs/<study>-<run>` under the login dir;
   * outputs are downloaded into the run directory with checksums once the remote receipt is terminal.
   */
  private remoteSolver(task: Task, store: ProjectStore): RemoteRunner | undefined {
    const remote = task.kind === 'solve' && typeof task.args.mpiRanks !== 'number' ? this.deps.remote?.() : undefined;
    if (!remote) return undefined;
    return new RemoteRunner(remote.host, remote.ssh, (t, s): RemoteSolveSpec => {
      const threads = typeof t.args.threads === 'number' ? String(t.args.threads) : undefined;
      return {
        inputDir: path.dirname(resolveReference(s.root, { kind: 'project', path: relativeOutput(t.args.mesh, 'Mesh path'), revision: '' })),
        localDir: resolveReference(s.root, { kind: 'project', path: relativeOutput(t.args.runDirectory, 'Run directory'), revision: '' }),
        root: s.root,
        remoteDir: `kkss-runs/${t.studyId}-${t.runId}`,
        argv: ['python3', 'MainKratos.py'],
        env: { ...(this.deps.environment().extraEnv ?? {}), ...(threads ? { OMP_NUM_THREADS: threads } : {}) },
      };
    });
  }
  /** A solve frozen with an MPI rank count runs as one launcher, here or on the ssh host; undefined otherwise. */
  private mpiSolver(task: Task, store: ProjectStore): MpiRunner | undefined {
    if (task.kind !== 'solve' || typeof task.args.mpiRanks !== 'number') return undefined;
    const remote = this.deps.remote?.();
    return new MpiRunner(remote?.host ?? '', remote?.ssh ?? runLocalSh, (t, s): MpiSolveSpec => {
      const environment = this.deps.environment();
      const delta = Object.fromEntries(Object.entries(environment.env).filter(([k, v]) => typeof v === 'string' && process.env[k] !== v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) as [string, string][]);
      return {
        inputDir: path.dirname(resolveReference(s.root, { kind: 'project', path: relativeOutput(t.args.mesh, 'Mesh path'), revision: '' })),
        localDir: resolveReference(s.root, { kind: 'project', path: relativeOutput(t.args.runDirectory, 'Run directory'), revision: '' }),
        root: s.root,
        remoteDir: remote ? `kkss-runs/${t.studyId}-${t.runId}` : path.join(s.root, '.kkss', 'runs', t.runId, 'mpi'),
        argv: [remote ? 'python3' : environment.python, 'MainKratos.py'],
        env: remote ? { ...(environment.extraEnv ?? {}) } : { ...delta, ...(environment.extraEnv ?? {}) },
        intent: { ranks: t.args.mpiRanks as number, threadsPerRank: t.args.mpiThreadsPerRank as number, launcher: t.args.mpiLauncher as MpiLauncher },
      };
    });
  }
  private solveRunner(task: Task, store: ProjectStore): Pick<Runner, 'dispatch' | 'lookup' | 'cancel'> | undefined {
    return this.mpiSolver(task, store) ?? this.remoteSolver(task, store);
  }
  store(): ProjectStore {
    const root = this.deps.root();
    if (!root) throw new Error('Choose a project folder on Home first.');
    let store = this.stores.get(root);
    if (!store) { store = new ProjectStore(root); this.stores.set(root, store); }
    return store;
  }
  context(): string {
    const baseKey = fingerprint({ ...this.deps.environment(), root: this.deps.root(), mesh: this.deps.activeMesh(), host: this.deps.remote?.()?.host });
    const report = this.report?.baseKey === baseKey ? this.report.value : undefined;
    return JSON.stringify({ ...this.selected, ...(this.deps.remote?.() ? { solvesRunOn: this.deps.remote()!.host } : {}), runtime: report ? { manual: report.manual.available, tools: report.tools.available, checkedAt: report.checkedAt } : 'not checked or settings changed', queue: this.queueContext });
  }
  async environment(force = false): Promise<EnvironmentReport> {
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
    const baseKey = fingerprint({ ...this.deps.environment(), root: this.deps.root(), mesh, host: this.deps.remote?.()?.host });
    const key = fingerprint({ baseKey, problemtype });
    if (!force && this.report?.key === key) return this.report.value;
    const value = await this.environmentFor(problemtype, this.deps.root() ?? (mesh ? path.dirname(mesh) : process.cwd()));
    this.report = { key, baseKey, value };
    this.deps.changed();
    return value;
  }
  async environmentForMesh(meshPath: string, selectedProblemtype?: string, force = false): Promise<EnvironmentReport> {
    let problemtype = selectedProblemtype;
    if (!problemtype) {
      try { problemtype = parseCaseJson(await fs.readFile(caseFilePath(meshPath), 'utf8')).state?.problemtypeId; }
      catch { /* Report incomplete requirements for an unknown or missing case. */ }
    }
    const runtime = this.deps.environment();
    const key = fingerprint({ runtime, meshPath: path.resolve(meshPath), problemtype, host: this.deps.remote?.()?.host });
    const cached = force ? undefined : this.environmentCache.get(key);
    if (cached) return cached;
    const report = await this.environmentFor(problemtype, path.dirname(meshPath));
    this.environmentCache.set(key, report);
    while (this.environmentCache.size > 32) this.environmentCache.delete(this.environmentCache.keys().next().value!);
    return report;
  }
  private async environmentFor(problemtype: string | undefined, directory: string): Promise<EnvironmentReport> {
    const config = this.deps.environment();
    const stage = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtype)?.decl.analysisStage;
    const application = stage?.match(/^(KratosMultiphysics\.[A-Za-z_][A-Za-z0-9_]*Application)\./)?.[1];
    const remote = this.deps.remote?.();
    if (remote) {
      const report = await checkRemoteEnvironment({ host: remote.host, ssh: remote.ssh, applications: application ? [application] : [], requirementsComplete: !!application });
      if (report.cpuCount) RemoteRunner.lastCpuCount = report.cpuCount;
      return report;
    }
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
    const reportKey = fingerprint({ baseKey: fingerprint({ ...this.deps.environment(), root: this.deps.root(), mesh: this.deps.activeMesh(), host: this.deps.remote?.()?.host }), problemtype: problemtypeId });
    if (this.report && this.report.key !== reportKey) this.report = undefined;
    this.queueContext = project?.queue.tasks.filter(t => ['dispatching', 'running', 'uncertain'].includes(t.state)).map(t => ({ id: t.id, studyId: t.studyId, runId: t.runId, kind: t.kind, state: t.state })) ?? [];
    return { project: project ?? null, queuePlanRevision: project ? planRevision(project.queue.tasks) : undefined,
      readiness: Object.fromEntries(await Promise.all((project?.studies ?? []).map(async s => [s.id, await readiness(store.root, s)]))), environment: this.report?.value };
  }
  /** The active study's checklist (the `study_next_step` shape), or null with no project/study. Read-only. */
  async activeNextStep(): Promise<{ studyId: string; name: string; readiness: Record<string, string>; steps: ChecklistStep[]; next?: ChecklistStep } | null> {
    if (!this.deps.root()) return null;
    const store = this.store(), project = await store.read();
    const study = project?.studies.find(s => s.id === project.activeStudyId);
    if (!project || !study) return null;
    const state = await readiness(store.root, study);
    return { studyId: study.id, name: study.name, readiness: state, ...buildChecklist(state) };
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
  /** Region paths of a mesh. Only MDPA has a cheap text listing; any other format reports why it cannot (never guesses). */
  private async meshRegions(file: string): Promise<{ regions?: string[]; reason?: string }> {
    if (path.extname(file).toLowerCase() !== '.mdpa') return { reason: 'Region listing is only available for MDPA meshes; other formats are not compared.' };
    try { return { regions: listMdpaRegions(await fs.readFile(file, 'utf8')) }; }
    catch (error) { return { reason: `Cannot read the mesh: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  private async regionReferences(args: Record<string, unknown>): Promise<unknown> {
    const store = this.store(), project = await store.read();
    if (!project) throw new Error('No project studies.');
    const study = this.study(project, text(args, 'studyId'));
    if (!study.mesh) throw new Error('This study has no attached mesh.');
    const meshFile = resolveReference(store.root, study.mesh);
    const before = await fileRevision(meshFile);
    const { regions, reason } = await this.meshRegions(meshFile);
    // The listing is only trustworthy if the mesh did not change while it was read.
    if (regions && await fileRevision(meshFile) !== before) throw new Error('The mesh changed while its regions were read. Try again.');
    return { studyId: study.id, meshRevision: before, settingsRevision: fingerprint(study.caseSettings), report: carryOverReport(collectReferences(study.caseSettings), regions, reason) };
  }
  private async renameRegions(args: Record<string, unknown>): Promise<unknown> {
    const renames = parseRenames(args.renames);
    const apply = args.apply === true;
    if (apply && (typeof args.expectedSettingsRevision !== 'string' || !args.expectedSettingsRevision)) throw new Error('expectedSettingsRevision (from app__study_region_references) is required to apply.');
    const run = (study: Study) => {
      if (study.caseSettings === null) throw new Error('This study has no case settings to rename in.');
      return applyRenames(study.caseSettings, renames);
    };
    if (!apply) {
      const store = this.store(), project = await store.read();
      if (!project) throw new Error('No project studies.');
      const study = this.study(project, text(args, 'studyId'));
      const { changed } = run(study);
      return { applied: false, wouldChange: changed, settingsRevision: fingerprint(study.caseSettings), note: 'Names only: nothing was written. Re-call with apply=true and expectedSettingsRevision to apply.' };
    }
    return this.change(p => {
      const study = this.study(p, text(args, 'studyId'));
      if (fingerprint(study.caseSettings) !== args.expectedSettingsRevision) throw new Error('The study settings changed since they were read. Read the references again before renaming.');
      const { settings, changed } = run(study);
      study.caseSettings = settings;
      return { applied: true, changed, settingsRevision: fingerprint(study.caseSettings) };
    });
  }
  private async attachMesh(args: Record<string, unknown>): Promise<unknown> {
    const file = path.resolve(text(args, 'meshPath')), revision = await fileRevision(file);
    const listing = await this.meshRegions(file);
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
      const previousSettings = study.caseSettings;
      study.caseSettings = caseState ?? null;
      study.caseMeshRevision = caseState ? revision : undefined;
      p.activeStudyId = study.id; delete p.activeRunId;
      // Reported, never acted on: the attach above is unchanged. `discarded` covers
      // the settings this attach replaced, which is where a rename would be noticed.
      const regionCarryOver: { basis: 'name-only'; current: CarryOverReport; discarded?: CarryOverReport } = {
        basis: 'name-only', current: carryOverReport(collectReferences(study.caseSettings), listing.regions, listing.reason),
      };
      if (previousSettings !== null && fingerprint(previousSettings) !== fingerprint(study.caseSettings)) {
        regionCarryOver.discarded = carryOverReport(collectReferences(previousSettings), listing.regions, listing.reason);
      }
      return { mesh: study.mesh, caseAvailable: !!caseState, regionCarryOver };
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
      boundaryCoverage: {
        state: raw.boundaryCoverage.state === 'checked' ? 'checked' : 'unavailable',
        reason: raw.boundaryCoverage.reason,
        ...(Array.isArray(raw.boundaryCoverage.emptyParts) ? { emptyParts: raw.boundaryCoverage.emptyParts.filter((name): name is string => typeof name === 'string') } : {}),
        ...(Array.isArray(raw.boundaryCoverage.unresolvedParts) ? { unresolvedParts: raw.boundaryCoverage.unresolvedParts.filter((name): name is string => typeof name === 'string') } : {}),
        ...(Number.isInteger(raw.boundaryCoverage.unassignedSurfaceCount) ? { unassignedSurfaceCount: Number(raw.boundaryCoverage.unassignedSurfaceCount) } : {}),
        ...(Array.isArray(raw.boundaryCoverage.unassignedSurfaceTags) ? { unassignedSurfaceTags: raw.boundaryCoverage.unassignedSurfaceTags.filter((tag): tag is number => typeof tag === 'number' && Number.isInteger(tag)) } : {}),
        ...(Array.isArray(raw.boundaryCoverage.overlaps) ? { overlaps: raw.boundaryCoverage.overlaps.filter((entry): entry is { dim: number; entityTag: number; groups: string[] } =>
          object(entry) && Number.isInteger(entry.dim) && Number.isInteger(entry.entityTag) && Array.isArray(entry.groups) && entry.groups.every(group => typeof group === 'string')) } : {}),
      },
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
    const names = new Set([path.basename(caseFilePath(meshPath)), 'ProjectParameters.json', 'MainKratos.py', 'kkss-convergence-v1.jsonl', 'kkss-convergence-v2.jsonl', 'kkss-resources.json', PREPARATION_FILE, `${stem}_case.mdpa`]);
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
    const artifacts = await Promise.all(copied.map(async file => ({ role: path.resolve(file) === path.resolve(savedMesh) ? 'mesh' : /^kkss-convergence-v[12]\.jsonl$/.test(path.basename(file)) ? 'convergence' : 'input', ownerId: id, reference: reference(store.root, file, await fileRevision(file)) })));
    const outputs = discoverOutputs(path.dirname(meshPath));
    const run: Run = { id, studyId: study.id, sourceRevision: study.source.revision, meshRevision: study.mesh.revision,
      settings: JSON.parse(JSON.stringify(parsedCase.state)) as Json, directory, state: runState, artifacts,
      outputFindings: outputs.findings,
      startedAt: parsedRun.sidecar.startedAt,
      ...(parsedRun.sidecar.endedAt !== undefined ? { finishedAt: parsedRun.sidecar.endedAt } : {}) };
    try {
      const value = JSON.parse(await fs.readFile(path.join(path.dirname(savedMesh), 'kkss-resources.json'), 'utf8'));
      if (value.version === 1 && Number.isSafeInteger(value.requestedThreads) && value.requestedThreads > 0 && value.effectiveThreads === value.requestedThreads) run.resources = { requestedThreads: value.requestedThreads, effectiveThreads: value.effectiveThreads };
    } catch { /* Legacy imported runs have no resource evidence. */ }
    for (const [role, files] of [['result', outputs.results], ['result-companion', outputs.companions]] as const) {
      for (const file of files) run.artifacts.push({ role, ownerId: id, reference: reference(store.root, file, await fileRevision(file)) });
    }
    await store.update(p => { this.study(p, study.id).runs.push(run); p.activeStudyId = study.id; p.activeRunId = id; });
    await this.snapshot(); this.deps.changed(); return run;
  }
  /**
   * mesh 5.17.0's in-editor run comparison, on study runs: resolves each run
   * to its solve task's run directory and renders the shared compareRuns core
   * as Markdown. A run with no solve task (an import without one) or without
   * an isolated execution receipt renders its problems instead of throwing —
   * compareRuns never throws, so neither does this.
   */
  private async compareStudyRuns(studyId: string, leftRunId: string, rightRunId: string): Promise<string> {
    const store = this.store(), project = await store.read(); if (!project) throw new Error('No project.');
    this.study(project, studyId);
    if (leftRunId === rightRunId) throw new Error('Pick two different runs to compare.');
    const dirOf = (runId: string): string => {
      const task = project.queue.tasks.find(t => t.studyId === studyId && t.runId === runId && t.kind === 'solve');
      if (!task) throw new Error(`Run ${runId} has no solve task in this study, so there is no run directory to compare.`);
      return path.resolve(store.root, relativeOutput(task.args.runDirectory, 'Run directory'));
    };
    return renderRunComparisonMarkdown(compareRuns(dirOf(leftRunId), dirOf(rightRunId)));
  }
  private async buildRunReview(studyId: string, runId: string) {    const store = this.store(), project = await store.read(); if (!project) throw new Error('No project.');
    const study = this.study(project, studyId), run = study.runs.find(r => r.id === runId);
    if (!run || run.studyId !== study.id) throw new Error('Run does not belong to this study.');
    const mesh = run.artifacts.find(a => a.role === 'mesh' && a.ownerId === run.id);
    const convergenceArtifact = run.artifacts.find(a => a.role === 'convergence' && a.ownerId === run.id && a.reference.path.endsWith('v2.jsonl')) ?? run.artifacts.find(a => a.role === 'convergence' && a.ownerId === run.id);
    const resultArtifacts = run.artifacts.filter(a => a.role === 'result' && a.ownerId === run.id);
    let meshText: string | undefined, meshFile: string | undefined;
    let meshCounts: { nodes: number; elements: number; conditions: number } | undefined, meshStatisticsUnavailableReason: string | undefined;
    let meshQuality: Json | undefined, meshQualityUnavailableReason: string | undefined;
    let convergenceText: string | undefined;
    const currentResultReferences = new Set<string>();
    let staleResults = 0;
    if (mesh) {
      try {
        const file = resolveReference(store.root, mesh.reference);
        if (await fileRevision(file) !== mesh.reference.revision) meshQualityUnavailableReason = 'the owned mesh differs from its recorded content revision.';
        else {
          meshFile = file;
          if (path.extname(file).toLowerCase() === '.mdpa') meshText = await fs.readFile(file, 'utf8');
        }
      } catch { meshQualityUnavailableReason = 'the owned mesh artifact is missing.'; }
    } else {
      meshQualityUnavailableReason = 'no owned mesh artifact is attached to this run.';
    }
    if (meshFile && !meshText) {
      try {
        const report = await this.invokeMcp('mesh__mesh_info', { path: meshFile });
        const counts = [report.nodeCount, report.elementCount, report.conditionCount];
        if (counts.some(v => !Number.isSafeInteger(v) || Number(v) < 0)) throw new Error('Mesh statistics returned incomplete counts.');
        if (await fileRevision(meshFile) !== mesh!.reference.revision) throw new Error('Mesh changed during statistics inspection.');
        meshCounts = { nodes: Number(counts[0]), elements: Number(counts[1]), conditions: Number(counts[2]) };
      } catch (error) { meshStatisticsUnavailableReason = String(error); }
    }
    if (meshFile) {
      try {
        const report = await this.invokeMcp('mesh__mesh_quality', { path: meshFile });
        if (report.overallOk === undefined || typeof report.elementCount !== 'number' || !Array.isArray(report.metrics)) {
          throw new Error('Mesh runner returned no structured quality report.');
        }
        if (await fileRevision(meshFile) !== mesh!.reference.revision) { meshCounts = undefined; meshText = undefined; throw new Error('Mesh changed during quality inspection.'); }
        meshQuality = JSON.parse(JSON.stringify(report)) as Json;
      } catch (error) {
        meshQualityUnavailableReason = error instanceof Error ? error.message : String(error);
      }
    }
    if (convergenceArtifact) {
      try {
        const file = resolveReference(store.root, convergenceArtifact.reference);
        if (await fileRevision(file) === convergenceArtifact.reference.revision) convergenceText = await fs.readFile(file, 'utf8');
      } catch { /* Missing monitor is unavailable evidence, not a failed review. */ }
    }
    for (const artifact of resultArtifacts) {
      try {
        const file = resolveReference(store.root, artifact.reference);
        if (await fileRevision(file) === artifact.reference.revision) {
          for (const companion of resultCompanions(file)) {
            const owned = run.artifacts.find(a => a.role === 'result-companion' && a.ownerId === run.id && resolveReference(store.root, a.reference) === companion);
            if (!owned || await fileRevision(companion) !== owned.reference.revision) throw new Error('Unverified result companion.');
          }
          currentResultReferences.add(fingerprint(artifact.reference));
        }
        else staleResults++;
      } catch { staleResults++; }
    }
    const companions = run.artifacts.filter(a => a.role === 'result-companion' && a.ownerId === run.id);
    for (const artifact of companions) {
      try { if (await fileRevision(resolveReference(store.root, artifact.reference)) !== artifact.reference.revision) throw new Error('changed'); }
      catch { staleResults++; currentResultReferences.clear(); }
    }
    const savedQuantities = run.evidence?.quantities ?? [];
    const currentQuantities = savedQuantities.filter(quantity => quantity.runId === run.id && currentResultReferences.has(fingerprint(quantity.source)));
    const staleQuantities = savedQuantities.length - currentQuantities.length;
    const preparationFiles = await Promise.all(run.artifacts.filter(artifact => ['case', 'input'].includes(artifact.role) && artifact.ownerId === run.id)
      .map(async artifact => {
        try {
          const current = await fileRevision(resolveReference(store.root, artifact.reference));
          return { role: artifact.role, reference: artifact.reference, state: current === artifact.reference.revision ? 'current' as const : 'changed' as const };
        } catch { return { role: artifact.role, reference: artifact.reference, state: 'missing' as const }; }
      }));
    const preparationState = preparationFiles.length === 0 ? 'unavailable' : preparationFiles.every(file => file.state === 'current') ? 'complete' : 'partial';
    const preparation: NonNullable<Evidence['preparation']> = { state: preparationState, settingsRevision: fingerprint(run.settings), files: preparationFiles };
    const reportArtifact = [...run.artifacts].reverse().find(a => a.ownerId === run.id && path.basename(a.reference.path) === PREPARATION_FILE);
    preparation.reportUnavailableReason = 'No owned upstream preparation report is attached.';
    if (reportArtifact) {
      try {
        const file = resolveReference(store.root, reportArtifact.reference);
        if (await fileRevision(file) !== reportArtifact.reference.revision) throw new Error('Preparation report changed after capture.');
        const report = parsePreparationReport(await fs.readFile(file, 'utf8'));
        if (fingerprint(report.settings) !== fingerprint(run.settings)) throw new Error('Preparation settings do not match this run.');
        for (const entry of [...report.inputs, report.sourceMesh, report.solverMesh]) {
          const input = path.join(path.dirname(file), entry.name);
          if (!run.artifacts.some(a => a.ownerId === run.id && resolveReference(store.root, a.reference) === input && a.reference.revision === entry.revision) ||
              await fileRevision(input) !== entry.revision) throw new Error(`Preparation input ${entry.name} is missing, changed or not owned by this run.`);
        }
        preparation.report = JSON.parse(JSON.stringify(report)) as Json;
        delete preparation.reportUnavailableReason;
      } catch (error) { preparation.reportUnavailableReason = String(error); }
    }
    const review = makeReview(project.revision, study, run, meshText, convergenceText, currentQuantities, staleQuantities, {
      meshCounts, meshStatisticsUnavailableReason,
      meshQuality, meshQualityUnavailableReason, preparation,
    });
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
    const verifyCompanions = async () => {
      for (const artifact of run.artifacts.filter(a => a.role === 'result-companion' && a.ownerId === run.id)) {
        if (await fileRevision(resolveReference(store.root, artifact.reference)) !== artifact.reference.revision) throw new Error('Result companion changed; review the run before evaluating quantities.');
      }
    };
    await verifyCompanions();
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
    const companionReferences = await Promise.all(resultCompanions(resultPath).map(async file => {
      const owned = run.artifacts.find(a => a.role === 'result-companion' && a.ownerId === run.id && resolveReference(store.root, a.reference) === file);
      const revision = await fileRevision(file);
      if (owned ? revision !== owned.reference.revision : run.artifacts.some(a => a.role === 'result' && resolveReference(store.root, a.reference) === resultPath)) throw new Error('Result companion is stale or has no owned revision; import the run again.');
      const relative = path.relative(path.resolve(store.root, run.directory), file);
      if (!owned && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error('A new result companion must be inside the run directory.');
      return owned?.reference ?? reference(store.root, file, revision);
    }));
    const timeStep = typeof args.timeStep === 'number' && Number.isInteger(args.timeStep) ? args.timeStep : undefined;
    if (args.time !== undefined && (typeof args.time !== 'number' || !Number.isFinite(args.time))) throw new Error('Choose a finite physical time coordinate.');
    if (args.time !== undefined && timeStep !== undefined) throw new Error('Choose either a physical time coordinate or a time-series step index.');
    const raw = await this.invokeMcp('mesh__case_evaluate_quantity', {
      path: resultPath, runId: run.id, field, kind, component, region, reduction, unit: unit.trim(),
      ...(timeStep !== undefined ? { timeStep } : {}), ...(typeof args.time === 'number' ? { time: args.time } : {}),
    });
    if (raw.version !== 1 || raw.runId !== run.id || !object(raw.source) || path.resolve(String(raw.source.path ?? '')) !== resultPath || String(raw.source.revision ?? '').replace(/^sha256:/, '') !== resultRevision || !object(raw.evaluation) || !object(raw.quantity)) {
      throw new Error('Mesh returned a quantity record that does not match the selected run and result revision.');
    }
    await verifyCompanions();
    for (const ref of companionReferences) if (await fileRevision(resolveReference(store.root, ref)) !== ref.revision) throw new Error('Result companion changed during evaluation.');
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
      for (const ref of companionReferences) if (!currentRun.artifacts.some(a => a.role === 'result-companion' && fingerprint(a.reference) === fingerprint(ref))) currentRun.artifacts.push({ role: 'result-companion', ownerId: currentRun.id, reference: ref });
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
    const comparison = compareVariants(parent, candidates);
    const tables = parameterTables(comparison, studies);
    if (tables.some(table => table.parameters.length)) comparison.parameterTables = tables;
    return { store, comparison };
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
  private async buildQueueTasks(store: ProjectStore, study: Study, reuseMesh: boolean, caseState: Json, geometry?: { variables: Record<string, string> }): Promise<{ runId: string; tasks: Task[]; problemtypeId: string; runtime: string }> {
    if (geometry && reuseMesh) throw new Error('A geometry sweep always re-meshes; mesh reuse is not possible.');
    if (reuseMesh && !study.mesh) throw new Error('This study has no mesh to reuse.');
    if (reuseMesh && (await readiness(store.root, study)).mesh !== 'ready') throw new Error('The study mesh is stale or missing; regenerate it or repair the study before reuse.');
    const problemtypeId = object(caseState) && typeof caseState.problemtypeId === 'string' ? caseState.problemtypeId : 'structural';
    const problemtype = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtypeId);
    if (!problemtype) throw new Error(`Problemtype "${problemtypeId}" has no declared environment requirements or supported queue adapter.`);
    const runId = randomUUID();
    const runRoot = `.kkss/runs/${runId}`;
    // A geometry row meshes a private copy of the model. The copy has the base file's exact bytes, so it
    // keeps the base content revision; only its copied sidecar differs (the swept variable).
    const geometryTaskId = geometry ? randomUUID() : undefined;
    let geometryTask: Task | undefined;
    if (geometry) {
      const baseSource = structuredClone(study.source);
      if (await fileRevision(resolveReference(store.root, baseSource)) !== baseSource.revision) throw new Error('Study geometry changed. Refresh or relink it before planning.');
      const destination = geometryDestination(runRoot, baseSource.path);
      const sidecars: Record<string, string> = {};
      for (const file of sidecarCandidates(resolveReference(store.root, baseSource))) {
        try { sidecars[path.basename(file)] = await fileRevision(file); } catch { /* absent sidecar: nothing to copy */ }
      }
      study.source = { kind: 'project', path: destination, revision: baseSource.revision };
      study.geometry = { baseSource, variables: { ...geometry.variables } };
      geometryTask = { id: geometryTaskId!, studyId: study.id, runId, kind: 'geometry', resources: { threads: 1, verified: true }, dependencies: [],
        args: { baseSource: baseSource as unknown as Json, destination, variables: { ...geometry.variables }, sidecarRevisions: sidecars },
        inputRevision: fingerprint({ baseRevision: baseSource.revision, variables: geometry.variables, sidecars }),
        requiredArtifacts: [destination], state: 'waiting' };
    }
    const meshName = reuseMesh ? path.basename(study.mesh!.path) : path.basename(study.source.path).replace(/\.[^.]+$/, '.mdpa');
    const meshPath = `${runRoot}/input/${meshName}`;
    const meshTaskId = reuseMesh ? undefined : randomUUID();
    const generateTaskId = randomUUID(), solveTaskId = randomUUID();
    const caseStem = meshStem(meshPath);
    const casePath = `${path.posix.dirname(meshPath)}/${caseStem}.kratoscase.json`;
    const sourceRevision = geometry ? study.source.revision : await fileRevision(resolveReference(store.root, study.source));
    if (sourceRevision !== study.source.revision) throw new Error('Study geometry changed. Refresh or relink it before planning.');
    const environment = this.deps.environment();
    const runtimeRevision = runtimeFingerprint(environment);
    let threads = resolveThreads(environment.threads, availableParallelism());
    let solveResources: NonNullable<Task['resources']> = { threads, verified: true };
    let mpiArgs: { [key: string]: Json } = {};
    if ((environment.mpiRanks ?? 0) > 0) {
      const report = await this.environmentFor(problemtypeId, store.root);
      const capability = report.manual.capabilities;
      if (!capability.mpi || !capability.mpiLauncher) throw new Error(`MPI ranks are configured (kratos.mpiRanks) but MPI is unavailable: ${capability.mpiReason ?? 'not verified'}. Set kratos.mpiRanks to 0 for a threaded run.`);
      threads = environment.threads || 1;
      const intent = { ranks: environment.mpiRanks!, threadsPerRank: threads, launcher: capability.mpiLauncher };
      if (intent.ranks * threads > report.cpuCount) throw new Error(`${intent.ranks} ranks × ${threads} threads exceed the ${report.cpuCount} available CPUs.`);
      mpiArgs = mpiPlanArgs(intent); solveResources = mpiResources(intent);
    }
    const meshOptions = object(study.meshing) ? JSON.parse(JSON.stringify(study.meshing)) as Json : {};
    const tasks: Task[] = [];
    if (geometryTask) tasks.push(geometryTask);
    if (meshTaskId) tasks.push({ id: meshTaskId, studyId: study.id, runId, kind: 'mesh', resources: { threads: 1, verified: true }, dependencies: geometryTaskId ? [geometryTaskId] : [],
      args: { source: study.source as unknown as Json, output: `${runRoot}/input/${caseStem}.mdpa`, handoff: `${runRoot}/handoff.json`, options: meshOptions, sourceRevision },
      inputRevision: fingerprint({ sourceRevision, meshing: meshOptions, ...(geometry ? { geometry } : {}) }), requiredArtifacts: [`${runRoot}/input/${caseStem}.mdpa`, `${runRoot}/handoff.json`], state: 'waiting' });
    const generationRevision = fingerprint({ mesh: reuseMesh ? study.mesh!.revision : meshTaskId, caseState });
    tasks.push({ id: generateTaskId, studyId: study.id, runId, kind: 'generate', resources: { threads: 1, verified: meshPath.toLowerCase().endsWith('.mdpa') }, dependencies: meshTaskId ? [meshTaskId] : [],
      args: { mesh: meshPath, casePath, caseState, problemtype: problemtypeId,
        caseSettingsRevision: fingerprint(study.caseSettings), sourceRevision: study.source.revision,
        ...(reuseMesh ? { meshSource: study.mesh as unknown as Json, meshRevision: study.mesh!.revision } : {}) },
      inputRevision: generationRevision, requiredArtifacts: [casePath, `${runRoot}/input/ProjectParameters.json`, `${runRoot}/input/MainKratos.py`], state: 'waiting' });
    tasks.push({ id: solveTaskId, studyId: study.id, runId, kind: 'solve', resources: solveResources, dependencies: [generateTaskId],
      args: { mesh: meshPath, casePath, caseState, problemtype: problemtypeId, runDirectory: `${runRoot}/solve`, runtimeRevision, threads, ...mpiArgs,
        caseSettingsRevision: fingerprint(study.caseSettings), sourceRevision: study.source.revision,
        ...(reuseMesh ? { meshSource: study.mesh as unknown as Json, meshRevision: study.mesh!.revision } : {}) },
      inputRevision: fingerprint({ generationRevision, runtimeRevision }), requiredArtifacts: [], state: 'waiting' });
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
    const summary = [`${built.tasks.length} tasks: ${built.tasks.map(t => t.kind).join(' → ')}`, `Run directory: .kkss/runs/${built.runId}`, `Problemtype: ${built.problemtypeId}`, `Python: ${built.runtime}`, solveSummary(built.tasks.find(t => t.kind === 'solve')), 'One solve and one preparation task may overlap within the CPU budget.'];
    this.previews.set(previewId, { projectRevision: project.revision, studyRevision, studyId, tasks: built.tasks, summary });
    while (this.previews.size > 25) this.previews.delete(this.previews.keys().next().value!);
    return { previewId, studyId, runId: built.runId, tasks: built.tasks, summary, runCount: 1, reuseMesh };
  }
  private async previewVariantQueue(studyId: string, reuseMesh: boolean, rows: { name: string; settings: Json }[], groupParentId?: string): Promise<Record<string, unknown>> {
    const store = this.store(), project = await store.read();
    if (!project) throw new Error('Create a study before planning variants.');
    if (!rows.length || rows.length > 50) throw new Error('A sweep must contain 1–50 explicit variant rows.');
    const source = this.study(project, studyId);
    const baseType = object(source.caseSettings) && typeof source.caseSettings.problemtypeId === 'string' ? source.caseSettings.problemtypeId : 'structural';
    const baseDecl = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === baseType)?.decl;
    if (!baseDecl) throw new Error(`Problemtype "${baseType}" has no declared variant schema.`);
    const baselineSettings: Json = source.caseSettings && object(source.caseSettings) ? source.caseSettings : JSON.parse(JSON.stringify(defaultCaseState(baseDecl))) as Json;
    if (rows.some(row => !object(row.settings) || row.settings.problemtypeId !== undefined && row.settings.problemtypeId !== baseType)) throw new Error('Variant rows must keep the source problemtype and provide a case settings object.');
    const studies = rows.map(row => {
      const study = duplicateStudy(source, row.name, reuseMesh, row.settings);
      if (groupParentId) study.parentId = groupParentId;
      return study;
    });
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
  private async previewGeometrySweep(studyId: string, variables: { name: unknown; values: unknown }[], mode: SweepMode = 'grid'): Promise<Record<string, unknown>> {
    if (!Array.isArray(variables) || variables.length < 1) throw new Error('Provide at least one variable.');
    const checked = variables.map(entry => variableExpressions(entry.name, entry.values));
    const expansion = expandSweep(checked.map(entry => ({ name: entry.name, values: entry.expressions })), mode);
    const store = this.store(), project = await store.read();
    if (!project) throw new Error('Create a study before planning a geometry sweep.');
    const base = this.study(project, studyId);
    const problemtypeId = object(base.caseSettings) && typeof base.caseSettings.problemtypeId === 'string' ? base.caseSettings.problemtypeId : 'structural';
    const decl = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtypeId)?.decl;
    if (!decl) throw new Error(`Problemtype "${problemtypeId}" has no declared parameter schema.`);
    const caseState = base.caseSettings && object(base.caseSettings) ? JSON.parse(JSON.stringify(base.caseSettings)) as Json : JSON.parse(JSON.stringify(defaultCaseState(decl))) as Json;
    const built = [];
    for (const swept of expansion.rows) {
      const row = duplicateStudy(base, `${base.name} ${swept.label}`, false, caseState);
      const plan = await this.buildQueueTasks(store, row, false, caseState, { variables: swept.assignment as Record<string, string> });
      built.push({ study: row, ...plan });
    }
    const previewId = randomUUID(), tasks = built.flatMap(plan => plan.tasks);
    const studyRevision = fingerprint({ source: base.source, mesh: base.mesh, meshing: base.meshing, caseSettings: base.caseSettings });
    const summary = [`Sweep: ${expansion.summary} (cap ${GEOMETRY_ROW_CAP}, shown before anything is persisted)`, `${tasks.length} tasks for ${built.length} geometry rows`, 'Each row: copy the model into its run directory → set the variable there → mesh → generate → solve. Your model is never edited.',
      'If a row loses a region the case references (matched by name only), its solve is not started.',
      ...built.map(({ study, runId }) => `${study.name} → .kkss/runs/${runId}`)];
    this.previews.set(previewId, { projectRevision: project.revision, studyRevision, studyId, tasks, summary, studies: built.map(row => row.study) });
    while (this.previews.size > 25) this.previews.delete(this.previews.keys().next().value!);
    return { previewId, studyId, runCount: built.length, reuseMesh: false, summary, expansion: { mode, count: expansion.count, summary: expansion.summary }, variants: built.map(({ study, runId }) => ({ id: study.id, name: study.name, runId, destination: `.kkss/runs/${runId}`, geometry: study.geometry })) };
  }
  private async previewParameterQueue(studyId: string, reuseMesh: boolean, parameters: { name: string; values: Json[] }[], mode: SweepMode = 'grid'): Promise<Record<string, unknown>> {
    for (const parameter of parameters) {
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(parameter.name)) throw new Error('Parameter path must use dotted object keys.');
    }
    const expansion = expandSweep(parameters, mode);
    const project = await this.store().read();
    if (!project) throw new Error('Create a study before planning variants.');
    const source = this.study(project, studyId);
    const problemtypeId = object(source.caseSettings) && typeof source.caseSettings.problemtypeId === 'string' ? source.caseSettings.problemtypeId : 'structural';
    const decl = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtypeId)?.decl;
    if (!decl) throw new Error(`Problemtype "${problemtypeId}" has no declared parameter schema.`);
    const base = source.caseSettings && object(source.caseSettings) ? source.caseSettings : defaultCaseState(decl) as unknown as Json;
    const rows = expansion.rows.map(row => {
      const settings = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      for (const [parameterPath, value] of Object.entries(row.assignment)) {
        const keys = parameterPath.split('.');
        let target = settings;
        for (const key of keys.slice(0, -1)) {
          if (!object(target[key])) throw new Error(`Parameter path "${parameterPath}" does not exist in the case settings.`);
          target = target[key] as Record<string, unknown>;
        }
        const last = keys[keys.length - 1];
        if (!(last in target)) throw new Error(`Parameter path "${parameterPath}" does not exist in the case settings.`);
        target[last] = value;
      }
      return { name: row.label, settings: settings as Json };
    });
    const preview = await this.previewVariantQueue(studyId, reuseMesh, rows);
    if (Array.isArray(preview.summary)) preview.summary = [`Sweep: ${expansion.summary} (cap 50, shown before anything is persisted)`, ...preview.summary as string[]];
    return { ...preview, expansion: { mode, count: expansion.count, summary: expansion.summary } };
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
    if (task.kind === 'geometry') {
      if (this.deps.toolReady && !this.deps.toolReady('cad')) errors.push('CAD MCP server is unavailable.');
      const base = task.args.baseSource as unknown as Study['source'];
      try {
        const baseFile = resolveReference(store.root, base);
        if (await fileRevision(baseFile) !== base.revision) errors.push('The base geometry changed after preview; approve a new plan.');
        const frozen = task.args.sidecarRevisions as Record<string, string>;
        for (const file of sidecarCandidates(baseFile)) {
          const name = path.basename(file);
          const now = await fileRevision(file).catch(() => undefined);
          if (now !== frozen[name]) errors.push(`The base model's ${name.slice(name.indexOf('.', 1))} sidecar changed after preview; approve a new plan.`);
        }
      } catch { errors.push('The base geometry is missing; relink it before dispatch.'); }
      return errors;
    }
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
    if (study.geometry && task.kind === 'generate') {
      // A changed geometry may have lost a region the case still points at. Names are all we can compare.
      const listing = await this.meshRegions(validationMesh);
      if (listing.regions) {
        const lost = carryOverReport(collectReferences(state as unknown as Json), listing.regions).regions.filter(row => row.status === 'lost');
        if (lost.length) errors.push(`With ${Object.entries(study.geometry.variables).map(([name, expression]) => `${name} = ${expression}`).join(', ')} the mesh no longer has ${lost.map(row => row.path).join(', ')}, which the case still references (matched by name only); the solve was not started.`);
      } else errors.push(`Regions could not be compared for this geometry row (${listing.reason ?? 'unknown reason'}); the solve was not started.`);
    }
    const validation = await this.queuedTool(task, 'mesh__case_validate', { meshPath: validationMesh, problemtype, state }).catch(error => {
      errors.push(error instanceof Error ? error.message : String(error)); return undefined;
    });
    if (validation && validation.ok !== true) {
      const issues = Array.isArray(validation.issues) ? validation.issues.filter((v): v is string => typeof v === 'string') : [];
      errors.push(...(issues.length ? issues : ['Case validation returned no successful status: ' + JSON.stringify(validation)]));
    }
    const remoteSolve = this.remoteSolver(task, store);
    const mpiSolve = this.mpiSolver(task, store);
    if (mpiSolve) {
      errors.push(...await mpiSolve.validate(task, store));
      if (runtimeFingerprint(runtime) !== task.args.runtimeRevision) errors.push('Solver runtime settings changed after preview; approve a new plan.');
      if (task.resources?.threads !== Number(task.args.mpiRanks) * Number(task.args.mpiThreadsPerRank)) errors.push('Solver resource reservation does not match its approved MPI allocation.');
    } else if (remoteSolve) errors.push(...await remoteSolve.validate(task, store));
    else if (task.kind === 'solve') {
      const report = await this.environmentFor(problemtype, store.root);
      if (task.resources?.verified && task.resources.threads !== task.args.threads) errors.push('Solver resource reservation does not match its approved thread count.');
      const outputReport = discoverOutputs(path.dirname(mesh));
      if (outputReport.unsafe.length) errors.push('Configured output paths must stay inside the run workspace.');
      if (!report.requirementsComplete) errors.push('Problemtype prerequisites are incomplete or not declared.');
      if (!report.manual.capabilities.threads && task.args.threads !== undefined) errors.push('Verified thread control is unavailable.');
      if (typeof task.args.threads === 'number' && task.args.threads > report.cpuCount) errors.push('CPU budget changed; approve a new plan.');
      if (!report.manual.available) errors.push(report.manual.reason ?? 'Manual solver runtime is unavailable.');
      if (runtimeFingerprint(runtime) !== task.args.runtimeRevision) errors.push('Solver runtime settings changed after preview; approve a new plan.');
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
      if (task.kind === 'geometry') {
        const base = task.args.baseSource as unknown as Study['source'];
        const baseFile = resolveReference(root, base), destination = abs(task.args.destination, 'Geometry destination');
        if (await fileRevision(baseFile) !== base.revision) throw new WorkflowToolError('The base geometry changed before it could be copied.', false);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        // Same temp + rename discipline as study_copy_source_into_project; the user's files are only ever read.
        const copyTo = async (from: string, to: string, exclusive: boolean) => {
          const temp = `${to}.${randomUUID()}.tmp`;
          try { await fs.copyFile(from, temp, fsConstants.COPYFILE_EXCL); if (exclusive && await fs.access(to).then(() => true, () => false)) throw new WorkflowToolError('The geometry copy already exists; its status is uncertain.', true); await fs.rename(temp, to); }
          catch (error) { await fs.rm(temp, { force: true }); throw error; }
        };
        await copyTo(baseFile, destination, true);
        for (const sidecar of sidecarCandidates(baseFile)) {
          if (await fs.access(sidecar).then(() => true, () => false)) await copyTo(sidecar, destination + path.basename(sidecar).slice(path.basename(baseFile).length), false);
        }
        const assignments = Object.entries(task.args.variables as Record<string, string>);
        const state = await this.queuedTool(task, 'cad__get_state', { path: destination });
        const existing = Array.isArray(state.variables) ? state.variables.filter((v): v is { name: string; expr: string } => object(v) && typeof v.name === 'string' && typeof v.expr === 'string') : [];
        let next = existing;
        try { for (const [name, expression] of assignments) next = overrideVariable(next, name, String(expression)); }
        catch (error) { throw new WorkflowToolError(error instanceof Error ? error.message : String(error), false); }
        const applied = await this.queuedTool(task, 'cad__set_variables', { path: destination, variables: next });
        for (const [name, expression] of assignments) {
          const set = Array.isArray(applied.variables) ? applied.variables.find((v: unknown) => object(v) && v.name === name) : undefined;
          if (!object(set) || set.expr !== expression || set.error) throw new WorkflowToolError(`CAD did not accept ${name} = ${String(expression)}${object(set) && set.error ? `: ${String(set.error)}` : ''}.`, false);
        }
        return outputReceipt('succeeded', [{ role: 'geometry', path: destination }]);
      }
      if (task.kind === 'mesh') {
        const source = task.args.source as unknown as Study['source'];
        const outputPath = abs(task.args.output, 'Mesh destination'), handoffPath = abs(task.args.handoff, 'Handoff destination');
        const receiptPath = abs(`.kkss/runs/${task.runId}/cad-execution.json`, 'CAD execution receipt');
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const result = await this.queuedTool(task, 'cad__export_mesh', { path: resolveReference(root, source), format: 'mdpaElements', outputPath,
          handoffPath, options: task.args.options as Record<string, unknown>, ownerId, requestId: task.id, receiptPath });
        if (!object(result.execution)) throw new WorkflowToolError('CAD runner returned no durable execution receipt; status is uncertain.', true);
        const execution = result.execution;
        if (execution.state !== 'succeeded' || !Array.isArray(execution.artifacts)) throw new WorkflowToolError('CAD runner returned a non-terminal or malformed mesh receipt.', true);
        const executionArtifacts: unknown[] = execution.artifacts;
        for (const [role, file] of [['mesh', outputPath], ['handoff', handoffPath]] as const) {
          const artifact = executionArtifacts.find((entry: unknown) => object(entry) && entry.role === role && object(entry.reference) &&
            path.resolve(String(entry.reference.path)) === file && typeof entry.reference.revision === 'string');
          if (!object(artifact) || !object(artifact.reference) || typeof artifact.reference.revision !== 'string' ||
              await fileRevision(file) !== artifact.reference.revision) {
            throw new WorkflowToolError(`CAD execution receipt is missing a verified ${role} artifact revision.`, false);
          }
        }
        const meshReceiptArtifact = executionArtifacts.find((entry: unknown) => object(entry) && entry.role === 'mesh' && object(entry.reference) &&
          path.resolve(String(entry.reference.path)) === outputPath) as { reference?: { revision?: unknown } } | undefined;
        const handoff = JSON.parse(await fs.readFile(handoffPath, 'utf8')) as Record<string, unknown>;
        if (handoff.version !== 1 || !object(handoff.source) || handoff.source.revision !== task.args.sourceRevision ||
            path.resolve(String(handoff.source.path)) !== resolveReference(root, source) || !Array.isArray(handoff.artifacts) ||
            !handoff.artifacts.some((entry: unknown) => object(entry) && entry.role === 'mesh' && object(entry.reference) &&
              path.resolve(String(entry.reference.path)) === outputPath && entry.reference.revision === meshReceiptArtifact?.reference?.revision)) {
          throw new WorkflowToolError('CAD export did not produce the requested version-1 mesh handoff for this source revision.', false);
        }
        return this.receiptFromCad(result.execution, root, task);
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
        ...(typeof task.args.threads === 'number' ? { threads: task.args.threads } : {}),
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
    if (raw.version !== 1 || raw.requestId !== task.id || raw.ownerId !== task.studyId) {
      throw new WorkflowToolError('Mesh execution receipt does not match the requested owner and request.', true);
    }
    const artifacts: Receipt['artifacts'] = [];
    const omitted: string[] = [];
    if (Array.isArray(raw.artifacts)) for (const entry of raw.artifacts) {
      if (!object(entry) || typeof entry.role !== 'string' || typeof entry.path !== 'string') continue;
      const file = path.resolve(entry.path), revision = typeof entry.revision === 'string' ? entry.revision.replace(/^sha256:/, '') : '';
      const directory = resolveReference(root, { kind: 'project', path: relativeOutput(task.args.runDirectory, 'Run directory'), revision: '' });
      if (!file.startsWith(directory + path.sep)) throw new WorkflowToolError('Mesh receipt references an artifact outside its isolated run directory.', true);
      if (!revision) { omitted.push(`${entry.role}: ${typeof entry.revisionUnavailable === 'string' ? entry.revisionUnavailable : 'no stable content revision was provided'}`); continue; }
      artifacts.push({ role: entry.role, ownerId: task.runId, reference: reference(root, file, revision) });
    }
    return { version: 1, requestId: task.id, ownerId: task.studyId, ...(typeof raw.jobId === 'string' ? { jobId: raw.jobId } : {}),
      state: appReceiptState(raw.state), artifacts,
      ...(Array.isArray(raw.outputFindings) ? { outputFindings: raw.outputFindings.filter((v): v is string => typeof v === 'string') } : {}),
      ...(object(raw.resources) && Number.isSafeInteger(raw.resources.requestedThreads) ? { resources: { requestedThreads: Number(raw.resources.requestedThreads), ...(Number.isSafeInteger(raw.resources.effectiveThreads) ? { effectiveThreads: Number(raw.resources.effectiveThreads) } : {}) } } : {}), ...((typeof raw.message === 'string' || omitted.length) ? { message: [typeof raw.message === 'string' ? raw.message : undefined, ...(omitted.length ? [`${omitted.length} artifact(s) were not attached because they have no bounded revision: ${omitted.join('; ')}`] : [])].filter(Boolean).join('\n') } : {}),
      ...(typeof raw.createdAt === 'number' ? { startedAt: raw.createdAt } : {}), ...(typeof raw.updatedAt === 'number' ? { finishedAt: raw.updatedAt } : {}) };
  }
  private receiptFromCad(raw: Record<string, unknown>, root: string, task: Task): Receipt {
    if (raw.version !== 1 || raw.requestId !== task.id || raw.ownerId !== task.studyId) {
      throw new WorkflowToolError('CAD execution receipt does not match the requested owner and request.', true);
    }
    const artifacts: Receipt['artifacts'] = [];
    if (Array.isArray(raw.artifacts)) for (const entry of raw.artifacts) {
      if (!object(entry) || typeof entry.role !== 'string' || !object(entry.reference) || typeof entry.reference.path !== 'string' || typeof entry.reference.revision !== 'string') continue;
      artifacts.push({ role: entry.role, ownerId: task.runId, reference: reference(root, entry.reference.path, entry.reference.revision) });
    }
    const timestamp = (value: unknown): number | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
    const createdAt = timestamp(raw.createdAt), updatedAt = timestamp(raw.updatedAt);
    return { version: 1, requestId: task.id, ownerId: task.studyId, ...(typeof raw.jobId === 'string' ? { jobId: raw.jobId } : {}),
      state: appReceiptState(raw.state), artifacts,
      ...(object(raw.resources) && Number.isSafeInteger(raw.resources.requestedThreads) ? { resources: { requestedThreads: Number(raw.resources.requestedThreads), ...(Number.isSafeInteger(raw.resources.effectiveThreads) ? { effectiveThreads: Number(raw.resources.effectiveThreads) } : {}) } } : {}), ...((typeof raw.message === 'string' || Array.isArray(raw.outputFindings)) ? { message: [typeof raw.message === 'string' ? raw.message : '', ...(Array.isArray(raw.outputFindings) ? raw.outputFindings.filter(v => typeof v === 'string') : [])].filter(Boolean).join(' ') } : {}),
      ...(createdAt !== undefined ? { startedAt: createdAt } : {}),
      ...(updatedAt !== undefined && ['succeeded', 'failed', 'cancelled'].includes(String(raw.state)) ? { finishedAt: updatedAt } : {}) };
  }
  private async lookupQueuedTask(task: Task, store: ProjectStore): Promise<Receipt | undefined> {
    const root = store.root;
    if (task.kind === 'solve') {
      const response = await this.queuedTool(task, 'mesh__case_status', { requestId: task.id, ownerId: task.studyId, runDirectory: resolveReference(root, { kind: 'project', path: relativeOutput(task.args.runDirectory, 'Run directory'), revision: '' }) }).catch(() => undefined);
      return response && object(response.executionReceipt) ? this.receiptFromMesh(response.executionReceipt, root, task) : undefined;
    }
    if (task.kind === 'mesh') {
      const receiptPath = resolveReference(root, { kind: 'project', path: `.kkss/runs/${task.runId}/cad-execution.json`, revision: '' });
      const response = await this.queuedTool(task, 'cad__job_status', { receiptPath, ownerId: task.studyId, requestId: task.id }).catch(() => undefined);
      if (response && response.version === 1 && response.ownerId === task.studyId && response.requestId === task.id) return this.receiptFromCad(response, root, task);
    }
    if (task.kind === 'geometry') {
      // A synchronous task: the copy plus the swept expression in its sidecar is the only proof of completion.
      const destination = resolveReference(root, { kind: 'project', path: relativeOutput(task.args.destination, 'Geometry destination'), revision: '' });
      try {
        const state = await this.queuedTool(task, 'cad__get_state', { path: destination });
        for (const [name, expression] of Object.entries(task.args.variables as Record<string, string>)) {
          const found = Array.isArray(state.variables) ? state.variables.find((v: unknown) => object(v) && v.name === name) : undefined;
          if (!object(found) || found.expr !== expression) return undefined;
        }
        return { version: 1, requestId: task.id, ownerId: task.studyId, state: 'succeeded', artifacts: [{ role: 'geometry', ownerId: task.runId, reference: reference(root, destination, await fileRevision(destination)) }] };
      } catch { return undefined; }
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
    if (task.kind === 'mesh') {
      const receiptPath = resolveReference(store.root, { kind: 'project', path: `.kkss/runs/${task.runId}/cad-execution.json`, revision: '' });
      const response = await this.queuedTool(task, 'cad__job_cancel', { receiptPath, ownerId: task.studyId, requestId: task.id });
      return object(response) && response.version === 1 ? this.receiptFromCad(response, store.root, task) : { version: 1, requestId: task.id, ownerId: task.studyId, state: 'uncertain', artifacts: [] };
    }
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
          receipt, ...(receipt.outputFindings ? { outputFindings: receipt.outputFindings } : {}), ...(receipt.resources ? { resources: receipt.resources } : {}), ...(receipt.startedAt !== undefined ? { startedAt: receipt.startedAt } : {}), ...(receipt.finishedAt !== undefined ? { finishedAt: receipt.finishedAt } : {}) });
        p.activeStudyId = study.id; p.activeRunId = task.runId;
      }
    });
  }
  /** Pack `.kkss/project.json` and every project-contained file it references into one archive. */
  async projectPack(args: Record<string, unknown>): Promise<unknown> {
    const store = this.store(), project = await store.read();
    if (!project) throw new Error('No project studies to pack.');
    const includeRuns = args.includeRuns === true, out = path.resolve(text(args, 'outputPath'));
    const files: { path: string; data: Uint8Array }[] = [], external: { owner: string; path: string }[] = [], missing: string[] = [];
    let total = 0;
    const add = async (rel: string) => {
      const data = await fs.readFile(path.join(store.root, rel));
      total += data.length;
      if (total > 2 * 1024 ** 3) throw new Error('Project is larger than the 2 GB archive limit.');
      files.push({ path: rel, data });
    };
    for (const { owner, ref } of collectProjectReferences(project, includeRuns)) {
      if (ref.kind === 'external') { external.push({ owner, path: ref.path }); continue; }
      const rel = safeRelative(ref.path);
      if (!rel) throw new Error(`Unsafe reference path: ${ref.path}`);
      try { await add(rel); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') missing.push(rel); else throw e; }
    }
    if (includeRuns) for (const study of project.studies) for (const run of study.runs) {
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(path.join(store.root, dir), { withFileTypes: true }).catch(() => [])) {
          const rel = `${dir}/${entry.name}`;
          if (entry.isDirectory()) await walk(rel); else if (entry.isFile() && files.length < 5000) await add(rel);
        }
      };
      await walk(run.directory);
    }
    const copy = packagedProject(project, includeRuns);
    files.push({ path: '.kkss/project.json', data: new TextEncoder().encode(JSON.stringify(copy, null, 2) + '\n') });
    await writeFileAtomic(out, buildArchive(project, files, external, includeRuns, new Date().toISOString()));
    return { archive: out, files: files.length, bytes: total, includesRuns: includeRuns, external, missing };
  }

  /** The one relink code path: `app__study_relink_source` and the archive-import prompt both call it. */
  async relinkSource(studyId: string, sourcePath: string): Promise<unknown> {
    const file = path.resolve(sourcePath), revision = await fileRevision(file);
    return this.change((project, current) => {
      const study = this.study(project, studyId);
      study.source = reference(current.root, file, revision);
      project.activeStudyId = study.id; delete project.activeRunId;
      return { studyId: study.id, source: study.source, readiness: undefined };
    });
  }

  /** Unpack into a new folder; damaged or missing members are listed, never silently skipped, and nothing existing is overwritten. */
  async projectUnpack(args: Record<string, unknown>): Promise<unknown> {
    const archive = path.resolve(text(args, 'archivePath')), dest = path.resolve(text(args, 'destination'));
    const exists = (rel: string) => { try { return !!fsSync.statSync(path.join(dest, rel)); } catch { return false; } };
    const zip = readZip(new Uint8Array(await fs.readFile(archive)));
    const plan = planUnpack(zip.members, exists);
    if (plan.conflicts.length) return { unpacked: false, reason: 'Destination already holds files from this archive; choose an empty folder.', conflicts: plan.conflicts.slice(0, 50), problems: plan.problems, unsafeMembers: zip.unsafeMembers };
    for (const f of plan.files) {
      const target = path.resolve(dest, f.path);
      if (!target.startsWith(dest + path.sep)) throw new Error(`Unsafe path: ${f.path}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await writeFileAtomic(target, f.data);
    }
    const unresolvedExternalRefs = unresolvedExternal(plan.manifest, p => fsSync.existsSync(p));
    const externalReferences = plan.manifest.external.map(e => ({ ...e, exists: fsSync.existsSync(e.path) }));
    return { unpacked: true, destination: dest, files: plan.files.length, problems: plan.problems, unsafeMembers: zip.unsafeMembers, externalReferences, unresolvedExternal: unresolvedExternalRefs };
  }

  /** Receipt, environment report and solver-log tails of the selected run, for the diagnostics bundle. Text only, capped. */
  async runDiagnostics(): Promise<{ name: string; text: string }[]> {
    const out: { name: string; text: string }[] = [];
    let store: ProjectStore;
    try { store = this.store(); } catch { return out; }
    const project = await store.read();
    const study = project?.studies.find(x => x.id === project.activeStudyId);
    const run = study?.runs.find(x => x.id === project?.activeRunId) ?? study?.runs[study.runs.length - 1];
    if (!project || !study || !run) return out;
    out.push({ name: 'run/receipt.json', text: JSON.stringify({ studyId: study.id, run: { id: run.id, state: run.state, settings: run.settings, resources: run.resources, outputFindings: run.outputFindings, receipt: run.receipt } }, null, 2) });
    try { out.push({ name: 'run/environment.json', text: JSON.stringify(await this.environment(false), null, 2) }); } catch { /* optional */ }
    const dir = path.join(store.root, run.directory);
    const walk = async (d: string, depth: number): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (e.isFile() && /\.(log|out|err)$/i.test(e.name) && out.length < 12) {
          const handle = await fs.open(full, 'r');
          try {
            const { size } = await handle.stat(), len = Math.min(size, 100_000), buf = Buffer.alloc(len);
            await handle.read(buf, 0, len, size - len);
            out.push({ name: `run/${path.relative(dir, full).split(path.sep).join('/')}`, text: buf.toString('utf8') });
          } finally { await handle.close(); }
        }
      }
    };
    await walk(dir, 0);
    return out;
  }

  tools(): AppTool[] {
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], invoke: AppTool['invoke']): AppTool => ({ name: `app__${name}`, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, invoke });
    const str = { type: 'string', minLength: 1 };
    return [
      tool('check_simulation_environment', 'Check manual and tool-server runtimes independently without installing software. Reports selected case requirements and available resources.', {}, [], () => this.environment(true)),
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
      tool('study_region_references', 'Read-only: list the SubModelPart regions a study\'s case settings reference (assignments, materials, collections) and whether the attached MDPA mesh still has each one. Matching is by name only; a suggested rename is a hint, not a fact.', { studyId: str }, ['studyId'], args => this.regionReferences(args)),
      tool('study_region_rename', 'Move case-setting references from one region path to another (children follow). Without apply=true this only previews. Applying needs expectedSettingsRevision from app__study_region_references and edits the study\'s recorded case settings only.', { studyId: str, renames: { type: 'array', items: { type: 'object', properties: { from: str, to: str }, required: ['from', 'to'] } }, apply: { type: 'boolean' }, expectedSettingsRevision: str }, ['studyId', 'renames'], args => this.renameRegions(args)),
      tool('study_relink_source', 'Explicitly relink a study to a geometry file after verifying it exists. Existing mesh and run artifacts are retained and become stale when their source revision differs.', { studyId: str, sourcePath: str }, ['studyId', 'sourcePath'], args => this.relinkSource(text(args, 'studyId'), text(args, 'sourcePath'))),
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
      tool('run_refinement_set', 'Save revision-bound mesh refinement metadata for a terminal run. Adaptive meshes require an explicit characteristic size and a justified sizing definition. Comparability and asymptotic range are user assumptions, not verified facts.', {
        studyId: str, runId: str, characteristicSize: { type: 'number', exclusiveMinimum: 0 }, domainMeasure: { type: 'number', exclusiveMinimum: 0 },
        lengthUnit: { enum: ['m', 'cm', 'mm'] }, dimension: { enum: [1, 2, 3] }, method: { enum: ['uniform', 'adaptive'] },
        sizingDefinition: str, justification: str, comparable: { type: 'boolean' }, asymptotic: { type: 'boolean' },
      }, ['studyId', 'runId', 'lengthUnit', 'dimension', 'method', 'sizingDefinition', 'justification', 'comparable', 'asymptotic'], async args => {
        const store = this.store();
        const project = await store.read(); if (!project) throw new Error('No project.');
        const run = this.study(project, text(args, 'studyId')).runs.find(r => r.id === text(args, 'runId'));
        if (!run || !['succeeded', 'failed', 'cancelled'].includes(run.state)) throw new Error('Select a terminal run.');
        const metadata: Refinement = { meshRevision: run.meshRevision, lengthUnit: args.lengthUnit as Refinement['lengthUnit'], dimension: args.dimension as Refinement['dimension'],
          method: args.method as Refinement['method'], sizingDefinition: text(args, 'sizingDefinition'), justification: text(args, 'justification'), comparable: args.comparable as boolean, asymptotic: args.asymptotic as boolean,
          ...(args.characteristicSize !== undefined ? { characteristicSize: args.characteristicSize as number } : {}), ...(args.domainMeasure !== undefined ? { domainMeasure: args.domainMeasure as number } : {}) };
        validateRefinement(metadata);
        const mesh = run.artifacts.find(a => a.role === 'mesh' && a.ownerId === run.id);
        if (!mesh || await fileRevision(resolveReference(store.root, mesh.reference)) !== run.meshRevision) throw new Error('The run mesh is missing or changed.');
        await store.update(p => { const current = this.study(p, run.studyId).runs.find(r => r.id === run.id); if (!current || current.meshRevision !== metadata.meshRevision) throw new Error('Run changed.'); current.refinement = metadata; });
        this.deps.changed(); return metadata;
      }),
      tool('run_review', 'Build a structured review for a terminal run with revision-checked generated inputs and mesh-quality diagnostics when the mesh runner is available. Preparation reports and their inputs are checked against owned revisions. Versioned structural, fluid, thermal, potential-flow and shallow-water monitors distinguish process completion, solver convergence, final-iteration residual norms and unavailable diagnostics. Saved scalar quantities are included only while their source result revision is current.', { studyId: str, runId: str }, ['studyId', 'runId'], async args => (await this.buildRunReview(text(args, 'studyId'), text(args, 'runId'))).review),
      tool('run_compare', 'Compare two runs of one study as a facts-only Markdown report — verdict, identity table (source mesh, problemtype, settings, CAD source), every differing setting, and changed, one-sided and unverified outputs with the list bound named when hit. Same compareRuns core as mesh case_compare (facts only, never a judgement; incomparable pairs render their problems). Runs without an isolated execution receipt compare as incomparable rather than guessed.', { studyId: str, leftRunId: str, rightRunId: str }, ['studyId', 'leftRunId', 'rightRunId'], args => this.compareStudyRuns(text(args, 'studyId'), text(args, 'leftRunId'), text(args, 'rightRunId'))),
      tool('run_quantity_evaluate', 'Evaluate one explicitly selected result field and save its definition, unit, value and exact source artifact revision into the owning run evidence.', {
        studyId: str, runId: str, resultPath: str,
        field: str, kind: { enum: ['Nodal', 'Elemental', 'Conditional'] },
        component: { enum: ['scalar', 'x', 'y', 'z', 'magnitude'] }, region: str,
        timeStep: { type: 'integer' }, time: { type: 'number' },
        reduction: { enum: ['min', 'max', 'minAbs', 'maxAbs', 'mean', 'std', 'median', 'sum', 'count', 'q1', 'q3', 'iqr'] }, unit: str,
      }, ['studyId', 'runId', 'field', 'kind', 'component', 'reduction', 'unit'], args => this.evaluateRunQuantity(args)),
      tool('run_quantity_reevaluate', 'Replay the saved quantity definitions of an earlier run (fromRunId, default: the study\'s previous run) on the target run\'s current attached result. Each definition is evaluated through the same revision-checked path as app__run_quantity_evaluate; one failure never stops the others and no value is copied or interpolated between runs.', { studyId: str, runId: str, fromRunId: str }, ['studyId', 'runId'], async args => {
        const store = this.store(), project = await store.read();
        if (!project) throw new Error('No project.');
        const study = this.study(project, text(args, 'studyId'));
        const target = study.runs.find(r => r.id === text(args, 'runId'));
        if (!target) throw new Error('Run does not belong to this study.');
        const index = study.runs.indexOf(target);
        const from = typeof args.fromRunId === 'string' && args.fromRunId ? study.runs.find(r => r.id === args.fromRunId) : study.runs[index - 1];
        if (!from) throw new Error('There is no earlier run to take quantity definitions from.');
        if (from.id === target.id) throw new Error('Choose a different source run.');
        const definitions = from.evidence?.quantities ?? [];
        if (!definitions.length) return { evaluated: 0, failed: 0, outcomes: [], note: 'The source run has no saved quantities.' };
        const outcomes: { field: string; region: string; time: number; ok: boolean; value?: number | null; reason?: string }[] = [];
        for (const q of definitions) {
          try {
            const result = await this.evaluateRunQuantity({ studyId: study.id, runId: target.id, field: q.field, kind: q.kind, component: q.component, region: q.region, reduction: q.reduction, unit: q.unit, time: q.time });
            outcomes.push({ field: q.field, region: q.region, time: q.time, ok: true, value: result.quantity.value });
          } catch (error) { outcomes.push({ field: q.field, region: q.region, time: q.time, ok: false, reason: error instanceof Error ? error.message : String(error) }); }
        }
        const failed = outcomes.filter(o => !o.ok).length;
        return { fromRunId: from.id, runId: target.id, evaluated: outcomes.length - failed, failed, outcomes };
      }),
      tool('run_review_export','Export a selected run review as JSON and self-contained offline HTML.', { studyId: str, runId: str }, ['studyId', 'runId'], async args => {
        const { store, run, review } = await this.buildRunReview(text(args, 'studyId'), text(args, 'runId'));
        const directory = path.join(store.root, '.kkss', 'reviews');
        const jsonFile = path.join(directory, `${run.id}.json`), htmlFile = path.join(directory, `${run.id}.html`);
        await writeFileAtomic(jsonFile, JSON.stringify(review, null, 2) + '\n');
        await writeFileAtomic(htmlFile, reviewHtml(review));
        return { jsonFile, htmlFile, findings: review.evidence.findings };
      }),
      tool('queue_plan_preview', 'Preview a concrete mesh → case-generation → solve plan with exact project-relative destinations. This does not persist tasks or launch work. With staleOnly=true reuseMesh is derived from the study\'s recorded revisions (a stale or missing geometry/mesh rebuilds the mesh; otherwise the mesh is reused) and a study that is already current returns nothingToDo.',
        { studyId: str, reuseMesh: { type: 'boolean' }, staleOnly: { type: 'boolean' } }, ['studyId'], async args => {
          if (args.staleOnly === true) {
            const store = this.store(), project = await store.read();
            if (!project) throw new Error('Create a study before planning a run.');
            const study = this.study(project, text(args, 'studyId'));
            const state = await readiness(store.root, study);
            const geometryOrMesh = [state.geometry, state.mesh].some(v => v !== 'ready');
            const latest = study.runs[study.runs.length - 1];
            const reevaluate = await staleQuantities(store.root, study);
            if (!geometryOrMesh && state.case === 'ready' && latest?.state === 'succeeded' && latest.sourceRevision === study.source.revision && latest.meshRevision === study.mesh?.revision && latest.settings && fingerprint(latest.settings) === fingerprint(study.caseSettings) && true) return reevaluate.length ? { nothingToRebuild: true, readiness: state, reevaluate, note: 'Results are current but these saved quantities were evaluated on a changed result; re-run app__run_quantity_evaluate for each.' } : { nothingToDo: true, readiness: state };
            const plan = await this.previewQueuePlan(study.id, !geometryOrMesh);
            return { ...plan, staleOnly: true, readiness: state, reevaluate, rebuilds: geometryOrMesh ? 'mesh export, case generation and solve' : 'case generation and solve' };
          }
          if (typeof args.reuseMesh !== 'boolean') throw new Error('Choose whether to reuse the study mesh.');
          return this.previewQueuePlan(text(args, 'studyId'), args.reuseMesh);
        }),
      tool('queue_variants_preview', 'Preview a capped 1–50 row simulation sweep. Creates fresh variant identities only when enqueued; this preview does not write studies or launch tasks.',
        { studyId: str, reuseMesh: { type: 'boolean' }, rows: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { name: str, settings: { type: 'object' } }, required: ['name', 'settings'], additionalProperties: false } } }, ['studyId', 'reuseMesh', 'rows'], args => {
          if (typeof args.reuseMesh !== 'boolean' || !Array.isArray(args.rows) || args.rows.some(row => !object(row) || typeof row.name !== 'string' || !object(row.settings))) throw new Error('Choose mesh reuse and provide explicit variant rows.');
          return this.previewVariantQueue(text(args, 'studyId'), args.reuseMesh, args.rows as { name: string; settings: Json }[]);
        }),
      tool('queue_parameter_sweep_preview', 'Expand case setting dotted paths and values into a concrete paused-queue plan of up to 50 rows. Give either parameterPath + values (one parameter), or parameters: [{path, values}] (up to 4) with mode "grid" (all combinations, the default) or "paired" (equal-length lists, row i takes value i of each). The expansion is shown here, before anything is persisted. This preview writes nothing and starts no runs.',
        { studyId: str, reuseMesh: { type: 'boolean' }, parameterPath: str, values: { type: 'array', minItems: 1, maxItems: 50, items: {} },
          parameters: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { path: str, values: { type: 'array', minItems: 1, maxItems: 50, items: {} } }, required: ['path', 'values'], additionalProperties: false } },
          mode: { enum: ['grid', 'paired'] } }, ['studyId', 'reuseMesh'], args => {
          if (typeof args.reuseMesh !== 'boolean') throw new Error('Choose mesh reuse and provide parameter values.');
          if (args.parameters !== undefined && (args.parameterPath !== undefined || args.values !== undefined)) throw new Error('Give either parameters or parameterPath + values, not both.');
          const parameters = args.parameters !== undefined
            ? (Array.isArray(args.parameters) ? args.parameters.map(entry => {
                if (!object(entry) || typeof entry.path !== 'string' || !Array.isArray(entry.values)) throw new Error('Each parameter needs a path and a values array.');
                return { name: entry.path, values: entry.values as Json[] };
              }) : (() => { throw new Error('parameters must be a list.'); })())
            : (typeof args.parameterPath === 'string' && Array.isArray(args.values) ? [{ name: args.parameterPath, values: args.values as Json[] }] : (() => { throw new Error('Provide parameters, or parameterPath and values.'); })());
          return this.previewParameterQueue(text(args, 'studyId'), args.reuseMesh, parameters, parseSweepMode(args.mode));
        }),
      tool('queue_geometry_sweep_preview', 'Preview a 1–50 row geometry sweep over CAD document variables the model already defines. Give either variable + values (one variable), or variables: [{name, values}] (up to 4) with mode "grid" (all combinations, the default) or "paired" (equal-length lists). Each row copies the model into its own run directory, sets the variables on the copy, then meshes, generates and solves. Writes nothing and starts nothing; your own files are never edited. A row that loses a region the case references is stopped before its solve (matched by name only).',
        { studyId: str, variable: str, values: { type: 'array', minItems: 1, maxItems: GEOMETRY_ROW_CAP, items: {} },
          variables: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { name: str, values: { type: 'array', minItems: 1, maxItems: GEOMETRY_ROW_CAP, items: {} } }, required: ['name', 'values'], additionalProperties: false } },
          mode: { enum: ['grid', 'paired'] } }, ['studyId'], args => {
          if (args.variables !== undefined && (args.variable !== undefined || args.values !== undefined)) throw new Error('Give either variables or variable + values, not both.');
          const variables = args.variables !== undefined
            ? (Array.isArray(args.variables) ? args.variables.map(entry => { if (!object(entry)) throw new Error('Each variable needs a name and values.'); return { name: entry.name, values: entry.values }; }) : (() => { throw new Error('variables must be a list.'); })())
            : [{ name: args.variable, values: args.values }];
          return this.previewGeometrySweep(text(args, 'studyId'), variables, parseSweepMode(args.mode));
        }),
      tool('queue_retry_variant_preview', 'Preview one fresh retry row for a failed or cancelled variant. Keeps it in the same comparison group and never overwrites the previous run.',
        { studyId: str, reuseMesh: { type: 'boolean' } }, ['studyId', 'reuseMesh'], async args => {
          if (typeof args.reuseMesh !== 'boolean') throw new Error('Choose whether to reuse the variant mesh.');
          const project = await this.store().read(); if (!project) throw new Error('No project.');
          const source = this.study(project, text(args, 'studyId'));
          if (project.queue.tasks.some(task => task.studyId === source.id && ['waiting', 'held', 'dispatching', 'running', 'uncertain'].includes(task.state))) throw new Error('This variant has queued work. Resume or reconcile it before creating a retry.');
          const latest = source.runs[source.runs.length - 1];
          const latestSolve = [...project.queue.tasks].reverse().find(task => task.studyId === source.id && task.kind === 'solve');
          const retryable = latest?.state === 'failed' || latest?.state === 'cancelled' || latest?.state === 'blocked' || ['failed', 'cancelled', 'blocked'].includes(latestSolve?.state ?? '');
          if (!retryable) throw new Error('Only failed, cancelled or blocked variant rows can be retried.');
          const parentId = source.parentId ?? source.id;
          const retryNumber = project.studies.filter(study => study.parentId === parentId && study.name.startsWith(`${source.name} retry`)).length + 1;
          return this.previewVariantQueue(source.id, args.reuseMesh, [{ name: `${source.name} retry ${retryNumber}`, settings: source.caseSettings }], parentId);
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
      tool('queue_resume_row', 'Resume one waiting run row from the exact approved queue revision; other waiting rows stay held. Failed rows need a fresh retry plan.',
        { taskId: str, planRevision: str }, ['taskId', 'planRevision'], async args => {
          await this.deps.prepareQueue?.();
          const store = this.store(), project = await store.read();
          const selectedTask = project?.queue.tasks.find(task => task.id === text(args, 'taskId'));
          if (!project || !selectedTask) throw new Error('The selected queue task no longer exists.');
          const rowTasks = project.queue.tasks.filter(task => task.studyId === selectedTask.studyId && task.runId === selectedTask.runId);
          if (rowTasks.some(task => ['dispatching', 'running', 'uncertain', 'failed', 'cancelled', 'blocked'].includes(task.state))) throw new Error('This row is active or has a failed task; let it reconcile or create a fresh retry plan.');
          const waitingIds = rowTasks.filter(task => ['waiting', 'held'].includes(task.state)).map(task => task.id);
          if (!waitingIds.length) throw new Error('This run row has no waiting tasks to resume.');
          await this.queue.resume(store, text(args, 'planRevision'), waitingIds);
          await this.persistTerminalQueueRuns(store); await this.snapshot(); return (await store.read())?.queue;
        }),
      tool('queue_cancel', 'Cancel a waiting task or request owner-scoped cancellation for a running CAD mesh export or solver task.', { taskId: str }, ['taskId'], async args => {
        const store = this.store(); await this.queue.cancel(store, text(args, 'taskId')); await this.snapshot(); return (await store.read())?.queue;
      }),
      tool('variants_preview', 'Preview 1–50 explicit case-setting variants without writing or launching anything.', { studyId: str, rows: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { name: str, settings: { type: 'object' } }, required: ['name', 'settings'], additionalProperties: false } } }, ['studyId', 'rows'], async args => {
        const p = await this.store().read(); if (!p) throw new Error('No project.');
        if (!Array.isArray(args.rows) || args.rows.some(r => !object(r) || typeof r.name !== 'string' || !object(r.settings))) throw new Error('Invalid variant rows.');
        return previewVariants(this.study(p, text(args, 'studyId')), args.rows as {name: string; settings: Json}[]);
      }),
      tool('variants_compare', 'Compare the parent study and its variants, retaining failed/unconverged/missing rows and comparing only saved scalar definitions with compatible units. Mesh-sensitivity estimates require revision-bound refinement metadata; assumptions and unavailable reasons accompany every result.', { studyId: str }, ['studyId'], async args => (await this.buildVariantComparison(text(args, 'studyId'))).comparison),
      tool('variants_compare_export', 'Write the current variant comparison as portable JSON and self-contained offline HTML.', { studyId: str }, ['studyId'], async args => {
        const { store, comparison } = await this.buildVariantComparison(text(args, 'studyId'));
        const directory = path.join(store.root, '.kkss', 'reviews');
        const jsonFile = path.join(directory, `variants-${comparison.parentStudyId}.json`), htmlFile = path.join(directory, `variants-${comparison.parentStudyId}.html`);
        await writeFileAtomic(jsonFile, JSON.stringify(comparison, null, 2) + '\n');
        await writeFileAtomic(htmlFile, comparisonHtml(comparison));
        return { jsonFile, htmlFile, findings: comparison.findings };
      }),
      tool('project_pack', 'Pack the project (.kkss/project.json plus every project-contained source, mesh, case input and, with includeRuns, run files) into one archive with SHA-256 hashes. External references are listed, never packed.', { outputPath: str, includeRuns: { type: 'boolean' } }, ['outputPath'], args => this.projectPack(args)),
      tool('project_unpack', 'Unpack a project archive into an empty destination folder after verifying every hash. Damaged or missing members are reported; nothing existing is overwritten and external references missing on this machine are returned as unresolvedExternal (studyId, role, path); a missing study source is repointed with app__study_relink_source once the unpacked folder is the selected project.', { archivePath: str, destination: str }, ['archivePath', 'destination'], args => this.projectUnpack(args)),
      tool('goal_seek_next', 'Read-only, stateless goal-seek step. Give the target, relTolerance, lower/upper bounds, maxStep, initialStep, maxSolves and the iterates solved so far ({x, y, state}; take y from app__variants_compare parameterTables, null if missing). Returns reached, next (the value to run next as a one-value app__queue_parameter_sweep_preview), stopped (an iterate failed, was uncertain or had no value) or notReached. It never solves anything and never interpolates an answer.',
        { target: { type: 'number' }, relTolerance: { type: 'number' }, lower: { type: 'number' }, upper: { type: 'number' }, maxStep: { type: 'number' }, initialStep: { type: 'number' }, maxSolves: { type: 'integer' }, start: { type: 'number' },
          iterates: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: ['number', 'null'] }, state: { enum: ['succeeded', 'failed', 'uncertain', 'cancelled'] } }, required: ['x', 'y', 'state'], additionalProperties: false } } },
        ['target', 'relTolerance', 'lower', 'upper', 'maxStep', 'initialStep', 'maxSolves', 'iterates'], async args => {
          const { iterates, ...spec } = args as unknown as SeekSpec & { iterates: Iterate[] };
          if (!Array.isArray(iterates)) throw new Error('iterates must be an array.');
          return nextIterate(iterates, spec);
        }),
      tool('goal_seek_iterates', 'Read-only: the goal-seek iterates already solved in a study\'s variant group (parent plus children), in creation order. For each study: x is the number at the dotted parameterPath of its caseSettings, y the value of the saved quantity matching the exact definition (field, kind, component, region, reduction, unit and, when given, time) on its latest run, only while that quantity\'s result revision is current; y is null when absent, never 0 or inferred. start is the selected study\'s current parameter value or null. Feed iterates and start to app__goal_seek_next. Writes nothing.',
        { studyId: str, parameterPath: str, field: str, kind: { enum: ['Nodal', 'Elemental', 'Conditional'] }, component: str, region: str, reduction: str, unit: str, time: { type: 'number' } },
        ['studyId', 'parameterPath', 'field', 'kind', 'component', 'region', 'reduction', 'unit'], async args => {
          const store = this.store(), project = await store.read(); if (!project) throw new Error('No project.');
          const selected = this.study(project, text(args, 'studyId')), parent = selected.parentId ? project.studies.find(s => s.id === selected.parentId) : selected;
          if (!parent) throw new Error('The parent study is missing; relink the variant group first.');
          const dotted = text(args, 'parameterPath');
          const numberAt = (study: Study): number | null => {
            let current: unknown = study.caseSettings;
            for (const part of dotted.split('.')) {
              if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return null;
              current = (current as Record<string, unknown>)[part];
            }
            return typeof current === 'number' && Number.isFinite(current) ? current : null;
          };
          const wantTime = typeof args.time === 'number' ? args.time : undefined;
          const iterates: { x: number; y: number | null; state: Iterate['state'] }[] = [];
          const skipped: string[] = [];
          for (const study of [parent, ...project.studies.filter(s => s.parentId === parent.id)]) {
            const x = numberAt(study), run = study.runs[study.runs.length - 1];
            if (x === null || !run) { skipped.push(study.name); continue; }
            let y: number | null = null;
            try {
              const quantities = (await this.buildRunReview(study.id, run.id)).review.evidence.quantities ?? [];
              const match = quantities.find(q => q.field === args.field && q.kind === args.kind && q.component === args.component && q.region === args.region
                && q.reduction === args.reduction && q.unit === args.unit && (wantTime === undefined || q.time === wantTime));
              y = match && match.value !== null && Number.isFinite(match.value) ? match.value : null;
            } catch { y = null; }
            const state: Iterate['state'] = run.state === 'succeeded' ? 'succeeded' : run.state === 'failed' ? 'failed' : run.state === 'cancelled' ? 'cancelled' : 'uncertain';
            iterates.push({ x, y, state });
          }
          return { start: numberAt(selected), iterates, ...(skipped.length ? { skipped } : {}) };
        }),
      tool('study_next_step', 'Read-only: the geometry → mesh → case → run → review checklist of a study with each step done / todo / redo / blocked and the single next action (with the tool that performs it, where one exists). Derived from the recorded revisions; it computes and runs nothing.', { studyId: str }, ['studyId'], async args => {
        const store = this.store(), project = await store.read();
        if (!project) throw new Error('No project studies.');
        const study = this.study(project, text(args, 'studyId'));
        return { studyId: study.id, name: study.name, readiness: await readiness(store.root, study), ...buildChecklist(await readiness(store.root, study)) };
      }),
    ];
  }
}
