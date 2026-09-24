/** Sequential acceptance runner: no retries, no services beyond local fixtures. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './e2eShared.mjs';
let failed = false;
for (const file of ['smoke.e2e.mjs', 'e2e/workspace.mjs', 'e2e/viewers.mjs', 'e2e/chat-mcp.mjs', 'e2e/lifecycle.mjs', 'e2e/cloud.mjs']) {
  const child = spawn(process.execPath, [path.join(root, 'tools', file)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let log = ''; let timedOut = false;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { log += b; process.stdout.write(b); });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');
  }, 600_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timer);
  if (code !== 0 || timedOut) {
    failed = true; fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test-results', file.replaceAll('/', '-') + '.log'), log + (timedOut ? '\nScenario exceeded 10-minute deadline' : ''));
  }
}
process.exitCode = failed ? 1 : 0;
