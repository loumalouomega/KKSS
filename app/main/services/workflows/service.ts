import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../atomicWrite';
import type { AppTool } from '../chat/appTools';
import { checkEnvironment, type EnvironmentReport } from './environment';
import { ProjectStore, fileRevision, fingerprint, readiness, reference, resolveReference, duplicateStudy, previewVariants } from './project';
import type { Json, Project, Study } from './contracts';
import type { Run } from './contracts';
import type { KratosRuntime } from '../chat/kratosRuntime';
import { BUILTIN_PROBLEMTYPES } from '../../../../mesh/src/problemtype/builtins';
import { parseCaseJson, caseFilePath, runFilePath } from '../../../../mesh/src/problemtype/caseFile';
import { parseRunJson, reconcileStatus } from '../../../../mesh/src/problemtype/runFile';
import { isPidAlive } from '../../../../mesh/src/problemtype/runProcess';
import { latestResultFile } from '../../../../mesh/src/problemtype/runCore';
import { meshStem } from '../../../../mesh/src/parser/meshFormats';
import { makeReview, reviewHtml } from './review';
export interface WorkflowDeps {
  root(): string | undefined;
  activeMesh(): string | undefined;
  runtime: Pick<KratosRuntime, 'discover'>;
  environment(): { python: string; env: NodeJS.ProcessEnv; bundledPython?: string };
  open(file: string): Promise<void>;
  changed(): void;
}
const text = (args: Record<string, unknown>, key: string): string => {
  if (typeof args[key] !== 'string' || !args[key].trim()) throw new Error(`${key} is required.`);
  return args[key];
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export class WorkflowService {
  private stores = new Map<string, ProjectStore>();
  private report?: { key: string; value: EnvironmentReport };
  private selected?: { projectId: string; studyId?: string; runId?: string };
  constructor(private readonly deps: WorkflowDeps) {}
  store(): ProjectStore {
    const root = this.deps.root();
    if (!root) throw new Error('Choose a project folder on Home first.');
    let store = this.stores.get(root);
    if (!store) { store = new ProjectStore(root); this.stores.set(root, store); }
    return store;
  }
  context(): string {
    const configKey = fingerprint({ ...this.deps.environment(), root: this.deps.root(), mesh: this.deps.activeMesh() });
    const report = this.report?.key === configKey ? this.report.value : undefined;
    return JSON.stringify({ ...this.selected, runtime: report ? { manual: report.manual.available, tools: report.tools.available, checkedAt: report.checkedAt } : 'not checked or settings changed' });
  }
  async environment(): Promise<EnvironmentReport> {
    const config = this.deps.environment();
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
    const stage = BUILTIN_PROBLEMTYPES.find(pt => pt.decl.id === problemtype)?.decl.analysisStage;
    const application = stage?.match(/^(KratosMultiphysics\.[A-Za-z_][A-Za-z0-9_]*Application)\./)?.[1];
    const value = await checkEnvironment({ ...config, directory: this.deps.root() ?? (mesh ? path.dirname(mesh) : process.cwd()), applications: application ? [application] : [], requirementsComplete: !!application, runtime: this.deps.runtime });
    this.report = { key: fingerprint({ ...config, root: this.deps.root(), mesh }), value };
    this.deps.changed();
    return value;
  }
  async snapshot(): Promise<unknown> {
    if (!this.deps.root()) { this.selected = undefined; return { project: null }; }
    const store = this.store();
    const project = await store.read();
    this.selected = project && { projectId: project.id, studyId: project.activeStudyId, runId: project.activeRunId };
    return { project: project ?? null, readiness: Object.fromEntries(await Promise.all((project?.studies ?? []).map(async s => [s.id, await readiness(store.root, s)]))), environment: this.report?.value };
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
    const names = new Set([path.basename(caseFilePath(meshPath)), 'ProjectParameters.json', 'MainKratos.py', `${stem}_case.mdpa`]);
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
    const artifacts = await Promise.all(copied.map(async file => ({ role: path.resolve(file) === path.resolve(savedMesh) ? 'mesh' : 'input', ownerId: id, reference: reference(store.root, file, await fileRevision(file)) })));
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
    let meshText: string | undefined;
    if (mesh) {
      const file = resolveReference(store.root, mesh.reference);
      if (await fileRevision(file) === mesh.reference.revision && path.extname(file).toLowerCase() === '.mdpa') meshText = await fs.readFile(file, 'utf8');
    }
    return { store, run, review: makeReview(project.revision, study, run, meshText) };
  }
  tools(): AppTool[] {
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], invoke: AppTool['invoke']): AppTool => ({ name: `app__${name}`, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, invoke });
    const str = { type: 'string', minLength: 1 };
    return [
      tool('check_simulation_environment', 'Check manual and tool-server runtimes independently without installing software. Reports selected case requirements and available resources.', {}, [], () => this.environment()),
      tool('study_list', 'List the current project studies and geometry-to-results readiness.', {}, [], () => this.snapshot()),
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
      tool('study_open', 'Open a study geometry, mesh, or owned result in the existing viewer.', { studyId: str, stage: { enum: ['geometry', 'mesh', 'results'] }, runId: str }, ['studyId', 'stage'], async args => {
        const store = this.store(), project = await store.read();
        if (!project) throw new Error('No project studies.');
        const study = this.study(project, text(args, 'studyId'));
        const run = study.runs.find(r => r.id === args.runId);
        const ref = args.stage === 'geometry' ? study.source : args.stage === 'mesh' ? study.mesh : args.stage === 'results' ? run?.artifacts.find(a => a.role === 'result' && a.ownerId === run.id)?.reference : undefined;
        if (!ref) throw new Error('No artifact at this step. Select an owned run for results.');
        const file = resolveReference(store.root, ref); await fs.access(file); await this.deps.open(file); return { opened: file };
      }),
      tool('study_duplicate', 'Duplicate settings and source references with fresh identity, without copying process or result ownership. Choose whether to reuse the mesh.', { studyId: str, name: str, reuseMesh: { type: 'boolean' } }, ['studyId', 'name', 'reuseMesh'], args => this.change(p => {
        if (typeof args.reuseMesh !== 'boolean') throw new Error('Choose whether to reuse the mesh.');
        const study = duplicateStudy(this.study(p, text(args, 'studyId')), text(args, 'name'), args.reuseMesh);
        p.studies.push(study); p.activeStudyId = study.id; delete p.activeRunId; return study;
      })),
      tool('study_attach_mesh', 'Attach an existing exported mesh to a study and record its content revision. Imports a neighboring case setup when present.', { studyId: str, meshPath: str }, ['studyId', 'meshPath'], args => this.attachMesh(args)),
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
      tool('run_review', 'Build a structured review for an imported terminal run. Unsupported convergence and scalar checks remain explicitly unavailable.', { studyId: str, runId: str }, ['studyId', 'runId'], async args => (await this.buildRunReview(text(args, 'studyId'), text(args, 'runId'))).review),
      tool('run_review_export', 'Export a selected run review as JSON and self-contained offline HTML.', { studyId: str, runId: str }, ['studyId', 'runId'], async args => {
        const { store, run, review } = await this.buildRunReview(text(args, 'studyId'), text(args, 'runId'));
        const directory = path.join(store.root, '.kkss', 'reviews');
        const jsonFile = path.join(directory, `${run.id}.json`), htmlFile = path.join(directory, `${run.id}.html`);
        await writeFileAtomic(jsonFile, JSON.stringify(review, null, 2) + '\n');
        await writeFileAtomic(htmlFile, reviewHtml(review));
        return { jsonFile, htmlFile, findings: review.evidence.findings };
      }),
      tool('variants_preview', 'Preview 1–50 explicit case-setting variants without writing or launching anything.', { studyId: str, rows: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { name: str, settings: { type: 'object' } }, required: ['name', 'settings'], additionalProperties: false } } }, ['studyId', 'rows'], async args => {
        const p = await this.store().read(); if (!p) throw new Error('No project.');
        if (!Array.isArray(args.rows) || args.rows.some(r => !object(r) || typeof r.name !== 'string' || !object(r.settings))) throw new Error('Invalid variant rows.');
        return previewVariants(this.study(p, text(args, 'studyId')), args.rows as {name: string; settings: Json}[]);
      }),
    ];
  }
}
