// Reproducible solver acceptance + thread scaling, using published tutorial inputs.
// KKSS_TUTORIAL_PYTHON=/path/python node tools/workflows/benchmark.mjs [report.json]
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { build } from 'esbuild';
import { cases } from '../tutorials/cases.mjs';
const root = process.cwd(), exec = promisify(execFile);
const python = process.env.KKSS_TUTORIAL_PYTHON;
if (!python) throw new Error('Set KKSS_TUTORIAL_PYTHON to a verified Kratos interpreter.');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkss-tier2-benchmark-'));
const entry = path.join(dir, 'contracts.mjs');
await build({ stdin: { contents: `export * from './mesh/src/problemtype/mainKratosTemplate'; export * from './mesh/src/problemtype/threadControl';`, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', outfile: entry });
const { monitoredMainScript, solverArgv, CONVERGENCE_ADAPTERS } = await import(pathToFileURL(entry).href);
const report = { version: 1, date: new Date().toISOString(), cpu: os.cpus()[0]?.model, availableCpus: os.availableParallelism(),
  responsiveness: 'Node coordinator event-loop delay during external solves; not a GUI frame-rate measurement.', samples: [] };
const output = path.resolve(process.argv[2] ?? path.join(dir, 'benchmark.json'));
await fs.mkdir(path.dirname(output), { recursive: true });
for (const c of cases) for (const threads of [...new Set([1, 2, 4, os.availableParallelism()])]) for (let repetition = 1; repetition <= 3; repetition++) {
  const cwd = path.join(dir, `${c.id}-${threads}-${repetition}`);
  await fs.cp(path.join(root, 'doc/public/examples/tutorials', c.id), cwd, { recursive: true });
  await fs.rm(path.join(cwd, 'vtk_output'), { recursive: true, force: true });
  await fs.writeFile(path.join(cwd, 'MainKratos.py'), monitoredMainScript(c.problemtype));
  const [command, ...args] = solverArgv(python, 'MainKratos.py', threads);
  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  const started = performance.now();
  try {
    const run = await exec(command, args, { cwd, timeout: 180000, maxBuffer: 32 * 1024 ** 2, env: { ...process.env, OMP_NUM_THREADS: String(threads) } });
    const elapsedMs = performance.now() - started;
    const verification = JSON.parse((await exec(python, [path.join(root, 'tools/tutorials/verify.py'), c.id, cwd])).stdout);
    const resources = JSON.parse(await fs.readFile(path.join(cwd, 'kkss-resources.json'), 'utf8'));
    const monitor = (await fs.readFile(path.join(cwd, 'kkss-convergence-v2.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    if (resources.effectiveThreads !== threads || monitor.at(-1)?.completed !== true || monitor.some(r => r.adapter !== CONVERGENCE_ADAPTERS[c.problemtype])) throw new Error('Invalid resource or convergence receipt');
    report.samples.push({ case: c.id, threads, repetition, elapsedMs, coordinatorDelayP99Ms: lag.percentile(99) / 1e6,
      verification: { ...verification, threads }, resources, monitor: { adapter: monitor[0].adapter, steps: monitor.length - 1,
        convergedSteps: monitor.filter(r => r.converged === true).length, unknownSteps: monitor.filter(r => r.event === 'step' && r.converged === null).length,
        residualSteps: monitor.filter(r => r.residual !== undefined).length } });
    await fs.writeFile(path.join(cwd, 'solver.log'), run.stdout + run.stderr);
    console.log(`${c.id}: ${threads} threads #${repetition}: ${elapsedMs.toFixed(0)} ms`);
  } catch (error) {
    report.samples.push({ case: c.id, threads, repetition, error: String(error), stderr: error.stderr });
    console.error(`${c.id}: ${threads} threads #${repetition}: ${error}`);
    process.exitCode = 1;
  } finally { lag.disable(); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
}
const median = values => { const ordered = [...values].sort((a, b) => a - b); return ordered.length ? ordered[Math.floor(ordered.length / 2)] : null; };
report.summary = [...new Set(report.samples.filter(sample => Number.isFinite(sample.elapsedMs)).map(sample => `${sample.case}:${sample.threads}`))].sort().map(key => {
  const [caseName, threadText] = key.split(':');
  const rows = report.samples.filter(sample => sample.case === caseName && sample.threads === Number(threadText) && Number.isFinite(sample.elapsedMs));
  return { case: caseName, threads: Number(threadText), repetitions: rows.length,
    medianElapsedMs: median(rows.map(row => row.elapsedMs)), minElapsedMs: Math.min(...rows.map(row => row.elapsedMs)),
    maxElapsedMs: Math.max(...rows.map(row => row.elapsedMs)), medianCoordinatorDelayP99Ms: median(rows.map(row => row.coordinatorDelayP99Ms)) };
});
await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Report: ${output}\nRun artifacts: ${dir}`);
