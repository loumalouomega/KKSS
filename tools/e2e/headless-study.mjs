import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { electronPath, root } from '../e2eShared.mjs';

// Roadmap item 19: `kkss --headless study run` resumes an already-persisted plan
// without a window, prints a JSON report and exits with a code that says what happened.
// The solver is not needed: the plan below is refused by the queue's own validation
// (its geometry is missing), which still drives the real service, queue and MCP start-up.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-headless-'));
const profile = path.join(dir, 'profile');
const project = path.join(dir, 'project');
fs.mkdirSync(path.join(project, '.kkss'), { recursive: true });
const ref = (p) => ({ kind: 'project', path: p, revision: 'r0' });
const task = { id: 't1', studyId: 's1', runId: 'r1', kind: 'solve', state: 'waiting', dependencies: [], args: { mesh: 'gone/mesh.mdpa', runDirectory: '.kkss/runs/r1', runtimeRevision: 'x' }, inputRevision: 'x', requiredArtifacts: [] };
const write = (tasks) => fs.writeFileSync(path.join(project, '.kkss/project.json'), JSON.stringify({
  version: 1, id: 'p1', revision: 1, activeStudyId: 's1',
  studies: [{ id: 's1', name: 'Gone', source: ref('missing.stp'), meshing: {}, caseSettings: null, runs: [{ id: 'r1', studyId: 's1', sourceRevision: 'r0', meshRevision: 'r0', settings: {}, directory: '.kkss/runs/r1', state: 'waiting', artifacts: [] }] }],
  queue: { paused: true, tasks },
}));
const run = (args, extra = {}) => {
  const r = spawnSync(electronPath, [path.join(root, 'out/main.js'), '--no-sandbox', '--enable-unsafe-swiftshader', `--user-data-dir=${profile}`, '--headless', ...args], {
    cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ...extra },
  });
  let report; try { report = JSON.parse(r.stdout); } catch { /* usage errors print text to stderr */ }
  return { code: r.status, report, stderr: r.stderr };
};
try {
  // Not a KKSS project.
  let r = run(['study', 'run', dir]);
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.report.outcome, 'error');
  // Bad usage prints the reason and exits 3.
  r = run(['study', 'run', project, '--timeout', '0']);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /--timeout must be a positive number/);
  // No persisted plan: nothing is created.
  write([]);
  r = run(['study', 'run', project]);
  assert.equal(r.code, 4);
  assert.equal(r.report.outcome, 'refused');
  assert.equal(r.report.started, false);
  // A plan revision that is not the persisted one starts nothing.
  write([task]);
  r = run(['study', 'run', project, '--plan', 'not-the-revision']);
  assert.equal(r.code, 4);
  assert.match(r.report.message, /not the persisted|nothing was started/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.kkss/project.json'), 'utf8')).queue.tasks[0].state, 'waiting');
  // The persisted plan resumes; the queue refuses the missing geometry, so the run fails (exit 1) with the reason.
  r = run(['study', 'run', project, '--no-review', '--timeout', '120', '--output', path.join(dir, 'report.json')]);
  assert.equal(r.code, 1, `${r.stderr}\n${JSON.stringify(r.report)}`);
  assert.equal(r.report.outcome, 'failed');
  assert.equal(r.report.started, true);
  assert.equal(r.report.tasks.length, 1);
  assert.notEqual(r.report.tasks[0].state, 'succeeded');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')), r.report);
  // It never touched the profile of a GUI session: no settings were written there.
  assert.equal(fs.existsSync(path.join(profile, 'state.json')), false, 'headless runs write no state.json');
  console.log('PASS headless-study');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
