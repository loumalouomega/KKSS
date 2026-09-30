import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveThreads } from '../app/main/services/workflows/environment';
import { canDispatch, ExecutionQueue, planRevision } from '../app/main/services/workflows/queue';
import { ProjectStore } from '../app/main/services/workflows/project';
import { richardson, meshSensitivity, type Refinement } from '../app/main/services/workflows/refinement';
import { buildEvidence, reviewHtml, makeReview } from '../app/main/services/workflows/review';
import { compareVariants, comparisonHtml } from '../app/main/services/workflows/comparison';
import { discoverOutputs } from '../mesh/src/problemtype/outputDiscovery';
import { solverArgv, THREAD_BOOTSTRAP } from '../mesh/src/problemtype/threadControl';
import { CONVERGENCE_ADAPTERS } from '../mesh/src/problemtype/mainKratosTemplate';
import type { Evidence, Run, Study, Task } from '../app/main/services/workflows/contracts';
const roots: string[] = [];
async function temp() { const p = await fs.mkdtemp(path.join(os.tmpdir(), 'tier2-')); roots.push(p); return p; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
const study: Study = { id: 's', name: '<script>alert(1)</script>', source: { kind: 'project', path: 'a.step', revision: 'source' }, meshing: {}, caseSettings: { problemtypeId: 'structural' }, runs: [] };
const run: Run = { id: 'r', studyId: 's', sourceRevision: 'source', meshRevision: 'mesh', settings: study.caseSettings, directory: 'run', state: 'succeeded', artifacts: [] };
const task = (id: string, kind: Task['kind'], threads?: number): Task => ({ id, kind, studyId: 's', runId: id, state: 'waiting', args: {}, inputRevision: 'i', dependencies: [], requiredArtifacts: [], ...(threads ? { resources: { threads, verified: true } } : {}) });
describe('thread application and resources', () => {
  it('resolves Auto and rejects invalid/oversubscribed allocations', () => {
    expect(resolveThreads(0, 16)).toBe(15); expect(resolveThreads(0, 1)).toBe(1);
    for (const n of [-1, 1.2, NaN, 17]) expect(() => resolveThreads(n, 16)).toThrow();
    expect(solverArgv('python', 'with spaces.py')).toEqual(['python', 'with spaces.py']);
    expect(() => solverArgv('python', 'script.py', 0)).toThrow();
  });
  it('bootstraps Kratos threads before running the script and writes an effective-count receipt', () => {
    expect(THREAD_BOOTSTRAP.indexOf('SetNumThreads(n)')).toBeLessThan(THREAD_BOOTSTRAP.indexOf("runpy.run_path(script"));
    expect(THREAD_BOOTSTRAP).toContain('GetNumThreads()');
    expect(THREAD_BOOTSTRAP).toContain("os.replace('kkss-resources.json.tmp','kkss-resources.json')");
    expect(THREAD_BOOTSTRAP).toContain('if effective != n: raise RuntimeError');
    const args = solverArgv('python', 'a file.py', 3);
    expect(args.slice(1)).toEqual(['-c', THREAD_BOOTSTRAP, '3', 'a file.py']);
  });
  it('allows only a bounded solve/preparation pair; uncertain and legacy tasks reserve resources', () => {
    const solve = { ...task('solve', 'solve', 3), state: 'uncertain' as const };
    expect(canDispatch(task('mesh', 'mesh', 1), [solve], 4)).toBe(true);
    expect(canDispatch(task('other', 'solve', 1), [solve], 4)).toBe(false);
    expect(canDispatch(task('mesh', 'mesh', 2), [solve], 4)).toBe(false);
    expect(canDispatch(task('mesh', 'mesh', 1), [task('legacy', 'solve')], 4)).toBe(false);
    expect(planRevision([task('s', 'solve', 2)])).not.toBe(planRevision([task('s', 'solve', 3)]));
  });
  it('persists two independent dispatches, then reconciles restart without redispatch', async () => {
    const store = new ProjectStore(await temp()); await store.update(() => {});
    const sent: string[] = [];
    const queue = new ExecutionQueue({ validate: async () => [], dispatch: async t => {
      expect((await store.read())!.queue.tasks.find(r => r.id === t.id)?.state).toBe('dispatching');
      sent.push(t.id); return { version: 1, requestId: t.id, ownerId: 's', state: 'running', artifacts: [] };
    }, lookup: async () => undefined, cancel: async t => ({ version: 1, requestId: t.id, ownerId: 's', state: 'cancelled', artifacts: [] }) }, () => 4);
    await queue.enqueue(store, [task('solve', 'solve', 3), task('mesh', 'mesh', 1), task('other', 'solve', 1)], [study]);
    await queue.resume(store, planRevision((await store.read())!.queue.tasks));
    expect(sent).toEqual(['solve', 'mesh']);
    await queue.tick();
    expect((await store.read())!.queue.tasks.map(t => t.state)).toEqual(['uncertain', 'uncertain', 'waiting']);
    expect(sent).toHaveLength(2);
    await queue.cancel(store, 'mesh'); await queue.tick(); expect(sent).toHaveLength(2);
  });
  it('shares solve and preparation reservations across registered projects', async () => {
    const first = new ProjectStore(await temp()), second = new ProjectStore(await temp());
    const sent: string[] = [];
    const queue = new ExecutionQueue({ validate: async () => [], dispatch: async t => {
      sent.push(t.id); return { version: 1, requestId: t.id, ownerId: t.studyId, state: 'running', artifacts: [] };
    }, lookup: async () => undefined, cancel: async t => ({ version: 1, requestId: t.id, ownerId: t.studyId, state: 'cancelled', artifacts: [] }) }, () => 4);
    await queue.enqueue(first, [task('global-solve', 'solve', 3)], [study]);
    await queue.resume(first, planRevision((await first.read())!.queue.tasks));
    const otherStudy = { ...study, id: 'other', name: 'Other project' };
    await queue.enqueue(second, [{ ...task('global-mesh', 'mesh', 1), studyId: otherStudy.id }], [otherStudy]);
    await queue.resume(second, planRevision((await second.read())!.queue.tasks));
    expect(sent).toEqual(['global-solve', 'global-mesh']);
    expect((await first.read())!.queue.tasks[0].state).toBe('uncertain');
    expect((await second.read())!.queue.tasks[0].state).toBe('running');
  });
});
describe('outputs and evidence', () => {
  it('discovers configured paths, XDMF companions and GiD outputs without assuming vtk_output', async () => {
    const root = await temp(); await fs.mkdir(path.join(root, 'results'));
    await fs.writeFile(path.join(root, 'ProjectParameters.json'), JSON.stringify({ output_processes: { x: [
      { python_module: 'vtk_output_process', Parameters: { output_path: 'results' } },
      { python_module: 'single_mesh_temporal_output_process', kratos_module: 'KratosMultiphysics.HDF5Application', Parameters: { file_settings: { file_name: 'results/model-<time>.h5' } } },
      { python_module: 'gid_output_process', Parameters: { output_name: 'results/model' } },
    ] } }));
    await fs.writeFile(path.join(root, 'results/model-1.xdmf'), '<DataItem Format="HDF">model-1.h5:/data</DataItem>');
    await fs.writeFile(path.join(root, 'results/model-1.h5'), 'data');
    await fs.writeFile(path.join(root, 'results/model.post.res'), 'result');
    await fs.writeFile(path.join(root, 'results/model.post.msh'), 'mesh');
    await fs.writeFile(path.join(root, 'results/frame_2.vtk'), 'vtk');
    const outputs = discoverOutputs(root);
    expect(outputs.results.map(p => path.basename(p))).toEqual(expect.arrayContaining(['model-1.xdmf', 'model.post.res', 'frame_2.vtk']));
    expect(outputs.companions.map(p => path.basename(p))).toContain('model-1.h5');
    expect(outputs.unsafe).toEqual([]);
    await fs.unlink(path.join(root, 'results/model-1.h5'));
    expect(discoverOutputs(root).missing).toContain(path.join(root, 'results/model-1.h5'));
  });
  it('rejects external output destinations and diagnoses unknown processes', async () => {
    const root = await temp();
    await fs.writeFile(path.join(root, 'ProjectParameters.json'), JSON.stringify({ output_processes: { x: [{ python_module: 'vtk_output_process', Parameters: { output_path: '../outside' } }, { python_module: 'custom' }] } }));
    expect(discoverOutputs(root).unsafe).toEqual(['../outside']);
    expect(discoverOutputs(root).findings.join(' ')).toContain('custom');
    await fs.mkdir(path.join(root, 'inside'));
    await fs.writeFile(path.join(root, 'ProjectParameters.json'), JSON.stringify({ output_processes: { x: [{ python_module: 'vtk_output_process', Parameters: { output_path: path.join(root, 'inside') } }] } }));
    expect(discoverOutputs(root).unsafe).toEqual([]);
  });
  it.each(Object.entries(CONVERGENCE_ADAPTERS))('validates %s monitor identity, completion and missing criteria', (problemtypeId, adapter) => {
    const row = { adapter, version: 2, event: 'step', iteration: 1, time: 1, converged: true };
    const end = { adapter, version: 2, event: 'end', completed: true };
    const r = { ...run, settings: { problemtypeId } };
    const text = [row, end].map(value => JSON.stringify(value)).join('\n');
    expect(buildEvidence(r, undefined, text).convergence.state).toBe('converged');
    expect(buildEvidence(r, undefined, JSON.stringify(row)).convergence.state).toBe('unavailable');
    expect(buildEvidence(r, undefined, text + '\n{').convergence.state).toBe('unavailable');
    expect(buildEvidence(r, undefined, [ { ...row, converged: null }, end ].map(value => JSON.stringify(value)).join('\n')).convergence.state).toBe('unavailable');
    expect(buildEvidence(r, undefined, text.replaceAll(adapter, 'wrong')).convergence.state).toBe('unavailable');
  });
  it('uses normalized non-MDPA counts and exports escaped tables with JSON twins', () => {
    const review = makeReview(1, study, run, undefined, undefined, [], 0, { meshCounts: { nodes: 10, elements: 4, conditions: 2 } });
    expect(review.evidence.mesh.nodes).toBe(10);
    const html = reviewHtml(review);
    expect(html).toContain('<h2>Provenance</h2>'); expect(html).toContain('report-data');
    expect(html).not.toContain('<script>alert(1)</script>'); expect(html).not.toMatch(/src=["']https?:/);
    expect(comparisonHtml(compareVariants(study, [{ study, run }]))).toContain('report-data');
    expect(buildEvidence({ ...run, outputFindings: ['Configured output was not created.'] }).findings.map(f => f.message)).toContain('Configured output was not created.');
  });
});
describe('Richardson/GCI', () => {
  it('recovers a known order and limit for unequal refinement ratios', () => {
    const h = [0.1, 0.2, 0.6]; const f = h.map(x => 10 + 3 * x ** 2);
    const result = richardson(h, f)!;
    expect(result.observedOrder).toBeCloseTo(2, 9); expect(result.extrapolatedValue).toBeCloseTo(10, 9);
    expect(result.gciPercent).toBeGreaterThan(0);
    expect(richardson(h, [1, 2, 1])).toBeUndefined(); expect(richardson(h, [1, 1, 1])).toBeUndefined();
    expect(richardson(h, [0, 0.03, 0.35])?.gciPercent).toBeNull();
  });
  it('requires justified adaptive sizing and withholds numbers for incompatible or inconsistent sequences', () => {
    const metadata: Refinement = { meshRevision: '', lengthUnit: 'm', dimension: 2, method: 'adaptive', sizingDefinition: 'ROI mean edge length', justification: 'same refinement region', comparable: true, asymptotic: true };
    const rows = [0.1, 0.2, 0.4, 0.8].map((h, i) => ({ studyId: String(i), run: { ...run, id: String(i), meshRevision: String(i), refinement: { ...metadata, meshRevision: String(i), characteristicSize: h } }, value: 5 + h ** 2, evidence: { mesh: { nodes: 10, elements: 4 }, convergence: { state: 'converged' } } as Evidence }));
    expect(meshSensitivity(rows, true).triples[0].observedOrder).toBeCloseTo(2);
    expect(meshSensitivity(rows, false).unavailableReasons.length).toBeGreaterThan(0);
    rows[3].value = 30;
    const invalid = meshSensitivity(rows, true); expect(invalid.unavailableReasons.join(' ')).toContain('10%'); expect(invalid.triples[0].observedOrder).toBeNull();
    rows[0].run.refinement.asymptotic = false;
    expect(meshSensitivity(rows.slice(0, 3), true).unavailableReasons.length).toBeGreaterThan(0);
  });
});
