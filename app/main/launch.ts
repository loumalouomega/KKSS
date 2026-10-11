/** OS launch inputs, independent of Electron and internal resource protocols. */
import * as path from "node:path";
import { statSync } from "node:fs";
import { modeForFile } from "./router";

/** The validated absolute path of an existing local file named by an external
 *  open input, whether or not KKSS can route it. */
function resolveLaunchInput(value: string, cwd: string): string | undefined {
  try {
    let file = value;
    if (/^kkss:/i.test(value)) {
      if (/%(?![0-9a-f]{2})/i.test(value)) return;
      const url = new URL(value);
      if (url.protocol !== "kkss:" || url.hostname !== "open" || url.port ||
          url.username || url.password || (url.pathname !== "" && url.pathname !== "/") ||
          url.hash || [...url.searchParams.keys()].some(key => key !== "file") ||
          url.searchParams.getAll("file").length !== 1) return;
      file = url.searchParams.get("file")!;
      if (!path.isAbsolute(file)) return;
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return;
    if (!file || file.includes("\0") || file.startsWith("-")) return;
    const resolved = path.resolve(cwd, file);
    return statSync(resolved).isFile() ? resolved : undefined;
  } catch { return undefined; }
}

export function localLaunchFile(value: string, cwd: string): string | undefined {
  const resolved = resolveLaunchInput(value, cwd);
  return resolved && modeForFile(resolved, "cad") ? resolved : undefined;
}

/** An existing local file an external open named that no mode can open. Missing
 *  paths and non-open `kkss://` URLs are not reported: only a real file the
 *  user pointed at deserves a "cannot open" answer. */
export function unsupportedLaunchFile(value: string, cwd: string): string | undefined {
  const resolved = resolveLaunchInput(value, cwd);
  return resolved && !modeForFile(resolved, "cad") ? resolved : undefined;
}

export function launchFiles(argv: string[], packaged: boolean, cwd: string): string[] {
  return [...new Set(argv.slice(packaged ? 1 : 2)
    .filter(value => value !== "." && !value.startsWith("-"))
    .map(value => localLaunchFile(value, cwd)).filter((value): value is string => !!value))];
}

export function unsupportedLaunchFiles(argv: string[], packaged: boolean, cwd: string): string[] {
  return [...new Set(argv.slice(packaged ? 1 : 2)
    .filter(value => value !== "." && !value.startsWith("-"))
    .map(value => unsupportedLaunchFile(value, cwd)).filter((value): value is string => !!value))];
}

/** Events arriving during startup are retained until all hosts are ready. */
export class LaunchQueue {
  private pending = new Set<string>();
  private open?: (file: string) => void;
  get size(): number { return this.pending.size; }
  enqueue(files: readonly string[]): void {
    for (const file of files) {
      if (this.open) this.open(file);
      else this.pending.add(file);
    }
  }
  ready(open: (file: string) => void): void {
    this.open = open;
    const files = [...this.pending];
    this.pending.clear();
    files.forEach(open);
  }
}
