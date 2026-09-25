/** Opt-in local benchmark trace. Never enabled in packaged applications. */
import { app, ipcMain } from 'electron';
import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

const pending = new Map<string, { id: number; start: number }>();
let sequence = 0;
const clock = () => performance.timeOrigin + performance.now();
function destination(): string | undefined {
  const file = process.env.KKSS_PERF_TRACE;
  return !app.isPackaged && file && isAbsolute(file) ? file : undefined;
}
function record(event: object): void {
  const file = destination();
  if (file) appendFileSync(file, JSON.stringify(event) + '\n');
}
export function beginOpen(file: string): void {
  if (!destination()) return;
  pending.set(file, { id: ++sequence, start: clock() });
}
export function finishOpen(file: string | undefined, type: string): void {
  if (!file || (type !== 'geometry' && type !== 'model' && type !== 'vtkFrame')) return;
  const entry = pending.get(file);
  if (!entry) return;
  const end = clock();
  pending.delete(file);
  record({ event: 'open', file, type: type === 'vtkFrame' ? 'model' : type, messageType: type, ...entry, end, ms: end - entry.start });
}
export function configurePerformance(): void {
  if (destination()) app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') record({ event: 'failure', reason: details.reason });
    });
    contents.on('did-fail-load', (_event, code, reason, _url, mainFrame) => {
      if (mainFrame && code !== -3) record({ event: 'failure', reason });
    });
  });
  ipcMain.on('kkss:interactive', event => {
    if (event.sender.getURL() !== 'kkss://app/renderer/home/index.html') return;
    record({ event: 'interactive', end: clock() });
  });
}
