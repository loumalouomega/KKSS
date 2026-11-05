import { KRATOS_MCP_VERSION } from '../app/main/services/chat/kratosMcpVersion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Evidence, Json, Receipt, Run, Study, Task } from '../app/main/services/workflows/contracts';
import { checkEnvironment, manualLaunchAvailability, PROBE_SCRIPT, type Probe } from '../app/main/services/workflows/environment';
import { duplicateStudy, fileRevision, fingerprint, previewVariants, ProjectStore, readiness, reference, resolveReference } from '../app/main/services/workflows/project';
import { ExecutionQueue, planRevision } from '../app/main/services/workflows/queue';
import { compareVariants, comparisonHtml } from '../app/main/services/workflows/comparison';
import { buildEvidence, escapeHtml, mdpaCounts, parseStructuralConvergence, reviewHtml } from '../app/main/services/workflows/review';
import { WorkflowService } from '../app/main/services/workflows/service';
import { appTools, callAppTool, registerAppTools } from '../app/main/services/chat/appTools';
import { caseFilePath, runFilePath } from '../mesh/src/problemtype/caseFile';

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kkss-workflows-'));
  roots.push(root); return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
function makeStudy(id = 'study-1'): Study {
  return { id, name: 'Cantilever', source: { kind: 'project', path: 'beam.step', revision: 'geometry-rev' },
    meshing: { size: 2 }, caseSettings: { problemtypeId: 'structural' }, runs: [] };
}

describe('simulation environment probes', () => {
  it('checks manual and uv tool runtimes independently without installation', async () => {
    const root = await temp();
    const calls: string[][] = [];
    const probe: Probe = async (_command, args) => {
      calls.push(args);
      return `KKSS_PROBE:${JSON.stringify({ executable: '/python', version: '3.12.1', kratosVersion: '9', applications: [
        { name: 'KratosMultiphysics', available: true }, { name: 'KratosMultiphysics.StructuralMechanicsApplication', available: true },
      ], threadControl: true })}`;
    };
    const report = await checkEnvironment({ python: '/manual/python', env: {}, directory: root,
      applications: ['KratosMultiphysics.StructuralMechanicsApplication'], requirementsComplete: true,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, run: probe });
    expect(report.manual.available).toBe(true);
    expect(report.tools.available).toBe(true);
    expect(report.manual.executable).toBe('/python');
    expect(report.manual.capabilities.threads).toBe(true);
    expect(report.manual.capabilities.mpi).toBe(false);
    expect(report.tools.capabilities.threads).toBe(false);
    expect(report.tools.capabilities.mpi).toBe(false);
    expect(report.suggestedThreads).toBeGreaterThan(0);
    expect(report.writable).toBe(true);
    expect(report.cpuCount).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('-c');
    expect(calls[1]).toContain('--offline');
    expect(calls[1]).toContain('--no-sync');
    expect(calls[1]).toContain(`kratos-mcp-server==${KRATOS_MCP_VERSION}`);
    expect(PROBE_SCRIPT).toContain('importlib.import_module');
  });

  it('reports missing application imports and missing run directories without blocking geometry', async () => {
    const root = await temp();
    const report = await checkEnvironment({ python: '/bad/python', env: {}, directory: path.join(root, 'absent'),
      applications: ['KratosMultiphysics.StructuralMechanicsApplication'], requirementsComplete: true,
      runtime: { discover: async () => { throw new Error('uv unavailable'); } },
      run: async () => `KKSS_PROBE:${JSON.stringify({ executable: '/bad/python', version: '3.11', applications: [
        { name: 'KratosMultiphysics', available: true }, { name: 'KratosMultiphysics.StructuralMechanicsApplication', available: false, reason: 'module missing' },
      ]})}` });
    expect(report.manual.available).toBe(false);
    expect(report.manual.reason).toMatch(/missing applications/);
    expect(report.tools.available).toBe(false);
    expect(report.manual.capabilities.threads).toBe(false);
    expect(report.suggestedThreads).toBeUndefined();
    expect(report.writable).toBe(false);
    expect(report.directoryReason).toMatch(/writable run directory/);
  });

  it('recommends threads only when the manual runner exposes thread control', async () => {
    const root = await temp();
    const report = await checkEnvironment({ python: '/python', env: {}, directory: root, applications: [], requirementsComplete: true,
      runtime: { discover: async () => { throw new Error('tool runtime unavailable'); } },
      run: async () => `KKSS_PROBE:${JSON.stringify({ executable: '/python', version: '3.12', applications: [{ name: 'KratosMultiphysics', available: true }] })}` });
    expect(report.manual.available).toBe(true);
    expect(report.manual.capabilities.threads).toBe(false);
    expect(report.manual.capabilities.threadReason).toMatch(/API is unavailable/);
    expect(report.suggestedThreads).toBeUndefined();
    expect(report.manual.capabilities.mpi).toBe(false);
  });

  it('rejects malformed output and bounds probe execution', async () => {
    const bad = await import('../app/main/services/workflows/environment').then(m => m.probePython);
    await expect(bad('/python', [], [], {}, async () => 'not a report')).resolves.toMatchObject({ available: false });
  });

  it('gates manual launches on manual capability while preserving independent tool availability', async () => {
    const root = await temp();
    const report = await checkEnvironment({ python: '/python', env: {}, directory: root, applications: [], requirementsComplete: true,
      runtime: { discover: async () => { throw new Error('tool runtime unavailable'); } },
      run: async () => `KKSS_PROBE:${JSON.stringify({ executable: '/python', version: '3.12', applications: [{ name: 'KratosMultiphysics', available: true }] })}` });
    expect(report.tools.available).toBe(false);
    expect(manualLaunchAvailability(report)).toEqual({ allowed: true, reason: undefined });
    expect(manualLaunchAvailability({ ...report, requirementsComplete: false }).allowed).toBe(false);
    expect(manualLaunchAvailability({ ...report, manual: { ...report.manual, available: false, reason: 'Missing structural app.' } })).toMatchObject({ allowed: false, reason: /Missing structural app/ });
    expect(manualLaunchAvailability({ ...report, writable: false, directoryReason: 'Read only.' })).toMatchObject({ allowed: false, reason: /Read only/ });
  });
});

describe('portable project metadata', () => {
  it('serializes updates, rejects unknown versions, and resolves moved project paths', async () => {
    const parent = await temp();
    const first = path.join(parent, 'project-a'), moved = path.join(parent, 'project-moved');
    await fs.mkdir(first); await fs.writeFile(path.join(first, 'beam.step'), 'beam');
    const store = new ProjectStore(first);
    const sourceRevision = await fileRevision(path.join(first, 'beam.step'));
    await Promise.all([store.update(p => { p.studies.push({ ...makeStudy(), source: { kind: 'project', path: 'beam.step', revision: sourceRevision } }); }), store.update(p => { p.activeStudyId = 'study-1'; })]);
    expect((await store.read())?.revision).toBe(2);
    expect(await readiness(first, (await store.read())!.studies[0])).toMatchObject({ geometry: 'ready', mesh: 'missing' });
    await fs.rename(first, moved);
    expect(resolveReference(moved, (await new ProjectStore(moved).read())!.studies[0].source)).toBe(path.join(moved, 'beam.step'));
    await fs.writeFile(path.join(moved, '.kkss', 'project.json'), JSON.stringify({ version: 99 }));
    await expect(new ProjectStore(moved).update(() => undefined)).rejects.toThrow(/Unsupported project schema/);
    expect(JSON.parse(await fs.readFile(path.join(moved, '.kkss', 'project.json'), 'utf8')).version).toBe(99);
  });

  it('keeps external references explicit and detects content and option revisions', async () => {
    const root = await temp(), outside = path.join(await temp(), 'beam.step');
    await fs.writeFile(outside, 'v1');
    const ref = reference(root, outside, await fileRevision(outside));
    expect(ref.kind).toBe('external');
    expect(resolveReference(root, ref)).toBe(outside);
    const original = makeStudy();
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    const duplicate = duplicateStudy(original, 'copy', false, { parameter: 2 });
    expect(duplicate.runs).toEqual([]);
    expect(duplicate.mesh).toBeUndefined();
    expect(duplicate.source).toEqual(original.source);
    expect(previewVariants(original, [{ name: 'fine', settings: { parameter: 2 } }])).toMatchObject([{ changed: true }]);
    const solvedAndRunning: Study = { ...original, mesh: { kind: 'project', path: 'beam.mdpa', revision: 'mesh-rev' },
      runs: [
        { id: 'solved', studyId: original.id, sourceRevision: 'source', meshRevision: 'mesh-rev', settings: {}, directory: '.kkss/runs/solved', state: 'succeeded', artifacts: [] },
        { id: 'running', studyId: original.id, sourceRevision: 'source', meshRevision: 'mesh-rev', settings: {}, directory: '.kkss/runs/running', state: 'running', artifacts: [],
          receipt: { version: 1, requestId: 'request-live', ownerId: original.id, jobId: 'job-live', state: 'running', artifacts: [] } },
      ],
      handoff: { version: 1, exportId: 'export-1', source: original.source, replayRevision: 'replay', units: { length: 'm', scale: 1 }, options: null, engine: 'gmsh', engineVersion: '4.13.1', engineVersionSource: 'test', artifacts: [], groups: [], boundaryCoverage: { state: 'unavailable', reason: 'not sampled' }, findings: [] } };
    const reused = duplicateStudy(solvedAndRunning, 'reuse solved mesh', true);
    expect(reused.runs).toEqual([]);
    expect(reused.mesh).toEqual(solvedAndRunning.mesh);
    expect(reused.handoff).toEqual(solvedAndRunning.handoff);
    expect(JSON.stringify(reused)).not.toContain('job-live');
    const tooMany = Array.from({ length: 51 }, (_, i) => ({ name: String(i), settings: {} }));
    expect(() => previewVariants(original, tooMany)).toThrow(/1–50/);
  });

  it('rejects traversal and invalid run ownership', async () => {
    expect(() => resolveReference('/project', { kind: 'project', path: '../outside', revision: 'x' })).toThrow();
    const store = new ProjectStore(await temp());
    await expect(store.update(p => {
      p.studies.push({ ...makeStudy(), runs: [{ id: 'r1', studyId: 'someone-else', sourceRevision: 'x', meshRevision: 'y', settings: null, directory: '.kkss/runs/r1', state: 'waiting', artifacts: [] }] });
    })).rejects.toThrow(/ownership/);
  });
});

describe('dependency-aware queue recovery', () => {
  async function queueProject(root: string, tasks: Task[]): Promise<ProjectStore> {
    const store = new ProjectStore(root);
    await store.update(p => {
      p.studies.push(makeStudy()); p.activeStudyId = 'study-1'; p.queue.tasks = tasks;
    });
    return store;
  }
  function task(id: string, dependencies: string[] = [], kind: Task['kind'] = 'solve'): Task {
    return { id, studyId: 'study-1', runId: `run-${id}`, kind, dependencies, args: {}, inputRevision: 'rev', requiredArtifacts: [], state: 'waiting' };
  }
  const receipt = (t: Task, state: Receipt['state']): Receipt => ({ version: 1, requestId: t.id, ownerId: t.studyId, state, artifacts: [] });

  it('holds invalid work, continues unrelated work, and rejects a dependency-breaking reorder', async () => {
    const store = await queueProject(await temp(), [task('bad'), task('mesh', [], 'mesh'), task('solve', ['mesh'])]);
    let dispatched: string | undefined;
    const queue = new ExecutionQueue({ validate: async t => t.id === 'bad' ? ['case incomplete'] : [],
      dispatch: async t => { dispatched = t.id; return receipt(t, 'running'); }, lookup: async () => undefined,
      cancel: async t => receipt(t, 'cancelled') });
    const preview = planRevision((await store.read())!.queue.tasks);
    await expect(queue.reorder(store, ['bad', 'solve', 'mesh'])).rejects.toThrow(/dependency/);
    await queue.resume(store, preview);
    expect(dispatched).toBe('mesh');
    expect((await store.read())!.queue.tasks.map(t => [t.id, t.state])).toEqual([['bad', 'held'], ['mesh', 'running'], ['solve', 'waiting']]);
  });

  it('does not repeat an ambiguous dispatch after restart', async () => {
    const first = task('dispatching'); first.state = 'dispatching'; first.receipt = receipt(first, 'dispatching');
    const store = await queueProject(await temp(), [first]);
    let launches = 0;
    const queue = new ExecutionQueue({ validate: async () => [], dispatch: async t => { launches++; return receipt(t, 'running'); },
      lookup: async () => undefined, cancel: async t => receipt(t, 'cancelled') });
    await queue.register(store);
    await queue.tick();
    expect(launches).toBe(0);
    expect((await store.read())!.queue.tasks[0].state).toBe('uncertain');
    expect((await store.read())!.queue.paused).toBe(true);
  });

  it('does not resubmit a dispatch whose acknowledgement was lost', async () => {
    const store = await queueProject(await temp(), [task('ack-lost', [], 'mesh')]);
    let externalStarts = 0, resumedLaunches = 0;
    const first = new ExecutionQueue({ validate: async () => [], dispatch: async () => {
      externalStarts++; throw new Error('runner accepted work but the acknowledgement was lost');
    }, lookup: async t => receipt(t, 'uncertain'), cancel: async t => receipt(t, 'cancelled') });
    await first.resume(store, planRevision((await store.read())!.queue.tasks));
    expect(externalStarts).toBe(1);
    expect((await store.read())!.queue.tasks[0].state).toBe('uncertain');

    const restarted = new ExecutionQueue({ validate: async () => [], dispatch: async t => {
      resumedLaunches++; return receipt(t, 'succeeded');
    }, lookup: async t => receipt(t, 'uncertain'), cancel: async t => receipt(t, 'cancelled') });
    await restarted.register(store);
    await restarted.tick();
    expect(resumedLaunches).toBe(0);
    expect((await store.read())!.queue.tasks[0].state).toBe('uncertain');
    expect((await store.read())!.queue.paused).toBe(true);
  });

  it('reconciles a solve that was active at restart before dispatching any waiting work', async () => {
    const root = await temp(), active = task('solve-active'), waiting = task('mesh-waiting', [], 'mesh');
    active.state = 'running'; active.receipt = receipt(active, 'running');
    const original = await queueProject(root, [active, waiting]);
    const beforeRestart = new ExecutionQueue({ validate: async () => [], dispatch: async () => { throw new Error('must not dispatch'); },
      lookup: async t => receipt(t, 'running'), cancel: async t => receipt(t, 'cancelled') });
    await beforeRestart.register(original);
    await beforeRestart.tick();
    expect((await original.read())!.queue.tasks.map(t => t.state)).toEqual(['running', 'waiting']);

    const afterRestart = new ProjectStore(root), dispatched: string[] = [];
    const recovered = new ExecutionQueue({ validate: async () => [], dispatch: async t => { dispatched.push(t.id); return receipt(t, 'succeeded'); },
      lookup: async t => receipt(t, t.id === 'solve-active' ? 'succeeded' : 'uncertain'), cancel: async t => receipt(t, 'cancelled') });
    await recovered.register(afterRestart);
    expect((await afterRestart.read())!.queue.tasks.map(t => t.state)).toEqual(['succeeded', 'waiting']);
    const revision = planRevision((await afterRestart.read())!.queue.tasks);
    await recovered.resume(afterRestart, revision);
    expect(dispatched).toEqual(['mesh-waiting']);
    expect((await afterRestart.read())!.queue.tasks.map(t => t.state)).toEqual(['succeeded', 'succeeded']);
  });

  it('continues unrelated work after a mesh failure and blocks only its dependent solve', async () => {
    const tasks = [task('mesh-fails', [], 'mesh'), task('solve-dependent', ['mesh-fails']), task('mesh-unrelated', [], 'mesh')];
    const store = await queueProject(await temp(), tasks), dispatched: string[] = [];
    const queue = new ExecutionQueue({ validate: async () => [], dispatch: async t => {
      dispatched.push(t.id); return receipt(t, t.id === 'mesh-fails' ? 'failed' : 'succeeded');
    }, lookup: async () => undefined, cancel: async t => receipt(t, 'cancelled') });
    await queue.resume(store, planRevision((await store.read())!.queue.tasks));
    expect(dispatched).toEqual(['mesh-fails', 'mesh-unrelated']);
    expect((await store.read())!.queue.tasks.map(t => [t.id, t.state])).toEqual([
      ['mesh-fails', 'failed'], ['solve-dependent', 'blocked'], ['mesh-unrelated', 'succeeded'],
    ]);
  });

  it('revalidates held work only after an explicit resume', async () => {
    const store = await queueProject(await temp(), [task('repair-me')]);
    let invalid = true, launches = 0;
    const queue = new ExecutionQueue({ validate: async () => invalid ? ['fix case settings'] : [],
      dispatch: async t => { launches++; return receipt(t, 'succeeded'); }, lookup: async () => undefined,
      cancel: async t => receipt(t, 'cancelled') });
    const revision = planRevision((await store.read())!.queue.tasks);
    await queue.resume(store, revision);
    expect((await store.read())!.queue.tasks[0].state).toBe('held');
    expect(launches).toBe(0);
    invalid = false;
    await queue.resume(store, revision);
    expect(launches).toBe(1);
    expect((await store.read())!.queue.tasks[0].state).toBe('succeeded');
  });

  it('resumes only one waiting run row and leaves other rows held', async () => {
    const mesh = { ...task('mesh-a', [], 'mesh'), runId: 'run-a' };
    const generate = { ...task('generate-a', ['mesh-a'], 'generate'), runId: 'run-a' };
    const solve = { ...task('solve-a', ['generate-a']), runId: 'run-a' };
    const other = { ...task('solve-b'), runId: 'run-b' };
    const store = await queueProject(await temp(), [mesh, generate, solve, other]);
    const dispatched: string[] = [];
    const queue = new ExecutionQueue({ validate: async () => [], dispatch: async t => { dispatched.push(t.id); return receipt(t, 'succeeded'); },
      lookup: async () => undefined, cancel: async t => receipt(t, 'cancelled') });
    const revision = planRevision((await store.read())!.queue.tasks);
    await queue.resume(store, revision, ['mesh-a', 'generate-a', 'solve-a']);
    const project = (await store.read())!;
    expect(dispatched).toEqual(['mesh-a', 'generate-a', 'solve-a']);
    expect(project.queue.paused).toBe(true);
    expect(project.queue.dispatchScope).toBeUndefined();
    expect(project.queue.tasks.find(t => t.id === 'solve-b')).toMatchObject({ state: 'held', error: 'Held while a selected variant row runs.' });
  });
});

describe('run review evidence', () => {
  const run = { id: 'run-1', studyId: 'study-1', sourceRevision: 'source', meshRevision: 'mesh',
    settings: { note: '</script><script>alert(1)</script>' }, directory: '.kkss/runs/run-1',
    state: 'succeeded' as const, artifacts: [] };
  it('counts only mesh records and keeps convergence separate from process completion', () => {
    const counts = mdpaCounts(`Begin Nodes\n1 0 0 0\n// comment\nEnd Nodes\nBegin Elements Element2D3N\n1 1 2 3\n2 2 3 4\nEnd Elements\nBegin Conditions C\n1 1 2\nEnd Conditions`);
    expect(counts).toEqual({ nodes: 1, elements: 2, conditions: 1 });
    const evidence = buildEvidence(run, 'Begin Nodes\n1 0 0 0\nEnd Nodes');
    expect(evidence.mesh.nodes).toBe(1);
    expect(evidence.convergence.state).toBe('unavailable');
    expect(evidence.convergence.samples).toEqual([]);
  });
  it('embeds quality and revision-checked preparation evidence while naming unavailable diagnostics', () => {
    const quality: Json = { overallOk: false, elementCount: 1, metrics: [{ key: 'edgeRatio', badEntityTotal: 1 }] };
    const preparation: NonNullable<Evidence['preparation']> = { state: 'partial', settingsRevision: 'settings-rev', files: [
      { role: 'input', reference: { kind: 'project', path: '.kkss/runs/run-1/input/ProjectParameters.json', revision: 'old-rev' }, state: 'changed' },
    ] };
    const evidence = buildEvidence(run, 'Begin Nodes\n1 0 0 0\nEnd Nodes', undefined, [], 0, { meshQuality: quality, preparation });
    expect(evidence.mesh.quality).toEqual(quality);
    expect(evidence.preparation).toEqual(preparation);
    expect(evidence.findings.some(finding => finding.severity === 'warning' && finding.message.includes('failing metrics'))).toBe(true);
    expect(evidence.findings.some(finding => finding.message.includes('Preparation provenance is partial'))).toBe(true);
    const unavailable = buildEvidence(run);
    expect(unavailable.findings.some(finding => finding.message.includes('Mesh-quality metrics are unavailable'))).toBe(true);
    expect(unavailable.findings.some(finding => finding.message.includes('Preparation provenance is unavailable'))).toBe(true);
  });
  it('accepts only versioned structural solve-step evidence and keeps truncated records unavailable', () => {
    const monitor = [
      JSON.stringify({ adapter: 'kkss.structural-convergence', version: 1, iteration: 1, time: 0.5, converged: true }),
      JSON.stringify({ adapter: 'kkss.structural-convergence', version: 1, iteration: 2, time: 1, converged: false }),
    ].join('\n');
    const structuralRun = { ...run, settings: { problemtypeId: 'structural' }, state: 'succeeded' as const };
    const divergent = buildEvidence(structuralRun, undefined, monitor);
    expect(divergent.convergence).toMatchObject({ adapter: 'kkss.structural-convergence/v1', state: 'diverged' });
    expect(divergent.convergence.samples).toHaveLength(2);
    expect(parseStructuralConvergence(`${monitor}\n{`).invalid).toBe(1);
    expect(buildEvidence(structuralRun, undefined, `${monitor}\n{`).convergence.state).toBe('unavailable');
  });
  it('uses solver-published residuals and requires an explicit completed monitor record', () => {
    const prefix = { adapter: 'kkss.structural-convergence', version: 2 };
    const rows = [
      { ...prefix, event: 'step', iteration: 1, time: 0.5, converged: true, solverStepResult: true, analysisType: 'non_linear',
        residual: 4.5, convergenceRatio: 0.2, nonlinearIteration: 3, criterionParameters: { residual_relative_tolerance: 1e-6 },
        criterion: 'residual_criterion', residualDefinition: 'Kratos ProcessInfo.RESIDUAL_NORM' },
      { ...prefix, event: 'step', iteration: 2, time: 1, converged: true, solverStepResult: true, analysisType: 'non_linear',
        residual: 0.01, convergenceRatio: 0.0004, nonlinearIteration: 2,
        criterion: 'residual_criterion', residualDefinition: 'Kratos ProcessInfo.RESIDUAL_NORM' },
      { ...prefix, event: 'end', completed: true },
    ];
    const monitor = rows.map(row => JSON.stringify(row)).join('\n');
    const structuralRun = { ...run, settings: { problemtypeId: 'structural' }, state: 'succeeded' as const };
    const evidence = buildEvidence(structuralRun, undefined, monitor);
    expect(evidence.convergence).toMatchObject({ adapter: 'kkss.structural-convergence/v2', state: 'converged', samples: [
      { residual: 4.5, criterion: 'residual_criterion', nonlinearIteration: 3, solverStepResult: true,
        criterionParameters: { residual_relative_tolerance: 1e-6 } },
      { residual: 0.01, criterion: 'residual_criterion', nonlinearIteration: 2 },
    ] });
    expect(reviewHtml({ version: 1, projectRevision: 1, studyId: 'study', studyName: 'Cantilever', sourceRevision: 's', meshRevision: 'm',
      settings: {}, run: { id: run.id, state: 'succeeded' }, evidence, artifacts: [] })).toContain('Solver-reported residual norm');
    expect(buildEvidence(structuralRun, undefined, rows.slice(0, 2).map(row => JSON.stringify(row)).join('\n')).convergence.state).toBe('unavailable');
    const missingResidual = JSON.stringify({ ...prefix, event: 'step', iteration: 1, time: 1, converged: true }) + '\n' + JSON.stringify(rows[2]);
    expect(buildEvidence(structuralRun, undefined, missingResidual).findings.some(finding => finding.message.includes('Residual magnitudes are unavailable'))).toBe(true);
    const interrupted = JSON.stringify({ ...prefix, event: 'step', iteration: 1, time: 0.5, converged: null,
      residualUnavailableReason: 'solver exception' });
    expect(buildEvidence({ ...structuralRun, state: 'failed' }, undefined, interrupted).convergence.state).toBe('unavailable');
    const linear = [
      JSON.stringify({ ...prefix, event: 'step', iteration: 1, time: 1, analysisType: 'linear',
        solverStepResult: true, converged: null, residualUnavailableReason: 'linear strategy has no iterative convergence criterion' }),
      JSON.stringify({ ...prefix, event: 'end', completed: true }),
    ].join('\n');
    const linearEvidence = buildEvidence(structuralRun, undefined, linear);
    expect(linearEvidence.convergence).toMatchObject({ state: 'unavailable', samples: [{ solverStepResult: true, converged: null, analysisType: 'linear' }] });
  });
  it('escapes HTML and embeds JSON without allowing a script close', () => {
    expect(escapeHtml('<img src="x">')).toBe('&lt;img src=&quot;x&quot;&gt;');
    const studyFixture: Study = { ...makeStudy(), name: '</title><script>alert(1)</script>', runs: [run] };
    const html = reviewHtml({ version: 1, projectRevision: 3, studyId: studyFixture.id, studyName: studyFixture.name,
      sourceRevision: 'source', meshRevision: 'mesh', settings: run.settings,
      run: { id: run.id, state: run.state }, evidence: buildEvidence(run), artifacts: [] });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Convergence: unavailable');
  });
});

describe('run comparison', () => {
  async function compareService(root: string, study: Study, tasks: Task[]) {
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    await service.store().update((p) => { p.studies.push(study); p.queue.tasks.push(...tasks); });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    return { invoke };
  }
  function solveTask(studyId: string, runId: string, runDirectory: string): Task {
    return { id: `solve-${runId}`, studyId, runId, kind: 'solve', dependencies: [], args: { runDirectory }, inputRevision: 'in', requiredArtifacts: [], state: 'succeeded' };
  }
  async function receipt(dir: string, requestId: string) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.kkss-execution.json'), JSON.stringify({ version: 1, requestId, ownerId: 'study-1',
      state: 'succeeded', runDirectory: dir, meshPath: path.join(dir, 'mesh.mdpa'), createdAt: 1, updatedAt: 2, artifacts: [] }));
  }
  it('compares two terminal isolated runs as facts-only Markdown', async () => {
    const root = await temp();
    const left = path.join(root, 'runs', 'a-solve'), right = path.join(root, 'runs', 'b-solve');
    await receipt(left, 'req-a'); await receipt(right, 'req-b');
    const study = makeStudy();
    const { invoke } = await compareService(root, study,
      [solveTask(study.id, 'run-a', 'runs/a-solve'), solveTask(study.id, 'run-b', 'runs/b-solve')]);
    const markdown = await invoke('run_compare', { studyId: study.id, leftRunId: 'run-a', rightRunId: 'run-b' }) as string;
    expect(typeof markdown).toBe('string');
    expect(markdown).toContain('# Run comparison');
    expect(markdown).toContain('Comparable');
    expect(markdown).toContain('Never a judgement');
  });
  it('renders incomparable pairs instead of throwing, and refuses bad input', async () => {
    const root = await temp();
    const left = path.join(root, 'runs', 'a-solve'), right = path.join(root, 'runs', 'b-solve');
    await fs.mkdir(left, { recursive: true }); await fs.mkdir(right, { recursive: true });
    const study = makeStudy();
    const { invoke } = await compareService(root, study,
      [solveTask(study.id, 'run-a', 'runs/a-solve'), solveTask(study.id, 'run-b', 'runs/b-solve')]);
    const markdown = await invoke('run_compare', { studyId: study.id, leftRunId: 'run-a', rightRunId: 'run-b' }) as string;
    expect(markdown).toContain('Not comparable');
    await expect(invoke('run_compare', { studyId: study.id, leftRunId: 'run-a', rightRunId: 'run-a' })).rejects.toThrow(/different/);
    await expect(invoke('run_compare', { studyId: study.id, leftRunId: 'run-a', rightRunId: 'run-x' })).rejects.toThrow(/no solve task/);
  });
});

describe('variant comparisons', () => {
  it('retains failed and missing rows, compares only compatible units, and escapes offline output', () => {
    const parent: Study = { ...makeStudy(), name: '<baseline>', caseSettings: { load: 1 }, runs: [] };
    const failedStudy = duplicateStudy(parent, 'failed row', true, { load: 2 });
    const missingStudy = duplicateStudy(parent, 'missing row', true, { load: 3 });
    const successfulRun: Run = { id: 'run-ok', studyId: parent.id, sourceRevision: 's', meshRevision: 'm', settings: parent.caseSettings,
      directory: '.kkss/runs/run-ok', state: 'succeeded', startedAt: 10, finishedAt: 30, artifacts: [] };
    const failedRun: Run = { id: 'run-failed', studyId: failedStudy.id, sourceRevision: 's', meshRevision: 'm', settings: failedStudy.caseSettings,
      directory: '.kkss/runs/run-failed', state: 'failed', startedAt: 10, finishedAt: 50, artifacts: [] };
    const evidence = (runId: string, value: number, unit: string, state: Evidence['convergence']['state']): Evidence => ({
      version: 1, runId, findings: [], mesh: {}, convergence: { adapter: 'test', state, samples: [] },
      quantities: [{ field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', region: 'tip', time: 1, reduction: 'max', unit, value, runId,
        source: { kind: 'project', path: `.kkss/runs/${runId}/result.vtk`, revision: `rev-${runId}` } }],
    });
    const comparison = compareVariants(parent, [
      { study: parent, run: successfulRun, evidence: evidence(successfulRun.id, 0.002, 'm', 'converged') },
      { study: failedStudy, run: failedRun, evidence: evidence(failedRun.id, 0.2, 'cm', 'diverged') },
      { study: missingStudy },
    ]);
    expect(comparison.version).toBe(2);
    expect(comparison.rows.map(row => row.state)).toEqual(['succeeded', 'failed', 'missing']);
    expect(comparison.classification).toBe('solver-parameter');
    expect(comparison.rows[1].variation).toBe('solver-parameter');
    expect(comparison.rows[1].elapsedMs).toBe(40);
    expect(comparison.differences[0].changes).toMatchObject([{ path: 'load', baseline: 1, value: 2 }]);
    expect(comparison.quantities[0].compatible).toBe(false);
    expect(comparison.quantities[0].values[2]).toMatchObject({ value: null });
    expect(comparison.findings).toContain('Some scalar definitions use incompatible units and are not compared.');
    const html = comparisonHtml(comparison);
    expect(html).not.toContain('<baseline>');
    expect(html).toContain('incompatible units');
    expect(html).toContain('1 → 2');
  });

  it('classifies mesh-sensitivity studies separately from solver changes', () => {
    const parent = { ...makeStudy(), caseSettings: { load: 1 } };
    const meshVariant = { ...duplicateStudy(parent, 'fine mesh', false, parent.caseSettings), meshing: { size: 1 } };
    const baselineRun: Run = { id: 'base', studyId: parent.id, sourceRevision: 's', meshRevision: 'coarse', settings: parent.caseSettings,
      directory: '.kkss/runs/base', state: 'succeeded', artifacts: [] };
    const fineRun: Run = { ...baselineRun, id: 'fine', studyId: meshVariant.id, meshRevision: 'fine', directory: '.kkss/runs/fine' };
    const comparison = compareVariants(parent, [{ study: parent, run: baselineRun }, { study: meshVariant, run: fineRun }]);
    expect(comparison.classification).toBe('mesh-sensitivity');
    expect(comparison.rows[1].variation).toBe('mesh-sensitivity');
    expect(comparisonHtml(comparison)).toContain('Study type: mesh-sensitivity');
  });
});

describe('shared workflow tools', () => {
  it('publishes the same workflow tools through the chat registry and dispatches to their shared service', async () => {
    const root = await temp();
    const source = path.join(root, 'beam.step');
    await fs.writeFile(source, 'a geometry');
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: '/python', env: {} }),
      open: async () => undefined, changed: () => undefined, callMcpTool: async () => ({}), toolReady: () => true });
    registerAppTools(service.tools());
    try {
      expect(appTools().map(tool => tool.name).sort()).toEqual(service.tools().map(tool => tool.name).sort());
      const created = await callAppTool('app__study_create', { name: 'Chat-created study', source });
      expect(created.isError).toBeUndefined();
      const listed = await callAppTool('app__study_list', {});
      expect(listed.isError).toBeUndefined();
      const listedText = listed.content.find(block => block.type === 'text');
      expect(listedText?.type === 'text' ? JSON.parse(listedText.text) : null).toMatchObject({ project: { studies: [{ name: 'Chat-created study' }] } });
    } finally {
      registerAppTools([]);
    }
  });

  it('consumes the version-1 CAD handoff contract after verifying both artifact revisions', async () => {
    const root = await temp(), geometry = path.join(root, 'beam.step'), mesh = path.join(root, 'beam.mdpa');
    await fs.writeFile(geometry, 'geometry');
    await fs.writeFile(mesh, 'Begin Nodes\nEnd Nodes\n');
    const manifestPath = path.join(root, 'beam-handoff.json');
    await fs.writeFile(manifestPath, JSON.stringify({
      version: 1, exportId: 'export-1',
      source: { kind: 'external', path: geometry, revision: await fileRevision(geometry) },
      replayRevision: 'a'.repeat(64), units: { length: 'mm', scale: 1 },
      options: { dimension: 3, sizeMax: 2 }, engine: 'gmsh', engineVersion: '4.13.1', engineVersionSource: 'runtime General.Version',
      artifacts: [{ role: 'mesh', reference: { kind: 'external', path: mesh, revision: await fileRevision(mesh) }, ownerId: 'export-1' }],
      groups: [{ name: 'Fixed', id: 'Fixed:2', dimension: 2, count: 1 }],
      boundaryCoverage: { state: 'unavailable', reason: 'Not sampled.' },
      findings: [{ severity: 'unavailable', message: 'Boundary coverage not sampled.', target: 'boundary-coverage' }],
    }));
    const service = new WorkflowService({ root: () => root, activeMesh: () => mesh,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    const invoke = (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_import_handoff', { name: 'Imported cantilever', manifestPath }) as Study;
    expect(study.source).toMatchObject({ kind: 'project', path: 'beam.step' });
    expect(study.mesh).toMatchObject({ kind: 'project', path: 'beam.mdpa' });
    expect(study.handoff).toMatchObject({ engine: 'gmsh', engineVersion: '4.13.1', boundaryCoverage: { state: 'unavailable' } });
    expect((await service.snapshot() as { readiness: Record<string, Record<string, string>> }).readiness[study.id].mesh).toBe('ready');

    const before = (await service.store().read())!.revision;
    await expect(invoke('study_import_handoff', { name: 'Wrong version', manifestPath: await (async () => {
      const unknown = path.join(root, 'unknown-handoff.json'); await fs.writeFile(unknown, JSON.stringify({ version: 99 })); return unknown;
    })() })).rejects.toThrow(/Unsupported CAD handoff schema/);
    expect((await service.store().read())!.revision).toBe(before);
  });

  it('probes the ssh host instead of this machine when a remote host is configured', async () => {
    const root = await temp();
    const calls: string[] = [];
    const ssh = async (_host: string, command: string) => {
      calls.push(command);
      if (command.startsWith('python3 ')) return { code: 0, stderr: '', stdout: `KKSS_PROBE:${JSON.stringify({ executable: '/usr/bin/python3', version: '3.12.1', threadControl: true, applications: [{ name: 'KratosMultiphysics', available: true }] })}\n` };
      if (command.startsWith('nproc')) return { code: 0, stderr: '', stdout: '16\n' };
      return { code: 0, stderr: '', stdout: '' };
    };
    const discover = vi.fn(async () => ({ command: 'uvx', args: [] }));
    let host: string | undefined = 'hpc';
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined, runtime: { discover },
      environment: () => ({ python: 'python', env: {} }), open: async () => undefined, changed: () => undefined,
      remote: () => host ? { host, ssh } : undefined });
    const report = await service.environment(true);
    expect(report).toMatchObject({ host: 'hpc', cpuCount: 16, suggestedThreads: 15 });
    expect(discover).not.toHaveBeenCalled();
    expect(JSON.parse(service.context())).toMatchObject({ solvesRunOn: 'hpc', runtime: { manual: true, tools: false } });
    host = undefined; // Clearing the host must invalidate the cached remote report.
    expect(JSON.parse(service.context()).runtime).toBe('not checked or settings changed');
  });

  it('drives a queued solve through the remote runner to downloaded, reviewable outputs', async () => {
    const { spawn } = await import('node:child_process');
    const fsSync = await import('node:fs');
    const root = await temp(), bin = path.join(root, '..', path.basename(root) + '-bin');
    roots.push(bin);
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, 'python3'), '#!/bin/sh\n[ "$1" = "-c" ] && exit 0\nprintf "# vtk DataFile Version 3.0\\n" > result.vtk\necho solver-done\n', { mode: 0o755 });
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    try {
      const ssh = (_h: string, command: string, o: { stdinFile?: string; stdoutFile?: string } = {}) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
        const child = spawn('sh', ['-c', command], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        const sink = o.stdoutFile ? fsSync.createWriteStream(o.stdoutFile) : undefined;
        if (sink) child.stdout.pipe(sink); else child.stdout.on('data', d => (stdout += d));
        child.stderr.on('data', d => (stderr += d));
        if (o.stdinFile) fsSync.createReadStream(o.stdinFile).pipe(child.stdin); else child.stdin.end();
        child.on('close', code => { const done = () => resolve({ code: code ?? 1, stdout, stderr }); if (sink) sink.end(done); else done(); });
      });
      const geometry = path.join(root, 'beam.step'); await fs.writeFile(geometry, 'geometry');
      const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
        runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
        open: async () => undefined, changed: () => undefined, remote: () => ({ host: 'hpc', ssh }),
        callMcpTool: async () => ({ structuredContent: { ok: true } }) });
      const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
      const study = await invoke('study_create', { name: 'Cantilever', source: geometry }) as Study;
      const runId = 'remote-run', dir = `.kkss/runs/${runId}`;
      await fs.mkdir(path.join(root, dir, 'input'), { recursive: true });
      await fs.writeFile(path.join(root, dir, 'input', 'MainKratos.py'), '# case');
      await fs.writeFile(path.join(root, dir, 'input', 'beam.mdpa'), 'Begin Nodes\nEnd Nodes\n');
      const task: Task = { id: 'solve-1', studyId: study.id, runId, kind: 'solve', dependencies: [], resources: { threads: 1, verified: true },
        args: { mesh: `${dir}/input/beam.mdpa`, casePath: `${dir}/case.json`, caseState: {}, problemtype: 'structural', runDirectory: `${dir}/solve`, threads: 1 },
        inputRevision: 'rev', requiredArtifacts: [], state: 'waiting' };
      await service.store().update(project => { project.queue.tasks.push(task); });
      const plan = (await service.store().read())!;
      await invoke('queue_resume', { planRevision: planRevision(plan.queue.tasks) });
      for (let i = 0; i < 100; i++) {
        const state = (await service.store().read())!.queue.tasks[0].state;
        if (state === 'succeeded' || state === 'failed' || state === 'uncertain') break;
        await new Promise(r => setTimeout(r, 100));
        await invoke('queue_resume', { planRevision: planRevision((await service.store().read())!.queue.tasks) }).catch(() => undefined);
      }
      const done = (await service.store().read())!.queue.tasks[0];
      expect(done.state, JSON.stringify(done.receipt)).toBe('succeeded');
      expect(done.receipt?.message).toMatch(/convergence is not established/i);
      expect(await fs.readFile(path.join(root, dir, 'solve', 'result.vtk'), 'utf8')).toMatch(/vtk DataFile/);
      expect(done.receipt?.artifacts?.map(a => a.role).sort()).toEqual(['log', 'result']);
      // Reviewable: the run is importable/reviewable from the downloaded, checksummed outputs.
      expect(done.receipt?.artifacts?.every(a => a.reference.revision?.length === 64)).toBe(true);
    } finally { process.env.PATH = oldPath; }
  });

  it('drives a queued solve through the MPI runner on this machine, with ranks frozen in the plan', async () => {
    const root = await temp(), bin = path.join(root, '..', path.basename(root) + '-mpibin');
    roots.push(bin);
    await fs.mkdir(bin, { recursive: true });
    const python = path.join(bin, 'python');
    await fs.writeFile(python, '#!/bin/sh\n[ "$1" = "-c" ] && exit 0\ngrep -o MPI ProjectParameters.json > result.vtk\necho solver-done\n', { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'mpirun'), '#!/bin/sh\nn=$2; shift 2\ni=0; while [ $i -lt $n ]; do OMPI_COMM_WORLD_RANK=$i "$@" & pids="$pids $!"; i=$((i+1)); done\nrc=0; for p in $pids; do wait $p || rc=$?; done; exit $rc\n', { mode: 0o755 });
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
    try {
      const geometry = path.join(root, 'beam.step'); await fs.writeFile(geometry, 'geometry');
      const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
        runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python, env: {}, mpiRanks: 2 }),
        open: async () => undefined, changed: () => undefined, callMcpTool: async () => ({ structuredContent: { ok: true } }) });
      const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
      const study = await invoke('study_create', { name: 'Cantilever', source: geometry }) as Study;
      const runId = 'mpi-run', dir = `.kkss/runs/${runId}`;
      await fs.mkdir(path.join(root, dir, 'input'), { recursive: true });
      await fs.writeFile(path.join(root, dir, 'input', 'MainKratos.py'), '# case');
      await fs.writeFile(path.join(root, dir, 'input', 'ProjectParameters.json'), JSON.stringify({ problem_data: { parallel_type: 'OpenMP' }, solver_settings: { solver_type: 'Static' } }));
      await fs.writeFile(path.join(root, dir, 'input', 'beam.mdpa'), 'Begin Nodes\nEnd Nodes\n');
      const task: Task = { id: 'solve-mpi', studyId: study.id, runId, kind: 'solve', dependencies: [], resources: { threads: 2, verified: true },
        args: { mesh: `${dir}/input/beam.mdpa`, casePath: `${dir}/case.json`, caseState: {}, problemtype: 'structural', runDirectory: `${dir}/solve`, threads: 1,
          mpiRanks: 2, mpiThreadsPerRank: 1, mpiLauncher: 'mpirun', runtimeRevision: fingerprint({ python, installPath: '', extraEnv: {}, threads: 0, mpiRanks: 2 }) },
        inputRevision: 'rev', requiredArtifacts: [], state: 'waiting' };
      await service.store().update(project => { project.queue.tasks.push(task); });
      await invoke('queue_resume', { planRevision: planRevision((await service.store().read())!.queue.tasks) });
      for (let i = 0; i < 100; i++) {
        const state = (await service.store().read())!.queue.tasks[0].state;
        if (state === 'succeeded' || state === 'failed' || state === 'uncertain') break;
        await new Promise(r => setTimeout(r, 100));
        await invoke('queue_resume', { planRevision: planRevision((await service.store().read())!.queue.tasks) }).catch(() => undefined);
      }
      const done = (await service.store().read())!.queue.tasks[0];
      expect(done.state, JSON.stringify(done.receipt)).toBe('succeeded');
      expect(done.receipt?.message).toMatch(/convergence is not established/i);
      expect(done.receipt?.resources).toEqual({ requestedThreads: 2, effectiveThreads: 2 });
      expect(await fs.readFile(path.join(root, dir, 'solve', 'result.vtk'), 'utf8')).toMatch(/MPI/);
      expect(await fs.readFile(path.join(root, dir, 'input', 'ProjectParameters.json'), 'utf8')).toMatch(/OpenMP/); // the preview's input is never rewritten
    } finally { process.env.PATH = oldPath; }
  });

  it('freezes MPI ranks into the preview only when the probe verified a launcher and an MPI-enabled Kratos', async () => {
    const root = await temp(), bin = path.join(root, '..', path.basename(root) + '-probe');
    roots.push(bin);
    await fs.mkdir(bin, { recursive: true });
    const probe = (extra: object) => `#!/bin/sh\necho 'KKSS_PROBE:${JSON.stringify({ executable: '/py', version: '3.12', threadControl: true, applications: [{ name: 'KratosMultiphysics', available: true }], mpiPosix: true, ...extra })}'\n`;
    const geometry = path.join(root, 'beam.step'); await fs.writeFile(geometry, 'geometry');
    const preview = async (extra: object, mpiRanks = 2) => {
      const python = path.join(bin, `python-${Math.random().toString(36).slice(2)}`);
      await fs.writeFile(python, probe(extra), { mode: 0o755 });
      const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
        runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python, env: {}, mpiRanks }),
        open: async () => undefined, changed: () => undefined });
      const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
      const study = await invoke('study_create', { name: `s-${Math.random()}`, source: geometry }) as Study;
      return invoke('queue_plan_preview', { studyId: study.id, reuseMesh: false }) as Promise<{ tasks: Task[]; summary: string[] }>;
    };
    await expect(preview({ mpiLauncher: null, mpiMissing: [] })).rejects.toThrow(/MPI is unavailable: No MPI launcher/);
    await expect(preview({ mpiLauncher: 'mpirun', mpiMissing: ['KratosMultiphysics.TrilinosApplication'] })).rejects.toThrow(/not MPI-enabled \(KratosMultiphysics\.TrilinosApplication is not importable\)/);
    await expect(preview({ mpiLauncher: 'mpirun', mpiMissing: [] }, 100000)).rejects.toThrow(/exceed the \d+ available CPUs/);
    const ok = await preview({ mpiLauncher: 'mpiexec', mpiMissing: [] });
    const solve = ok.tasks.find(t => t.kind === 'solve')!;
    expect(solve.args).toMatchObject({ mpiRanks: 2, mpiThreadsPerRank: 1, mpiLauncher: 'mpiexec', threads: 1 });
    expect(solve.resources).toEqual({ threads: 2, verified: true });
    expect(ok.summary).toContain('MPI: 2 ranks × 1 threads (mpiexec, one node)');
    expect(ok.tasks.filter(t => t.kind !== 'solve').every(t => typeof t.args.mpiRanks !== 'number')).toBe(true);
    // Zero ranks keeps the threaded plan byte-for-byte: no MPI keys anywhere.
    const threaded = await preview({ mpiLauncher: 'mpirun', mpiMissing: [] }, 0);
    expect(Object.keys(threaded.tasks.find(t => t.kind === 'solve')!.args).some(k => k.startsWith('mpi'))).toBe(false);
  });

  it('previews and atomically enqueues isolated run and parameter-sweep destinations', async () => {
    const root = await temp(), geometry = path.join(root, 'beam.step');
    await fs.writeFile(geometry, 'geometry');
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const source = await invoke('study_create', { name: 'Cantilever', source: geometry }) as Study;
    const preview = await invoke('queue_parameter_sweep_preview', { studyId: source.id, reuseMesh: false,
      parameterPath: 'values.problem.timeStep', values: [0.05, 0.1] }) as { previewId: string; runCount: number; variants: { name: string; destination: string; differences: string[] }[] };
    expect(preview.runCount).toBe(2);
    expect(preview.variants).toHaveLength(2);
    expect(preview.variants[0].differences).toContain('values.problem.timeStep');
    expect(preview.variants[0].destination).toMatch(/^\.kkss\/runs\//);
    expect((await service.store().read())!.studies).toHaveLength(1); // Preview is read-only.
    const queued = await invoke('queue_enqueue', { previewId: preview.previewId }) as { planRevision: string; tasks: Task[] };
    const project = (await service.store().read())!;
    expect(project.queue.paused).toBe(true);
    expect(project.studies).toHaveLength(3);
    expect(new Set(queued.tasks.map(task => task.studyId)).size).toBe(2);
    expect(new Set(queued.tasks.map(task => task.runId)).size).toBe(2);
    expect(queued.planRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  it('expands multi-parameter case sweeps as a grid or paired lists, shows the expansion first, and persists nothing', async () => {
    const root = await temp(), geometry = path.join(root, 'beam.step');
    await fs.writeFile(geometry, 'geometry');
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_create', { name: 'Beam', source: geometry }) as Study;
    const parameters = [{ path: 'values.problem.timeStep', values: [0.05, 0.1] }, { path: 'values.problem.endTime', values: [1, 2, 3] }];
    type Preview = { previewId: string; runCount: number; summary: string[]; expansion: { mode: string; count: number }; variants: { name: string; differences: string[] }[] };
    const grid = await invoke('queue_parameter_sweep_preview', { studyId: study.id, reuseMesh: false, parameters }) as Preview;
    expect(grid.runCount).toBe(6);
    expect(grid.expansion).toMatchObject({ mode: 'grid', count: 6 });
    expect(grid.summary[0]).toMatch(/grid 2 × 3 = 6 rows/);
    expect(grid.variants[0].name).toBe('values.problem.timeStep=0.05, values.problem.endTime=1');
    expect(grid.variants.some(v => v.differences.includes('values.problem.timeStep') && v.differences.includes('values.problem.endTime'))).toBe(true);
    expect((await service.store().read())!.studies).toHaveLength(1);
    await expect(invoke('queue_parameter_sweep_preview', { studyId: study.id, reuseMesh: false, parameters, mode: 'paired' })).rejects.toThrow(/equal length/);
    await expect(invoke('queue_parameter_sweep_preview', { studyId: study.id, reuseMesh: false, parameters, parameterPath: 'values.problem.timeStep', values: [1] })).rejects.toThrow(/not both/);
    const paired = await invoke('queue_parameter_sweep_preview', { studyId: study.id, reuseMesh: false, mode: 'paired',
      parameters: [{ path: 'values.problem.timeStep', values: [0.05, 0.1] }, { path: 'values.problem.endTime', values: [1, 2] }] }) as Preview;
    expect(paired.runCount).toBe(2);
    await invoke('queue_enqueue', { previewId: grid.previewId });
    expect((await service.store().read())!.studies).toHaveLength(7);
  });

  it('applies several CAD variables per geometry row and refuses an unknown one', async () => {
    const root = await temp(), geometry = path.join(root, 'plate.step');
    await fs.writeFile(geometry, 'geometry');
    let variables = [{ name: 'L', expr: '10', value: 10, error: null }, { name: 'W', expr: '5', value: 5, error: null }];
    const sets: unknown[] = [];
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined,
      callMcpTool: async (name, args) => {
        if (name === 'cad__get_state') return { structuredContent: { variables } };
        if (name === 'cad__set_variables') { sets.push(args.variables); variables = (args.variables as { name: string; expr: string }[]).map(v => ({ ...v, value: 0, error: null })); return { structuredContent: { variables } }; }
        throw new Error(`unexpected ${name}`);
      } });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_create', { name: 'Plate', source: geometry }) as Study;
    const preview = await invoke('queue_geometry_sweep_preview', { studyId: study.id, mode: 'paired',
      variables: [{ name: 'L', values: [20, 30] }, { name: 'W', values: [2, 3] }] }) as { previewId: string; runCount: number; expansion: { count: number } };
    expect(preview).toMatchObject({ runCount: 2, expansion: { count: 2 } });
    await expect(invoke('queue_geometry_sweep_preview', { studyId: study.id, variable: 'L', values: [1], variables: [] })).rejects.toThrow(/not both/);
    await invoke('queue_enqueue', { previewId: preview.previewId });
    const geo = (await service.store().read())!.queue.tasks.filter(t => t.kind === 'geometry')[0];
    const dispatch = (task: Task) => (service as unknown as { dispatchQueuedTask(t: Task, s: unknown): Promise<{ state: string; message?: string }> }).dispatchQueuedTask(task, service.store());
    expect(await dispatch(geo)).toMatchObject({ state: 'succeeded' });
    expect(sets[0]).toEqual([{ name: 'L', expr: '20' }, { name: 'W', expr: '2' }]);
    const bad = await invoke('queue_geometry_sweep_preview', { studyId: study.id, variables: [{ name: 'L', values: [1] }, { name: 'H', values: [1] }] }) as { previewId: string };
    await invoke('queue_enqueue', { previewId: bad.previewId });
    const badTask = (await service.store().read())!.queue.tasks.filter(t => t.kind === 'geometry').slice(-1)[0];
    expect(await dispatch(badTask)).toMatchObject({ state: 'failed', message: expect.stringMatching(/defines no variable "H"/) });
  });

  it('plans a geometry sweep as copy → mesh → generate → solve, writes nothing, and copies without touching the model', async () => {
    const root = await temp(), geometry = path.join(root, 'plate.step');
    await fs.writeFile(geometry, 'geometry'); await fs.writeFile(`${geometry}.edits.json`, '{"base":true}');
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let variables = [{ name: 'L', expr: '10', value: 10, error: null }, { name: 'W', expr: 'L/2', value: 5, error: null }];
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined,
      callMcpTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'cad__get_state') return { structuredContent: { variables } };
        if (name === 'cad__set_variables') { variables = (args.variables as { name: string; expr: string }[]).map(v => ({ ...v, value: 0, error: null })); return { structuredContent: { variables } }; }
        throw new Error(`unexpected ${name}`);
      } });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_create', { name: 'Plate', source: geometry }) as Study;
    const preview = await invoke('queue_geometry_sweep_preview', { studyId: study.id, variable: 'L', values: [20, 30] }) as { previewId: string; runCount: number; variants: { runId: string; geometry: { variables: Record<string, string> } }[] };
    expect(preview.runCount).toBe(2);
    expect(preview.variants.map(v => v.geometry.variables.L)).toEqual(['20', '30']);
    expect((await service.store().read())!.studies).toHaveLength(1);
    expect(await fs.readdir(root)).not.toContain('.kkss/runs');
    await expect(invoke('queue_geometry_sweep_preview', { studyId: study.id, variable: 'L', values: [] })).rejects.toThrow(/1–50/);

    await invoke('queue_enqueue', { previewId: preview.previewId });
    const project = (await service.store().read())!;
    const rowTasks = project.queue.tasks.filter(t => t.runId === preview.variants[0].runId);
    expect(rowTasks.map(t => t.kind)).toEqual(['geometry', 'mesh', 'generate', 'solve']);
    const [geo, mesh] = rowTasks;
    expect(mesh.dependencies).toEqual([geo.id]);
    const row = project.studies.find(s => s.id === geo.studyId)!;
    expect(row.source.path).toBe(`.kkss/runs/${geo.runId}/geometry/plate.step`);
    expect(row.source.revision).toBe(project.studies[0].source.revision); // same bytes ⇒ same content revision
    expect(mesh.args.sourceRevision).toBe(row.source.revision);

    const receipt = await (service as unknown as { dispatchQueuedTask(t: Task, s: unknown): Promise<{ state: string; artifacts: { role: string }[] }> }).dispatchQueuedTask(geo, service.store());
    expect(receipt).toMatchObject({ state: 'succeeded', artifacts: [{ role: 'geometry' }] });
    const copy = path.join(root, geo.args.destination as string);
    expect(await fs.readFile(copy, 'utf8')).toBe('geometry');
    expect(await fs.readFile(`${copy}.edits.json`, 'utf8')).toBe('{"base":true}');
    expect(await fs.readFile(geometry, 'utf8')).toBe('geometry'); // the user's model is untouched
    const set = calls.find(c => c.name === 'cad__set_variables')!;
    expect(set.args.path).toBe(copy);
    expect(set.args.variables).toEqual([{ name: 'L', expr: '20' }, { name: 'W', expr: 'L/2' }]);

    // A model that defines no such variable fails the row instead of silently changing nothing.
    const bad = await invoke('queue_geometry_sweep_preview', { studyId: study.id, variable: 'H', values: [1] }) as { previewId: string };
    await invoke('queue_enqueue', { previewId: bad.previewId });
    const badTask = (await service.store().read())!.queue.tasks.filter(t => t.kind === 'geometry').slice(-1)[0];
    expect(await (service as unknown as { dispatchQueuedTask(t: Task, s: unknown): Promise<{ state: string; message?: string }> }).dispatchQueuedTask(badTask, service.store()))
      .toMatchObject({ state: 'failed', message: expect.stringMatching(/defines no variable "H"/) });
  });

  it('stops a geometry row before its solve when the re-exported mesh lost a region the case references', async () => {
    const root = await temp(), geometry = path.join(root, 'plate.step');
    await fs.writeFile(geometry, 'geometry');
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined,
      callMcpTool: async (name) => name === 'mesh__case_validate' ? { structuredContent: { ok: true } } : { structuredContent: {} } });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_create', { name: 'Plate', source: geometry }) as Study;
    await invoke('study_set_settings', { studyId: study.id, caseSettings: { problemtypeId: 'structural', assignments: [{ conditionId: 'c', smpPath: 'Inlet', values: {} }] } });
    const preview = await invoke('queue_geometry_sweep_preview', { studyId: study.id, variable: 'L', values: [20] }) as { previewId: string };
    await invoke('queue_enqueue', { previewId: preview.previewId });
    const tasks = (await service.store().read())!.queue.tasks;
    const generate = tasks.find(t => t.kind === 'generate')!;
    await fs.mkdir(path.dirname(path.join(root, generate.args.mesh as string)), { recursive: true });
    const validate = (task: Task) => (service as unknown as { validateQueuedTask(t: Task, s: unknown): Promise<string[]> }).validateQueuedTask(task, service.store());
    await fs.writeFile(path.join(root, generate.args.mesh as string), 'Begin Nodes\n1 0 0 0\nEnd Nodes\nBegin SubModelPart Outlet\nEnd SubModelPart\n');
    expect((await validate(generate)).join('\n')).toMatch(/no longer has Inlet.*matched by name only/);
    await fs.writeFile(path.join(root, generate.args.mesh as string), 'Begin Nodes\n1 0 0 0\nEnd Nodes\nBegin SubModelPart Inlet\nEnd SubModelPart\n');
    expect((await validate(generate)).join('\n')).not.toMatch(/no longer has/);
  });

  it('dispatches mesh work with durable CAD owner/request identities and reconciles by receipt', async () => {
    const root = await temp(), geometry = path.join(root, 'beam.step');
    await fs.writeFile(geometry, 'geometry');
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const deps = { root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined,
      callMcpTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        if (name === 'cad__job_status') return { structuredContent: { version: 1, ownerId: args.ownerId, requestId: args.requestId,
          jobId: 'cad-job-1', operation: 'export_mesh', state: 'uncertain', createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(), artifacts: [], message: 'No live runner record.' } };
        if (name === 'cad__job_cancel') return { structuredContent: { version: 1, ownerId: args.ownerId, requestId: args.requestId,
          jobId: 'cad-job-1', operation: 'export_mesh', state: 'cancelled', createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(), artifacts: [] } };
        const outputPath = String(args.outputPath), handoffPath = String(args.handoffPath), sourcePath = String(args.path);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, 'Begin Nodes\nEnd Nodes\n');
        const meshRevision = await fileRevision(outputPath), sourceRevision = await fileRevision(sourcePath);
        const handoff = { version: 1, exportId: 'export-1', source: { kind: 'external', path: sourcePath, revision: sourceRevision },
          replayRevision: 'a'.repeat(64), units: { length: 'mm', scale: 1 }, options: args.options, engine: 'gmsh',
          engineVersion: '4.13.1', engineVersionSource: 'runtime General.Version',
          artifacts: [{ role: 'mesh', reference: { kind: 'external', path: outputPath, revision: meshRevision }, ownerId: 'export-1' }],
          groups: [], boundaryCoverage: { state: 'unavailable', reason: 'Not measured.' }, findings: [] };
        await fs.writeFile(handoffPath, JSON.stringify(handoff));
        const handoffRevision = await fileRevision(handoffPath);
        return { structuredContent: { execution: { version: 1, ownerId: args.ownerId, requestId: args.requestId,
          jobId: 'cad-job-1', operation: 'export_mesh', state: 'succeeded', createdAt: new Date(1).toISOString(),
          updatedAt: new Date(2).toISOString(), artifacts: [
            { role: 'mesh', reference: { kind: 'external', path: outputPath, revision: meshRevision } },
            { role: 'handoff', reference: { kind: 'external', path: handoffPath, revision: handoffRevision } },
          ] } } };
      } };
    const service = new WorkflowService(deps);
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(tool => tool.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_create', { name: 'Cantilever', source: geometry }) as Study;
    const runId = 'run-owned-mesh';
    const task: Task = { id: 'mesh-request-1', studyId: study.id, runId, kind: 'mesh', dependencies: [],
      args: { source: study.source as unknown as Json, sourceRevision: study.source.revision, options: study.meshing,
        output: `.kkss/runs/${runId}/input/beam.mdpa`, handoff: `.kkss/runs/${runId}/handoff.json` },
      inputRevision: fingerprint({ source: study.source.revision, meshing: study.meshing }),
      requiredArtifacts: [`.kkss/runs/${runId}/input/beam.mdpa`, `.kkss/runs/${runId}/handoff.json`], state: 'waiting' };
    const store = service.store(); await store.update(project => { project.queue.tasks.push(task); });
    const plan = (await store.read())!;
    await invoke('queue_resume', { planRevision: planRevision(plan.queue.tasks) });
    expect(calls[0].name).toBe('cad__export_mesh');
    expect(calls[0].args).toMatchObject({ ownerId: study.id, requestId: task.id,
      receiptPath: path.join(root, '.kkss', 'runs', runId, 'cad-execution.json') });
    expect((await store.read())!.queue.tasks[0].receipt).toMatchObject({ jobId: 'cad-job-1', requestId: task.id, state: 'succeeded' });

    const activeTask = { ...task, id: 'mesh-request-restart', state: 'running' as const };
    await store.update(project => { project.queue.tasks[0] = activeTask; });
    calls.length = 0;
    const restarted = new WorkflowService(deps);
    await restarted.snapshot();
    expect(calls[0]).toMatchObject({ name: 'cad__job_status', args: { ownerId: study.id, requestId: activeTask.id,
      receiptPath: path.join(root, '.kkss', 'runs', runId, 'cad-execution.json') } });
    expect((await restarted.store().read())!.queue.tasks[0]).toMatchObject({ state: 'uncertain', receipt: { state: 'uncertain' } });
    calls.length = 0;
    await invoke('queue_cancel', { taskId: activeTask.id });
    expect(calls[0]).toMatchObject({ name: 'cad__job_cancel', args: { ownerId: study.id, requestId: activeTask.id,
      receiptPath: path.join(root, '.kkss', 'runs', runId, 'cad-execution.json') } });
    expect((await restarted.store().read())!.queue.tasks[0].state).toBe('cancelled');
  });

  it('retries a failed variant with fresh study and run identities in the same comparison group', async () => {
    const root = await temp(), geometry = path.join(root, 'beam.step');
    await fs.writeFile(geometry, 'geometry');
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const parent = await invoke('study_create', { name: 'Cantilever', source: geometry }) as Study;
    const failed = duplicateStudy(parent, 'failed load', false, { problemtypeId: 'structural', load: 2 });
    failed.runs.push({ id: 'old-run', studyId: failed.id, sourceRevision: 'source', meshRevision: 'mesh', settings: failed.caseSettings,
      directory: '.kkss/runs/old-run', state: 'failed', artifacts: [] });
    await service.store().update(project => project.studies.push(failed));
    const preview = await invoke('queue_retry_variant_preview', { studyId: failed.id, reuseMesh: false }) as { previewId: string; variants: { id: string; runId: string }[] };
    expect(preview.variants).toHaveLength(1);
    expect(preview.variants[0].id).not.toBe(failed.id);
    expect(preview.variants[0].runId).not.toBe('old-run');
    expect((await service.store().read())!.studies).toHaveLength(2); // Preview did not mutate the project.
    await invoke('queue_enqueue', { previewId: preview.previewId });
    const project = (await service.store().read())!;
    const retry = project.studies.find(study => study.id === preview.variants[0].id)!;
    expect(retry.parentId).toBe(parent.id);
    expect(retry.runs).toEqual([]);
    expect(project.studies.find(study => study.id === failed.id)!.runs[0].id).toBe('old-run');
  });

  it('keeps external sources by default and makes copy and relink explicit', async () => {
    const root = await temp(), externalDir = await temp(), geometry = path.join(externalDir, 'beam.step'), replacement = path.join(externalDir, 'beam-v2.step');
    const mesh = path.join(root, 'beam.mdpa');
    await fs.writeFile(geometry, 'original'); await fs.writeFile(replacement, 'replacement'); await fs.writeFile(mesh, 'Begin Nodes\nEnd Nodes\n');
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_create', { name: 'External beam', source: geometry }) as Study;
    expect(study.source.kind).toBe('external');
    await invoke('study_attach_mesh', { studyId: study.id, meshPath: mesh });
    await invoke('study_relink_source', { studyId: study.id, sourcePath: replacement });
    let current = (await service.store().read())!.studies[0];
    expect(current.source.path).toBe(replacement);
    expect((await readiness(root, current)).mesh).toBe('stale');
    // Relocation: the mesh moved with identical bytes is accepted; different bytes are refused and nothing changes.
    const moved = path.join(externalDir, 'moved.mdpa'), other = path.join(externalDir, 'other.mdpa');
    await fs.copyFile(mesh, moved); await fs.writeFile(other, 'Begin Nodes\nEnd Nodes\n# changed\n');
    const refused = await invoke('study_relink_reference', { studyId: study.id, role: 'mesh', path: other }) as { relinked: boolean; expectedRevision?: string };
    expect(refused.relinked).toBe(false); expect(refused.expectedRevision).toMatch(/^[a-f0-9]{64}$/);
    expect((await service.store().read())!.studies[0].mesh!.path).toBe('beam.mdpa');
    const relocated = await invoke('study_relink_reference', { studyId: study.id, role: 'mesh', path: moved }) as { relinked: boolean };
    expect(relocated.relinked).toBe(true);
    expect((await service.store().read())!.studies[0].mesh).toMatchObject({ kind: 'external', path: moved });
    await expect(invoke('study_relink_reference', { studyId: study.id, role: 'source', path: moved })).rejects.toThrow(/study_relink_source/);
    await expect(invoke('study_relink_reference', { studyId: study.id, role: 'handoff', path: moved })).rejects.toThrow(/no handoff/);
    const copied = await invoke('study_copy_source_into_project', { studyId: study.id }) as { source: { kind: string; path: string } };
    expect(copied.source.kind).toBe('project');
    expect(await fs.readFile(replacement, 'utf8')).toBe('replacement');
    current = (await service.store().read())!.studies[0];
    expect((await readiness(root, current)).mesh).toBe('stale');
  });

  it('reports region carry-over on attach and renames references only on an explicit, revision-bound apply', async () => {
    const root = await temp(), geometry = path.join(root, 'plate.step'), mesh = path.join(root, 'plate.mdpa'), renamed = path.join(root, 'plate2.mdpa');
    await fs.writeFile(geometry, 'geometry');
    const body = (name: string) => `Begin Nodes\n1 0 0 0\nEnd Nodes\nBegin SubModelPart ${name}\nEnd SubModelPart\n`;
    await fs.writeFile(mesh, body('Inlet')); await fs.writeFile(renamed, body('Inflow'));
    await fs.writeFile(caseFilePath(mesh), JSON.stringify({ problemtypeId: 'structural', assignments: [{ conditionId: 'c', smpPath: 'Inlet', values: {} }] }));
    await fs.writeFile(caseFilePath(renamed), JSON.stringify({ problemtypeId: 'structural', assignments: [{ conditionId: 'c', smpPath: 'Inlet', values: {} }] }));
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const study = await invoke('study_create', { name: 'Plate', source: geometry }) as Study;
    const first = await invoke('study_attach_mesh', { studyId: study.id, meshPath: mesh }) as { regionCarryOver: { current: { lost: number } } };
    expect(first.regionCarryOver.current.lost).toBe(0);
    const second = await invoke('study_attach_mesh', { studyId: study.id, meshPath: renamed }) as { regionCarryOver: { current: { lost: number; regions: { possibleRename?: string }[] } } };
    expect(second.regionCarryOver.current.lost).toBe(1);
    const refs = await invoke('study_region_references', { studyId: study.id }) as { settingsRevision: string; report: { regions: { path: string; status: string }[] } };
    expect(refs.report.regions).toMatchObject([{ path: 'Inlet', status: 'lost' }]);
    const before = JSON.stringify((await service.store().read())!.studies[0].caseSettings);
    const preview = await invoke('study_region_rename', { studyId: study.id, renames: [{ from: 'Inlet', to: 'Inflow' }] }) as { applied: boolean; wouldChange: number };
    expect(preview).toMatchObject({ applied: false, wouldChange: 1 });
    expect(JSON.stringify((await service.store().read())!.studies[0].caseSettings)).toBe(before);
    await expect(invoke('study_region_rename', { studyId: study.id, renames: [{ from: 'Inlet', to: 'Inflow' }], apply: true })).rejects.toThrow(/expectedSettingsRevision/);
    await expect(invoke('study_region_rename', { studyId: study.id, renames: [{ from: 'Inlet', to: 'Inflow' }], apply: true, expectedSettingsRevision: 'stale' })).rejects.toThrow(/changed since/);
    const done = await invoke('study_region_rename', { studyId: study.id, renames: [{ from: 'Inlet', to: 'Inflow' }], apply: true, expectedSettingsRevision: refs.settingsRevision }) as { applied: boolean; changed: number };
    expect(done).toMatchObject({ applied: true, changed: 1 });
    const after = await invoke('study_region_references', { studyId: study.id }) as { report: { lost: number } };
    expect(after.report.lost).toBe(0);
  });

  it('attaches a mesh, imports a terminal run without its process identity, and exports an honest offline review', async () => {
    const root = await temp(), geometry = path.join(root, 'beam.step'), mesh = path.join(root, 'beam.mdpa');
    await fs.writeFile(geometry, 'geometry');
    await fs.writeFile(mesh, 'Begin Nodes\n1 0 0 0\n2 1 0 0\nEnd Nodes\nBegin Elements E\n1 1 2\nEnd Elements\n');
    await fs.writeFile(caseFilePath(mesh), JSON.stringify({ problemtypeId: 'structural' }));
    await fs.writeFile(path.join(root, 'ProjectParameters.json'), '{}');
    await fs.writeFile(path.join(root, 'MainKratos.py'), '# snapshot');
    await fs.writeFile(runFilePath(mesh), JSON.stringify({ version: 1, runId: 'source-run', stem: 'beam', meshFile: mesh,
      status: 'finished', launchMode: 'output', argv: ['/machine/python', 'MainKratos.py'], startedAt: 1,
      endedAt: 2, exitCode: 0, pid: 123456, launchedBy: 'extension' }));
    const qualityCalls: string[] = [];
    const quality = { overallOk: true, elementCount: 1, analyzedCount: 1, elementTypes: ['Line2D2'], metrics: [{ key: 'edgeRatio', min: 1, mean: 1, max: 1, badEntityTotal: 0 }] };
    const service = new WorkflowService({ root: () => root, activeMesh: () => mesh,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined,
      callMcpTool: async (name, args) => {
        expect(name).toBe('mesh__mesh_quality'); qualityCalls.push(String(args.path));
        return { structuredContent: quality };
      } });
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const tool = service.tools().find(t => t.name === `app__${name}`)!;
      return tool.invoke(args);
    };
    const created = await invoke('study_create', { name: 'Cantilever', source: geometry }) as Study;
    await invoke('study_attach_mesh', { studyId: created.id, meshPath: mesh });
    const imported = await invoke('study_import_run', { studyId: created.id }) as Run;
    expect(imported.state).toBe('succeeded');
    expect(imported.directory).toBe(`.kkss/runs/${imported.id}`);
    expect(JSON.stringify(imported)).not.toContain('123456');
    expect(imported.artifacts.some(a => a.role === 'mesh' && a.ownerId === imported.id)).toBe(true);
    const report = await invoke('run_review', { studyId: created.id, runId: imported.id }) as { evidence: { mesh: { nodes?: number; quality?: Json }; preparation?: Evidence['preparation']; convergence: { state: string } } };
    expect(report.evidence.mesh.nodes).toBe(2);
    expect(report.evidence.mesh.quality).toEqual(quality);
    expect(report.evidence.preparation).toMatchObject({ state: 'complete', settingsRevision: expect.any(String) });
    expect(qualityCalls[0]).toBe(path.join(root, imported.directory, 'input', 'beam.mdpa'));
    expect(report.evidence.convergence.state).toBe('unavailable');
    const paths = await invoke('run_review_export', { studyId: created.id, runId: imported.id }) as { jsonFile: string; htmlFile: string };
    const html = await fs.readFile(paths.htmlFile, 'utf8');
    expect(html).toContain('Convergence: unavailable');
    expect(html).toContain('&quot;overallOk&quot;: true');
    expect(html).toContain('ProjectParameters.json');
    expect(JSON.parse(await fs.readFile(paths.jsonFile, 'utf8')).run.state).toBe('succeeded');
    expect((await service.snapshot() as { readiness: Record<string, Record<string, string>> }).readiness[created.id].case).toBe('ready');
  });

  it('evaluates and persists a unit-labelled quantity only for the exact owned result revision', async () => {
    const root = await temp(), resultFile = path.join(root, '.kkss', 'runs', 'run-quantity', 'solve', 'vtk_output', 'result.vtu');
    const geometry = path.join(root, 'beam.step'); await fs.writeFile(geometry, 'geometry');
    await fs.mkdir(path.dirname(resultFile), { recursive: true }); await fs.writeFile(resultFile, '<VTKFile>result</VTKFile>');
    const revision = await fileRevision(resultFile), calls: Record<string, unknown>[] = [];
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined,
      callMcpTool: async (name, args) => {
        expect(name).toBe('mesh__case_evaluate_quantity'); calls.push(args);
        return { structuredContent: {
          version: 1, runId: 'run-quantity', source: { path: resultFile, revision: `sha256:${revision}` },
          evaluation: { field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', region: 'global', time: 0.5, reduction: 'max', unit: 'm' },
          quantity: { field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', region: 'global', time: 0.5, reduction: 'max', unit: 'm', value: 0.004, runId: 'run-quantity' },
        } };
      } });
    const store = service.store(), study: Study = { ...makeStudy(), source: reference(root, geometry, await fileRevision(geometry)), runs: [] };
    const run: Run = { id: 'run-quantity', studyId: study.id, sourceRevision: study.source.revision, meshRevision: 'mesh-rev',
      settings: study.caseSettings, directory: '.kkss/runs/run-quantity', state: 'succeeded', artifacts: [
        { role: 'result', ownerId: 'run-quantity', reference: reference(root, resultFile, revision) },
      ] };
    run.startedAt = 1; run.finishedAt = 2; study.runs.push(run);
    await store.update(p => { p.studies.push(study); p.activeStudyId = study.id; p.activeRunId = run.id; });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(tool => tool.name === `app__${name}`)!.invoke(args);
    const saved = await invoke('run_quantity_evaluate', { studyId: study.id, runId: run.id, field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', reduction: 'max', unit: 'm', time: 0.5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].time).toBe(0.5);
    expect(saved).toMatchObject({ quantity: { value: 0.004, runId: run.id, source: { revision } } });
    const review = await invoke('run_review', { studyId: study.id, runId: run.id }) as { evidence: Evidence };
    expect(review.evidence.quantities).toHaveLength(1);
    expect(review.evidence.findings.some(finding => finding.message.includes('No current scalar quantity'))).toBe(false);
    await fs.writeFile(resultFile, '<VTKFile>replaced</VTKFile>');
    const stale = await invoke('run_review', { studyId: study.id, runId: run.id }) as { evidence: Evidence };
    expect(stale.evidence.quantities).toEqual([]);
    expect(stale.evidence.findings.some(finding => finding.message.includes('older result revision'))).toBe(true);
  });
  it('replays saved quantity definitions on a later run and reports per-definition failures', async () => {
    const root = await temp(), geometry = path.join(root, 'beam.step'); await fs.writeFile(geometry, 'geometry');
    const files: Record<string, string> = {};
    for (const id of ['run-a', 'run-b']) { files[id] = path.join(root, '.kkss', 'runs', id, 'result.vtu'); await fs.mkdir(path.dirname(files[id]), { recursive: true }); await fs.writeFile(files[id], `<VTKFile>${id}</VTKFile>`); }
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined,
      callMcpTool: async (_name, args) => {
        const a = args as Record<string, unknown>;
        if (a.field === 'BAD') throw new Error('no such field');
        return { structuredContent: { version: 1, runId: a.runId, source: { path: a.path, revision: `sha256:${await fileRevision(String(a.path))}` },
          evaluation: { time: a.time }, quantity: { field: a.field, kind: a.kind, component: a.component, region: a.region, time: a.time, reduction: a.reduction, unit: a.unit, value: 1, runId: a.runId } } };
      } });
    const store = service.store(), study: Study = { ...makeStudy(), source: reference(root, geometry, await fileRevision(geometry)), runs: [] };
    const mk = async (id: string): Promise<Run> => ({ id, studyId: study.id, sourceRevision: study.source.revision, meshRevision: 'm', settings: study.caseSettings, directory: `.kkss/runs/${id}`, state: 'succeeded', startedAt: 1, finishedAt: 2,
      artifacts: [{ role: 'result', ownerId: id, reference: reference(root, files[id], await fileRevision(files[id])) }] });
    const a = await mk('run-a'), b = await mk('run-b');
    const q = (field: string) => ({ field, kind: 'Nodal' as const, component: 'magnitude', region: 'global', time: 0.5, reduction: 'max', unit: 'm', value: 2, runId: 'run-a', source: a.artifacts[0].reference });
    a.evidence = { ...(a.evidence ?? {} as Evidence), quantities: [q('DISPLACEMENT'), q('BAD')] } as Evidence;
    study.runs.push(a, b);
    await store.update(p => { p.studies.push(study); });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const out = await invoke('run_quantity_reevaluate', { studyId: study.id, runId: 'run-b' }) as { evaluated: number; failed: number; outcomes: { ok: boolean }[] };
    expect(out).toMatchObject({ evaluated: 1, failed: 1 });
    await expect(invoke('run_quantity_reevaluate', { studyId: study.id, runId: 'run-a' })).rejects.toThrow(/earlier run/);
  });
});

describe('goal-seek iterates', () => {
  it('walks the variant group, keeps missing quantities null and makes goal_seek_next stop', async () => {
    type Iterate = { x: number; y: number | null; state: string };
    const root = await temp(), geometry = path.join(root, 'beam.step'); await fs.writeFile(geometry, 'geometry');
    const resultFile = path.join(root, '.kkss', 'runs', 'run-p', 'result.vtu'); await fs.mkdir(path.dirname(resultFile), { recursive: true }); await fs.writeFile(resultFile, '<VTKFile>p</VTKFile>');
    const service = new WorkflowService({ root: () => root, activeMesh: () => undefined,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
    const store = service.store(), source = reference(root, geometry, await fileRevision(geometry));
    const parent: Study = { ...makeStudy(), source, caseSettings: { load: 1 }, runs: [] };
    const failed = duplicateStudy(parent, 'failed', true, { load: 2 }), missing = duplicateStudy(parent, 'missing', true, { load: 3 });
    const mk = (study: Study, id: string, state: Run['state']): Run => ({ id, studyId: study.id, sourceRevision: source.revision, meshRevision: 'm', settings: study.caseSettings, directory: `.kkss/runs/${id}`, state, startedAt: 1, finishedAt: 2, artifacts: [] });
    const pr = mk(parent, 'run-p', 'succeeded');
    const ref = reference(root, resultFile, await fileRevision(resultFile));
    pr.artifacts.push({ role: 'result', ownerId: pr.id, reference: ref });
    pr.evidence = { quantities: [{ field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', region: 'global', time: 1, reduction: 'max', unit: 'm', value: 0.5, runId: pr.id, source: ref }] } as Evidence;
    parent.runs.push(pr); failed.runs.push(mk(failed, 'run-f', 'failed')); missing.runs.push(mk(missing, 'run-m', 'succeeded'));
    await store.update(p => { p.studies.push(parent, failed, missing); });
    const invoke = async (name: string, args: Record<string, unknown>) => service.tools().find(t => t.name === `app__${name}`)!.invoke(args);
    const q = { parameterPath: 'load', field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', region: 'global', reduction: 'max', unit: 'm' };
    const out = await invoke('goal_seek_iterates', { studyId: failed.id, ...q }) as { start: number | null; iterates: Iterate[] };
    expect(out.start).toBe(2);
    expect(out.iterates).toEqual([{ x: 1, y: 0.5, state: 'succeeded' }, { x: 2, y: null, state: 'failed' }, { x: 3, y: null, state: 'succeeded' }]);
    expect((await invoke('goal_seek_iterates', { studyId: parent.id, ...q, unit: 'cm' }) as { iterates: Iterate[] }).iterates[0].y).toBeNull();
    expect((await invoke('goal_seek_iterates', { studyId: parent.id, ...q, parameterPath: 'nope' }) as { start: number | null }).start).toBeNull();
    const spec = { target: 1, relTolerance: 0.01, lower: 0, upper: 10, maxStep: 5, initialStep: 1, maxSolves: 5 };
    expect(await invoke('goal_seek_next', { ...spec, start: out.start, iterates: out.iterates })).toMatchObject({ kind: 'stopped' });
    expect(await invoke('goal_seek_next', { ...spec, start: 2, iterates: [] })).toEqual({ kind: 'next', x: 2 });
  });
});
