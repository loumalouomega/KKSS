import fs from 'node:fs';
import path from 'node:path';
import { scenario, assert, until } from './context.mjs';

// Home's environment report must describe the ssh host that will run guided
// solves, not this machine. A fake `ssh` on PATH runs the remote command
// locally (as `sh -c`) against a stub `python3`, so the real spawnSsh path,
// IPC and Home renderer are exercised without a sshd.
await scenario('remote-environment', async c => {
  const bin = path.join(c.dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(c.dir, 'ssh.log');
  const probe = JSON.stringify({ executable: '/remote/python3', version: '3.12.1', threadControl: true, applications: [{ name: 'KratosMultiphysics', available: true }] });
  // The last ssh argument is the remote command string (sshArgs puts it last).
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> ${JSON.stringify(log)}\ncd ${JSON.stringify(c.dir)} && exec sh -c "$last"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh\necho 'KKSS_PROBE:${probe}'\n`, { mode: 0o755 });
  c.seed({ projectRoot: c.dir, 'remote.kratosHost': 'fakehost' });
  const app = await c.launch(undefined, { env: { PATH: `${bin}:${process.env.PATH}` } });
  const home = await c.page(app, 'home');
  await home.locator('#workflow-check').click();
  const report = home.locator('#environment-report');
  await until(async () => /fakehost/.test(await report.textContent()), 'report names the ssh host');
  const text = await report.textContent();
  assert.match(text, /Checked on ssh host fakehost/);
  assert.match(text, /\/remote\/python3/);
  assert.match(text, /Available CPU cores: \d+/);
  assert.match(text, /Run directory \(fakehost:kkss-runs\): writable/);
  assert.match(fs.readFileSync(log, 'utf8'), /python3 -c/);
  assert.ok(fs.existsSync(path.join(c.dir, 'kkss-runs')), 'the remote run directory was created on the host');
});
