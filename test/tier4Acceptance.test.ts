import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Json, Study, Task } from '../app/main/services/workflows/contracts';
import { WorkflowService } from '../app/main/services/workflows/service';
import { defaultCaseState } from '../mesh/src/problemtype/api';
import { structural } from '../mesh/src/problemtype/builtins/structural';
import { planRevision } from '../app/main/services/workflows/queue';

const repository = path.resolve(__dirname, '..');
const cache = path.join(repository, 'node_modules', '.cache', 'kkss-tier4');
const python = process.env.KKSS_TIER4_PYTHON ?? path.join(cache, 'runtime', 'bin', 'python');
const cadServer = path.join(repository, 'out', 'cad-runtime', 'dist', 'mcp-server.js');
const meshServer = path.join(repository, 'mesh', 'dist', 'mcpServer.js');
const enabled = process.env.KKSS_RUN_TIER4_ACCEPTANCE === '1';
const activeServices: WorkflowService[] = [];
afterAll(() => {
  for (const service of activeServices) clearInterval((service as unknown as { queueTimer?: ReturnType<typeof setInterval> }).queueTimer);
});

function parseToolResult(value: unknown, name: string): Record<string, unknown> {
  const result = value as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
  if (result.isError) throw new Error(name + ': ' + (result.content ?? []).map(row => row.text ?? '').join('\n'));
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) return result.structuredContent as Record<string, unknown>;
  const raw = (result.content ?? []).find(row => row.type === 'text')?.text ?? '{}';
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(name + ' returned no object.');
  return parsed as Record<string, unknown>;
}

async function waitFor(service: WorkflowService, predicate: (tasks: Task[]) => boolean, timeoutMs = 240_000): Promise<Task[]> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await (service as unknown as { persistTerminalQueueRuns(store: ReturnType<WorkflowService['store']>): Promise<void> }).persistTerminalQueueRuns(service.store());
    const queue = await service.tools().find(tool => tool.name === 'app__queue_inspect')!.invoke({});
    const tasks = (queue as { tasks: Task[] }).tasks;
    if (predicate(tasks)) return tasks;
    await (service as unknown as { queue: { tick(): Promise<void> } }).queue.tick();
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  const queue = await service.tools().find(tool => tool.name === 'app__queue_inspect')!.invoke({});
  throw new Error('Queue timed out: ' + JSON.stringify((queue as { tasks: Task[] }).tasks));
}

describe.skipIf(!enabled)('Tier 4 real structural cantilever acceptance', () => {
  it('meshes, solves, reviews and evaluates a cantilever, then resumes an immutable parameter sweep after app restart', async () => {
    expect(await fs.stat(python)).toBeTruthy();
    expect(await fs.stat(cadServer)).toBeTruthy();
    expect(await fs.stat(meshServer)).toBeTruthy();
    const tempRoot = path.join(cache, 'acceptance');
    await fs.mkdir(tempRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(tempRoot, 'cantilever-'));
    const cad = new Client({ name: 'tier4-acceptance-cad', version: '1.0.0' });
    const mesh = new Client({ name: 'tier4-acceptance-mesh', version: '1.0.0' });
    const cadRoot = path.join(repository, 'out', 'cad-runtime');
    await cad.connect(new StdioClientTransport({
      command: process.execPath, args: [cadServer], env: { ...process.env, CAD_PREVIEW_ROOT: cadRoot } as Record<string, string>, stderr: 'pipe',
    }));
    await mesh.connect(new StdioClientTransport({ command: process.execPath, args: [meshServer], stderr: 'pipe' }));
    const rawCall = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> }> => {
      const [server, tool] = name.split('__');
      return await (server === 'cad' ? cad : mesh).callTool({ name: tool, arguments: args }) as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };
    };
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const raw = await rawCall(name, args);
      return parseToolResult(raw, name);
    };
    const state = defaultCaseState(structural.decl);
    state.values.problem.analysisType = 'non_linear';
    state.values.problem.endTime = 1;
    state.values.problem.timeStep = 0.1;
    state.assignments = [
      { conditionId: 'parts', smpPath: 'Solid', values: {} },
      { conditionId: 'displacement', smpPath: 'Support', values: { value: [0, 0, 0], constrained: true } },
      { conditionId: 'surfacePressure', smpPath: 'Load', values: { value: 100_000 } },
    ];
    state.materials = [{ smpPath: 'Solid', lawId: 'linear_elastic_3d', values: {
      DENSITY: 0, YOUNG_MODULUS: 210_000_000_000, POISSON_RATIO: 0.3,
    } }];
    const settings = (): { python: string; env: NodeJS.ProcessEnv; bundledPython?: string; extraEnv?: Record<string, string> } => ({
      python, env: { ...process.env, OMP_NUM_THREADS: '2' }, bundledPython: python, extraEnv: { OMP_NUM_THREADS: '2' },
    });
    const makeService = (): WorkflowService => {
      const service = new WorkflowService({
        root: () => root, activeMesh: () => undefined,
        runtime: { discover: async () => ({ command: python, args: [] }) }, environment: settings,
        open: async () => undefined, changed: () => undefined, callMcpTool: rawCall, toolReady: () => true,
      });
      activeServices.push(service);
      return service;
    };
    const invoke = async (service: WorkflowService, name: string, args: Record<string, unknown>): Promise<unknown> => {
      const target = service.tools().find(tool => tool.name === 'app__' + name);
      if (!target) throw new Error('Missing shared workflow tool ' + name);
      return target.invoke(args);
    };
    let service = makeService();
    try {
      const geometry = path.join(root, 'cantilever.stp');
      await fs.copyFile(path.join(repository, 'cad', 'examples', 'STP', 'block.stp'), geometry);
      const loaded = await call('cad__load_model', { path: geometry });
      const scaled = parseToolResult(await cad.callTool({ name: 'apply_edit_ops', arguments: {
        path: geometry, ops: [{ op: 'scale', targets: ['solid-0'], center: [0, 0, 0], factors: [6, 1, 1] }],
      } }), 'cad__apply_edit_ops');
      expect(scaled.applied).toBe(1);
      await call('cad__set_part', { path: geometry, name: 'Solid', volumes: ['solid-0'] });
      await call('cad__set_part', { path: geometry, name: 'Support', surfaces: ['face-3'] });
      await call('cad__set_part', { path: geometry, name: 'Load', surfaces: ['face-1'] });
      expect(loaded).toBeDefined();

      const study = await invoke(service, 'study_create', { name: 'Structural cantilever', source: geometry }) as Study;
      await invoke(service, 'study_set_settings', { studyId: study.id, meshing: { dimension: 3, sizeMin: 0.8, sizeMax: 0.8 }, caseSettings: state as unknown as Json });
      const capabilities = await invoke(service, 'check_simulation_environment', {}) as {
        manual: { available: boolean; capabilities: { threads: boolean; mpi: boolean } };
        tools: { available: boolean; capabilities: { threads: boolean; mpi: boolean } };
        suggestedThreads?: number;
      };
      expect(capabilities.manual.available).toBe(true);
      expect(capabilities.manual.capabilities.threads).toBe(true);
      expect(capabilities.manual.capabilities.mpi).toBe(false);
      expect(capabilities.tools.available).toBe(true);
      expect(capabilities.tools.capabilities.threads).toBe(false);
      expect(capabilities.tools.capabilities.mpi).toBe(false);
      expect(capabilities.suggestedThreads).toBeGreaterThan(0);
      const preview = await invoke(service, 'queue_plan_preview', { studyId: study.id, reuseMesh: false }) as { previewId: string; runId: string; tasks: Task[] };
      expect(preview.tasks.map(task => task.kind)).toEqual(['mesh', 'generate', 'solve']);
      await invoke(service, 'queue_enqueue', { previewId: preview.previewId });
      const firstPlan = (await service.store().read())!.queue.tasks;
      await invoke(service, 'queue_resume', { planRevision: planRevision(firstPlan) });
      const firstTasks = await waitFor(service, tasks => tasks.filter(task => task.runId === preview.runId && ['mesh', 'generate', 'solve'].includes(task.kind)).every(task => ['succeeded', 'failed', 'cancelled', 'held', 'blocked', 'uncertain'].includes(task.state)));
      expect(firstTasks.filter(task => task.runId === preview.runId).map(task => [task.kind, task.state])).toEqual([
        ['mesh', 'succeeded'], ['generate', 'succeeded'], ['solve', 'succeeded'],
      ]);
      const project = (await service.store().read())!;
      const solvedStudy = project.studies.find(row => row.id === study.id)!;
      const run = solvedStudy.runs.find(row => row.id === preview.runId)!;
      expect(run.state).toBe('succeeded');
      expect(run.artifacts.some(artifact => artifact.role === 'result')).toBe(true);
      const review = await invoke(service, 'run_review', { studyId: study.id, runId: run.id }) as {
        evidence: { preparation?: { state: string; runtime?: unknown }; convergence: { state: string; samples: Array<{ time?: number; residual?: number; criterion?: string }> }; findings: Array<{ message: string }> };
      };
      expect(review.evidence.preparation?.state).toBe('complete');
      expect(review.evidence.convergence.state, JSON.stringify({
        findings: review.evidence.findings,
        samples: review.evidence.convergence.samples.slice(-12),
      })).toBe('converged');
      expect(review.evidence.convergence.samples.some(sample => typeof sample.residual === 'number' && sample.criterion === 'residual_criterion')).toBe(true);
      const exported = await invoke(service, 'run_review_export', { studyId: study.id, runId: run.id }) as { htmlFile: string };
      const html = await fs.readFile(exported.htmlFile, 'utf8');
      expect(html).toContain('Solver-reported residual norm');
      expect(html).toContain('<svg');
      expect(html).not.toMatch(/<script\b|<img[^>]+src=["']https?:/i);

      const result = run.artifacts.find(artifact => artifact.role === 'result' && artifact.ownerId === run.id);
      expect(result).toBeDefined();
      const measured = await invoke(service, 'run_quantity_evaluate', {
        studyId: study.id, runId: run.id, resultPath: path.resolve(root, result!.reference.path),
        field: 'DISPLACEMENT', kind: 'Nodal', component: 'z', region: 'global',
        time: review.evidence.convergence.samples[review.evidence.convergence.samples.length - 1]?.time, reduction: 'maxAbs', unit: 'mm',
      }) as { quantity: { value: number | null; unit: string } };
      expect(measured.quantity.value).not.toBeNull();
      expect(measured.quantity.unit).toBe('mm');
      // Euler–Bernoulli cantilever reference: a first-order tetrahedral mesh is
      // accepted within a documented 25% discretization tolerance.
      const analyticMm = (0.1 * 4 * Math.pow(18, 4)) / (8 * 210_000 * (4 * Math.pow(5, 3) / 12));
      const relativeError = Math.abs(measured.quantity.value! - analyticMm) / analyticMm;
      console.info(`Cantilever max displacement: ${measured.quantity.value} mm; Euler–Bernoulli ${analyticMm} mm; relative error ${(relativeError * 100).toFixed(2)}% (limit 25%).`);
      expect(relativeError).toBeLessThanOrEqual(0.25);

      const duplicate = await invoke(service, 'study_duplicate', { studyId: study.id, name: 'Cantilever duplicate', reuseMesh: true }) as Study;
      expect(duplicate.id).not.toBe(study.id);
      expect(duplicate.mesh).toEqual(solvedStudy.mesh);
      expect(duplicate.runs).toEqual([]);
      expect(duplicate.runs.every(item => !item.receipt && item.state !== 'running')).toBe(true);

      const sweep = await invoke(service, 'queue_parameter_sweep_preview', {
        studyId: study.id, reuseMesh: true, parameterPath: 'values.problem.endTime', values: [10, 1],
      }) as { previewId: string; variants: Array<{ id: string; runId: string; name: string }> };
      expect(sweep.variants).toHaveLength(2);
      await invoke(service, 'queue_enqueue', { previewId: sweep.previewId });
      const waiting = (await service.store().read())!.queue.tasks;
      const movable = waiting.filter(task => task.state === 'waiting').map(task => task.id).reverse();
      let movableIndex = 0;
      const invalidOrder = waiting.map(task => task.state === 'waiting' ? movable[movableIndex++] : task.id);
      await expect(invoke(service, 'queue_reorder', { taskIds: invalidOrder })).rejects.toThrow(/dependency/);
      const revision = planRevision(waiting);
      const firstVariantTasks = waiting.filter(task => task.runId === sweep.variants[0].runId).map(task => task.id);
      await invoke(service, 'queue_resume_row', { taskId: firstVariantTasks[0], planRevision: revision });
      const activeSolve = (await service.store().read())!.queue.tasks.find(task => task.runId === sweep.variants[0].runId && task.kind === 'solve');
      expect(activeSolve?.state).toBe('running');
      const activeJob = activeSolve?.receipt?.jobId;
      expect(activeJob).toBeTruthy();

      clearInterval((service as unknown as { queueTimer?: ReturnType<typeof setInterval> }).queueTimer);
      service = makeService();
      const resumedProject = await invoke(service, 'study_list', {}) as { project: { queue: { paused: boolean; tasks: Task[] } } };
      expect(resumedProject.project.queue.paused).toBe(true);
      const reconciled = resumedProject.project.queue.tasks.find(task => task.runId === sweep.variants[0].runId && task.kind === 'solve');
      expect(reconciled?.receipt?.jobId).toBe(activeJob);
      expect(['running', 'succeeded']).toContain(reconciled?.state);
      const currentTasks = resumedProject.project.queue.tasks;
      await invoke(service, 'queue_resume', { planRevision: planRevision(currentTasks) });
      const terminalTasks = await waitFor(service, tasks => tasks.filter(task => sweep.variants.some(row => row.runId === task.runId)).every(task => ['succeeded', 'failed', 'cancelled', 'held', 'blocked', 'uncertain'].includes(task.state)));
      expect(terminalTasks.filter(task => sweep.variants.some(row => row.runId === task.runId)).every(task => task.state === 'succeeded')).toBe(true);
      const finalProject = (await service.store().read())!;
      const rows = sweep.variants.map(row => finalProject.studies.find(candidate => candidate.id === row.id)!);
      expect(rows.map(row => row.runs[0]?.id)).toEqual(sweep.variants.map(row => row.runId));
      expect(new Set(rows.flatMap(row => row.runs.map(item => item.directory))).size).toBe(2);
      const commonTimeResult = path.join(root, run.directory, 'solve', 'vtk_output', 'Structure_0_5.vtk');
      await invoke(service, 'run_quantity_evaluate', {
        studyId: study.id, runId: run.id, resultPath: commonTimeResult, field: 'DISPLACEMENT',
        kind: 'Nodal', component: 'z', region: 'global', time: 0.5, reduction: 'maxAbs', unit: 'mm',
      });
      for (const row of rows) {
        const rowRun = row.runs.find(item => item.id === sweep.variants.find(variant => variant.id === row.id)!.runId)!;
        await invoke(service, 'run_quantity_evaluate', {
          studyId: row.id, runId: rowRun.id,
          resultPath: path.join(root, rowRun.directory, 'solve', 'vtk_output', 'Structure_0_5.vtk'),
          field: 'DISPLACEMENT', kind: 'Nodal', component: 'z', region: 'global', time: 0.5, reduction: 'maxAbs', unit: 'mm',
        });
      }
      const comparison = await invoke(service, 'variants_compare', { studyId: sweep.variants[0].id }) as {
        rows: Array<{ studyId: string; state: string }>;
        quantities: Array<{ definition: { time: number }; compatible: boolean; values: Array<{ value: number | null }> }>;
      };
      expect(comparison.rows).toHaveLength(4);
      expect(comparison.rows.some(row => row.state === 'missing')).toBe(true);
      const atHalf = comparison.quantities.find(quantity => quantity.definition.time === 0.5)!;
      expect(atHalf.compatible).toBe(true);
      expect(atHalf.values.filter(value => typeof value.value === 'number')).toHaveLength(3);
      expect(atHalf.values.some(value => value.value === null)).toBe(true);
      const comparisonExport = await invoke(service, 'variants_compare_export', { studyId: sweep.variants[0].id }) as { htmlFile: string };
      const comparisonHtml = await fs.readFile(comparisonExport.htmlFile, 'utf8');
      expect(comparisonHtml).toContain('t=0.5');
      expect(comparisonHtml).not.toMatch(/<script\b|<(?:img|iframe)[^>]+src=["']https?:/i);
    } finally {
      clearInterval((service as unknown as { queueTimer?: ReturnType<typeof setInterval> }).queueTimer);
      await cad.close();
      await mesh.close();
      if (process.env.KEEP_TIER4_ACCEPTANCE !== '1') await fs.rm(root, { recursive: true, force: true });
    }
  }, 900_000);
});
