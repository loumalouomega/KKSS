import { afterEach, describe, expect, it } from 'vitest';
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
      ]})}`;
    };
    const report = await checkEnvironment({ python: '/manual/python', env: {}, directory: root,
      applications: ['KratosMultiphysics.StructuralMechanicsApplication'], requirementsComplete: true,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, run: probe });
    expect(report.manual.available).toBe(true);
    expect(report.tools.available).toBe(true);
    expect(report.manual.executable).toBe('/python');
    expect(report.writable).toBe(true);
    expect(report.cpuCount).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe('-c');
    expect(calls[1]).toContain('--offline');
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
    expect(report.writable).toBe(false);
    expect(report.directoryReason).toMatch(/writable run directory/);
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
    const copied = await invoke('study_copy_source_into_project', { studyId: study.id }) as { source: { kind: string; path: string } };
    expect(copied.source.kind).toBe('project');
    expect(await fs.readFile(replacement, 'utf8')).toBe('replacement');
    current = (await service.store().read())!.studies[0];
    expect((await readiness(root, current)).mesh).toBe('stale');
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
          evaluation: { field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', region: 'global', time: 0, reduction: 'max', unit: 'm' },
          quantity: { field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', region: 'global', time: 0, reduction: 'max', unit: 'm', value: 0.004, runId: 'run-quantity' },
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
    const saved = await invoke('run_quantity_evaluate', { studyId: study.id, runId: run.id, field: 'DISPLACEMENT', kind: 'Nodal', component: 'magnitude', reduction: 'max', unit: 'm' });
    expect(calls).toHaveLength(1);
    expect(saved).toMatchObject({ quantity: { value: 0.004, runId: run.id, source: { revision } } });
    const review = await invoke('run_review', { studyId: study.id, runId: run.id }) as { evidence: Evidence };
    expect(review.evidence.quantities).toHaveLength(1);
    expect(review.evidence.findings.some(finding => finding.message.includes('No current scalar quantity'))).toBe(false);
    await fs.writeFile(resultFile, '<VTKFile>replaced</VTKFile>');
    const stale = await invoke('run_review', { studyId: study.id, runId: run.id }) as { evidence: Evidence };
    expect(stale.evidence.quantities).toEqual([]);
    expect(stale.evidence.findings.some(finding => finding.message.includes('older result revision'))).toBe(true);
  });
});
