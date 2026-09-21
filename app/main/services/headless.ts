/** Private, loopback-only deployment control. No renderer can invoke shutdown. */
import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
export interface Activity { ready: boolean; connectedBrowsers: number; jobs: number; unknownJobs: boolean; uploads: boolean; shuttingDown: boolean }
export function startHeadlessControl(token: string, port: number, activity: () => Activity, stop: () => void): Promise<Server> {
  if (token.length < 32) throw new Error('KKSS_CONTROL_TOKEN must have at least 32 characters');
  const server = createServer((req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    res.setHeader('Cache-Control', 'no-store');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (req.method === 'GET' && req.url === '/activity') {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(activity())); return;
    }
    if (req.method === 'POST' && req.url === '/shutdown') { res.writeHead(202).end(); stop(); return; }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}

/** All saves are attempted; callers receive every failure, including recovery failures. */
export async function prepareHeadlessShutdown(saves: (() => Promise<void>)[], drain: () => Promise<void>): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const save of saves) { try { await save(); } catch (error) { failures.push(error); } }
  try { await drain(); } catch (error) { failures.push(error); }
  return failures;
}
