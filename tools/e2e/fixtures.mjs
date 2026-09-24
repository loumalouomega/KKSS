import fs from 'node:fs';
import path from 'node:path';
import { root } from './context.mjs';
export function kratosFixture(dir) {
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify({ jobs: [{ job_id: 'e2e-job', state: 'running', case_dir: dir, created_at: 1720000000 }] }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'uvx'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, 'tools/fixtures/jobs-server.mjs'))} "$@"\n`, { mode: 0o755 });
  return { file, env: { PATH: `${bin}:${process.env.PATH}`, KKSS_JOBS_FIXTURE: file, KKSS_KRATOS_PYTHON: undefined } };
}
