// Process-wide glue for eventLogCore: one EventLog plus a console tap.
import { EventLog } from "./eventLogCore";

export const eventLog = new EventLog();

let installed = false;

/** Mirror console.warn/error into the tail. Output still reaches the original; never throws. */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      eventLog.log(level, args);
      original(...args);
    };
  }
}
