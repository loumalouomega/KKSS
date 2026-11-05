// Process-wide Output-panel data: one Messages ring, one Log ring, one Progress
// registry. Electron-free on purpose — notifications, the vscode shim, the CAD
// compute client and the console tap all feed it, and several of them are
// imported by tests that must not drag Electron in. The panel (outputPanel.ts)
// is just one subscriber.
import { EntryLog, LOG_CAPACITY, MESSAGE_CAPACITY, ProgressRegistry, type EntryLevel } from "./outputCore";

/** User-facing events: what happened, in a sentence. */
export const messageLog = new EntryLog(MESSAGE_CAPACITY);
/** Raw output: console warnings/errors and captured solver output. */
export const outputLog = new EntryLog(LOG_CAPACITY);
/** Everything long-running and observable. */
export const progress = new ProgressRegistry();

/** Record a user-facing message. Never throws. */
export function logMessage(level: EntryLevel, source: string, text: string): void {
  messageLog.add(level, source, text);
}

/** Record raw output. Never throws. */
export function logOutput(level: EntryLevel, source: string, text: string): void {
  outputLog.add(level, source, text);
}
