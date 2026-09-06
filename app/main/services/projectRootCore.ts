/**
 * The pure half of the project-root concept.
 *
 * No `electron`, so the decisions worth testing — how a stored value is read
 * back, and how a path is described relative to the root — are vitest-testable;
 * `projectRoot.ts` is the thin stateStore glue. Same core/glue split as
 * `recentFilesCore.ts`/`recentFiles.ts` and `sessionCore.ts`/`session.ts`.
 *
 * The root is a **default, never a fence**: it seeds the terminal's cwd, file
 * dialogs and the assistant's context, and nothing here refuses a path outside
 * it. Enforcement, if it ever arrives, belongs to the tool-approval work.
 */
import * as path from "node:path";
import { isInsideRoot } from "../pathGuard";
import { recentDescription } from "../../../mesh/src/recentMeshesCore";

/** stateStore key. Verified free of both KKSS's own keys and the mesh
 *  extension's unprefixed globalState keys (see meshHost.ts). */
export const PROJECT_ROOT_KEY = "projectRoot";

/** Reads a stored value back. Tolerant: the store is shared with the mesh
 *  extension's keys and is editable by hand, so anything malformed reads as
 *  "no root" rather than throwing the launch away. */
export function parseProjectRoot(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? path.resolve(raw) : undefined;
}

/** The chip shown in the toolbar: the folder's own name. */
export function rootLabel(root: string): string {
  // A drive or filesystem root has no basename; show it as-is rather than "".
  return path.basename(root) || root;
}

/** `$HOME`-abbreviated full path, for tooltips. `home` is an argument so tests
 *  do not depend on the machine they run on — the same convention the mesh
 *  recents core uses. */
export function abbreviateHome(fsPath: string, home?: string): string {
  if (home && home.length > 0 && fsPath.startsWith(home)) {
    const rest = fsPath.slice(home.length);
    // Accept either separator at the boundary, matching recentDescription.
    if (rest.length === 0) return "~";
    if (rest[0] === "/" || rest[0] === "\\") return "~" + rest;
  }
  return fsPath;
}

/**
 * How a file's folder is described in the recents surfaces.
 *
 * Inside the project root it is shown *relative to* the root, which is what
 * makes a recents list read as "this project's files" without re-sectioning or
 * reordering it — reordering would fight the list's newest-first semantic.
 * Anything else keeps the plain `~`-abbreviated folder.
 */
export function describeWithin(root: string | undefined, fsPath: string, home?: string): string {
  const dir = path.dirname(path.resolve(fsPath));
  if (root && isInsideRoot(root, dir)) {
    const rel = path.relative(root, dir);
    // At the root itself `relative` is "", which would render as an empty
    // column; name the root instead.
    return rel === "" ? rootLabel(root) : rel;
  }
  return recentDescription(fsPath, home);
}
