// Process-wide glue for eventLogCore: one EventLog plus a console tap.
import { EventLog, formatArg } from "./eventLogCore";
import { logOutput } from "./outputBus";

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
      // The Output panel's Log tab shows the same lines live.
      logOutput(level, "main", args.map(formatArg).join(" "));
      original(...args);
    };
  }
}
