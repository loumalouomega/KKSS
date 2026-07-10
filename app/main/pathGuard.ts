/** Pure path checks for the custom protocol handlers (unit-testable). */
import * as path from "node:path";

/** True when `fsPath` is `root` or inside it. */
export function isInsideRoot(root: string, fsPath: string): boolean {
  return fsPath === root || fsPath.startsWith(root + path.sep);
}

/** True when `fsPath` is inside any of the allowed roots. */
export function isPathAllowed(roots: Iterable<string>, fsPath: string): boolean {
  for (const root of roots) {
    if (isInsideRoot(root, fsPath)) return true;
  }
  return false;
}
