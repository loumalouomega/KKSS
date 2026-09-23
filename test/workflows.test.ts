import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Receipt, Run, Study, Task } from '../app/main/services/workflows/contracts';
import { checkEnvironment, PROBE_SCRIPT, type Probe } from '../app/main/services/workflows/environment';
import { duplicateStudy, fileRevision, fingerprint, previewVariants, ProjectStore, readiness, reference, resolveReference } from '../app/main/services/workflows/project';
import { ExecutionQueue, planRevision } from '../app/main/services/workflows/queue';
import { buildEvidence, escapeHtml, mdpaCounts, reviewHtml } from '../app/main/services/workflows/review';
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

describe('shared workflow tools', () => {
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
    const service = new WorkflowService({ root: () => root, activeMesh: () => mesh,
      runtime: { discover: async () => ({ command: 'uvx', args: [] }) }, environment: () => ({ python: 'python', env: {} }),
      open: async () => undefined, changed: () => undefined });
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
    const report = await invoke('run_review', { studyId: created.id, runId: imported.id }) as { evidence: { mesh: { nodes?: number }; convergence: { state: string } } };
    expect(report.evidence.mesh.nodes).toBe(2);
    expect(report.evidence.convergence.state).toBe('unavailable');
    const paths = await invoke('run_review_export', { studyId: created.id, runId: imported.id }) as { jsonFile: string; htmlFile: string };
    expect(await fs.readFile(paths.htmlFile, 'utf8')).toContain('Convergence: unavailable');
    expect(JSON.parse(await fs.readFile(paths.jsonFile, 'utf8')).run.state).toBe('succeeded');
    expect((await service.snapshot() as { readiness: Record<string, Record<string, string>> }).readiness[created.id].case).toBe('ready');
  });
});
