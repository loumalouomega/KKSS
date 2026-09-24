/** Fresh processes and fresh profiles; OS filesystem caches are not flushed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { launchApp, closeApp, softwareGL, root, until } from '../e2eShared.mjs';
import { median, regressions, sample, exitCodeForRegressions } from './core.mjs';
const baselinePath = path.join(root, 'tools/perf/baseline.json');
const fixtures = { geometry: 'cad/examples/STP/bull.stp', model: 'mesh/src/test/fixtures/regions/UUea.inp' };
const samples = { launch: [], geometry: [], model: [] };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
for (const kind of Object.keys(samples)) {
  for (let i = 0; i < 5; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-perf-'));
    const trace = path.join(dir, 'trace.jsonl');
    const file = fixtures[kind] && path.join(dir, path.basename(fixtures[kind]));
    if (file) fs.copyFileSync(path.join(root, fixtures[kind]), file);
    const profile = path.join(dir, 'profile');
    fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'state.json'), JSON.stringify({ uiTheme: 'dark', showWhatsNew: false }));
    let app;
    try {
      const started = performance.timeOrigin + performance.now();
      ({ app } = await launchApp(file, { userDataDir: profile, extraArgs: softwareGL, env: { KKSS_PERF_TRACE: trace, KKSS_NO_RESTORE: '1' }, timeout: 150_000 }));
      const read = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      await until(() => { const events = read(); if (events.some(e => e.event === 'failure')) throw new Error('Renderer failed: ' + JSON.stringify(events)); return events.some(e => kind === 'launch' ? e.event === 'interactive' : e.event === 'open' && e.file === file && e.type === kind); }, `${kind} timing marker`, 150_000);
      const ms = sample(read(), kind, file, started);
      samples[kind].push(ms);
      console.log(`${kind} ${i + 1}/5: ${ms.toFixed(1)} ms`);
    } finally { if (app) await closeApp(app); fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
const medians = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values)]));
const report = {
  schema: 1, measuredAt: new Date().toISOString(), method: 'five fresh processes/profiles; no WASM warmup; filesystem cache uncontrolled',
  revisions: { app: git('rev-parse', 'HEAD'), cad: git('-C', 'cad', 'rev-parse', 'HEAD'), mesh: git('-C', 'mesh', 'rev-parse', 'HEAD'), dirty: !!git('status', '--porcelain') },
  runtime: { node: process.version, electron: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'))).version },
  machine: { platform: process.platform, release: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, cores: os.cpus().length, memory: os.totalmem(), rendering: softwareGL },
  fixtures: Object.fromEntries(Object.entries(fixtures).map(([key, file]) => [key, { file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }])),
  samples, medians,
};
fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test-results/perf.json'), JSON.stringify(report, null, 2) + '\n');
console.table(medians);
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n');
  console.log('Baseline updated; review machine metadata and samples before committing.');
} else {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const flagged = regressions(medians, baseline.medians);
  for (const key of flagged) console.warn(`Performance regression: ${key} exceeds 3× baseline`);
  process.exitCode = exitCodeForRegressions(flagged, process.env.PERF_STRICT === '1');
}
