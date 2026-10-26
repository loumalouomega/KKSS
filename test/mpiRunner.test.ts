import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MpiRunner, runLocalSh } from '../app/main/services/workflows/mpiRunner';
import type { Task } from '../app/main/services/workflows/contracts';

const task = { id: 't1', studyId: 's1', runId: 'r1', kind: 'solve' } as unknown as Task;
const PP = JSON.stringify({ problem_data: { parallel_type: 'OpenMP' }, solver_settings: { solver_type: 'Static' } });
let run: string, input: string, local: string, bin: string;
const wait = async (f: () => Promise<boolean>) => { for (let i = 0; i < 80; i++) { if (await f()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timeout'); };
const mk = (argv: string[], ranks = 3, exec = runLocalSh) =>
  new MpiRunner('', exec, () => ({ inputDir: input, remoteDir: path.join(run, 'r'), argv, localDir: local, root: local,
    env: { PATH: `${bin}:${process.env.PATH}`, ...(process.env.SHORT ? { SHORT: process.env.SHORT } : {}) }, intent: { ranks, threadsPerRank: 1, launcher: 'mpirun' } }), ms => new Promise(r => setTimeout(r, ms)));

beforeEach(() => {
  run = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-mr-run-'));
  local = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-mr-local-'));
  input = fs.mkdtempSync(path.join(os.tmpdir(), 'kkss-mr-in-'));
  bin = path.join(run, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(input, 'ProjectParameters.json'), PP);
  // Starts the ranks concurrently, Open MPI style, and waits for them all; one failing rank fails the launch.
  fs.writeFileSync(path.join(bin, 'mpirun'), '#!/bin/sh\nn=$2; shift 2\n[ -n "$SHORT" ] && n=$((n-SHORT))\ni=0; while [ $i -lt $n ]; do OMPI_COMM_WORLD_RANK=$i "$@" & pids="$pids $!"; i=$((i+1)); done\nrc=0; for p in $pids; do wait $p || rc=$?; done; exit $rc\n', { mode: 0o755 });
});

describe('MpiRunner', () => {
  it('uploads a distributed ProjectParameters, runs every rank and reports success without convergence', async () => {
    const r = mk(['sh', '-c', 'grep -o MPI ProjectParameters.json; echo rank']);
    expect((await r.dispatch(task, {} as never)).state).toBe('running');
    await wait(async () => (await r.lookup(task, {} as never))?.state === 'succeeded');
    const receipt = (await r.lookup(task, {} as never))!;
    expect(receipt.message).toMatch(/convergence is not established/);
    expect(receipt.resources).toEqual({ requestedThreads: 3, effectiveThreads: 3 });
    expect(fs.readFileSync(path.join(run, 'r/stdout.log'), 'utf8').match(/MPI/g)).toHaveLength(3);
    expect(fs.readFileSync(path.join(input, 'ProjectParameters.json'), 'utf8')).toBe(PP); // source untouched
    expect(receipt.artifacts.some(a => a.role === 'log')).toBe(true);
  });
  it('reports a failing rank as failed', async () => {
    const r = mk(['sh', '-c', 'exit 4']);
    await r.dispatch(task, {} as never);
    await wait(async () => (await r.lookup(task, {} as never))?.state === 'failed');
  });
  it('reads uncertain, never succeeded, when fewer ranks started than requested', async () => {
    const r = mk(['sh', '-c', 'true']);
    const prior = process.env.SHORT; process.env.SHORT = '1';
    try {
      await r.dispatch(task, {} as never);
      // A launcher that has exited but not yet written its final receipt also reads uncertain
      // (different message), so wait for the rank-count message rather than the state alone.
      await wait(async () => /Requested 3 ranks but 2/.test((await r.lookup(task, {} as never))?.message ?? ''));
    } finally { if (prior === undefined) delete process.env.SHORT; else process.env.SHORT = prior; }
    expect((await r.lookup(task, {} as never))?.state).toBe('uncertain');
  });
  it('flags a live launcher whose rank has died as uncertain', async () => {
    const r = mk(['sh', '-c', 'sleep 30']);
    await r.dispatch(task, {} as never);
    const ranks = path.join(run, 'r/ranks');
    await wait(async () => fs.existsSync(ranks) && fs.readdirSync(ranks).length === 3);
    expect((await r.lookup(task, {} as never))?.state).toBe('running');
    process.kill(Number(fs.readFileSync(path.join(ranks, '1.pid'), 'utf8')), 'SIGKILL');
    await wait(async () => (await r.lookup(task, {} as never))?.state === 'uncertain');
    expect((await r.lookup(task, {} as never))?.message).toMatch(/1 of 3 MPI ranks are no longer running/);
    const cancelled = await r.cancel(task, {} as never);
    expect(cancelled.state).toBe('cancelled');
  });
  it('refuses to launch a case it cannot distribute', async () => {
    fs.writeFileSync(path.join(input, 'ProjectParameters.json'), JSON.stringify({ problem_data: {}, solver_settings: { linear_solver_settings: { solver_type: 'pardiso_lu' } } }));
    const receipt = await mk(['true']).dispatch(task, {} as never);
    expect(receipt.state).toBe('failed');
    expect(fs.existsSync(path.join(run, 'r/run.sh'))).toBe(false);
  });
  it('throws (so the queue records uncertain) when the launch status is unknown', async () => {
    const flaky: typeof runLocalSh = (h, c, o) => /setsid|nohup/.test(c) ? Promise.resolve({ code: 255, stdout: '', stderr: 'connection reset' }) : runLocalSh(h, c, o);
    await expect(mk(['true'], 3, flaky).dispatch(task, {} as never)).rejects.toThrow(/status is unknown/);
  });
  it('validates launcher, MPI-enabled Kratos and CPU budget', async () => {
    const none: typeof runLocalSh = async (_h, c) => /nproc|getconf/.test(c) ? { code: 0, stdout: '2\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
    const errors = await mk(['python3'], 4, none).validate(task, {} as never);
    expect(errors.join('\n')).toMatch(/launcher 'mpirun' was not found/);
    expect(errors.join('\n')).toMatch(/KratosMultiphysics\.mpi is not importable/);
    expect(errors.join('\n')).toMatch(/4 ranks × 1 threads but this machine has 2 CPUs/);
  });
});
