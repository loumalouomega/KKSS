/**
 * chokidar-backed replacement for vscode.workspace.createFileSystemWatcher
 * over a RelativePattern(base, pattern). Supports the pattern shapes the mesh
 * providers actually use:
 *  - an exact filename (mdpa reparse watcher; also a GiD in-file series that
 *    is not a sibling pair — timelineWatchGlob's single-file fallback)
 *  - a brace extension glob like `*.{vtk,vtu,vtm}` (vtk timeline discovery)
 *  - a brace list of FULL names like `{case.post.msh,case.post.res}` (mesh
 *    3.21.0's timelineWatchGlob, a GiD ascii pair — steps are appended to the
 *    .post.res half while the open tab is usually the .post.msh, so both need
 *    watching)
 *  - a directory-scoped glob like `constant/polyMesh/*` (mesh 3.21.0's
 *    contentWatchGlob, for `.foam`: the opened file is a 0-byte marker whose
 *    real mesh lives in that subdirectory, so re-running blockMesh leaves the
 *    marker's own mtime untouched)
 *  - a bare `*`, which no submodule asks for but the cloud staging layer does:
 *    it has to notice *any* write into a staged document's directory, because
 *    a mesh save happens inside the submodule and is never reported back
 *
 * Only a directory-scoped pattern needs chokidar's default depth:0 (root
 * only) raised — and only as far as that pattern's own directory prefix, so
 * the bare `*` case (and every other slash-free shape) stays at depth:0. That
 * matters beyond chokidar overhead: CLAUDE.md documents depth:0 as a
 * deliberate limit for the cloud-staging watcher — XDMF's sibling `.h5` is
 * uploaded, OpenFOAM's nested tree deliberately is not — so a blanket depth
 * increase would silently start uploading `constant/polyMesh/` trees.
 */
import * as chokidar from "chokidar";
import * as path from "node:path";

export interface FileWatcher {
  onDidChange(cb: (fsPath: string) => void): { dispose(): void };
  onDidCreate(cb: (fsPath: string) => void): { dispose(): void };
  onDidDelete(cb: (fsPath: string) => void): { dispose(): void };
  dispose(): void;
}

/**
 * Exported for unit tests. Takes the changed path RELATIVE to the watch base,
 * "/"-normalized (createFileSystemWatcher below does both) — not a bare
 * basename, so a directory-scoped pattern can tell "constant/polyMesh/x" from
 * an unrelated "constant/x" or a root-level "x".
 */
export function matcherFor(pattern: string): (relPath: string) => boolean {
  if (pattern === "*") return () => true;

  if (pattern.includes("/")) {
    // Directory-scoped: everything up to the last "/" is a literal directory
    // path, the final segment is the only part that may be a glob (today,
    // only "*" — "any file directly in that directory" — is ever needed).
    const i = pattern.lastIndexOf("/");
    const dir = pattern.slice(0, i);
    const last = pattern.slice(i + 1);
    const matchesLast = last === "*" ? () => true : (name: string) => name === last;
    return (relPath) => {
      const j = relPath.lastIndexOf("/");
      const relDir = j < 0 ? "" : relPath.slice(0, j);
      const base = j < 0 ? relPath : relPath.slice(j + 1);
      return relDir === dir && matchesLast(base);
    };
  }

  const extBrace = pattern.match(/^\*\.\{([^}]+)\}$/);
  if (extBrace) {
    const exts = new Set(extBrace[1].split(",").map((e) => `.${e.trim().toLowerCase()}`));
    return (relPath) => exts.has(path.extname(relPath).toLowerCase());
  }

  // A brace list of FULL names, e.g. "{case.post.msh,case.post.res}" — a GiD
  // ascii pair. Distinct from the extension-glob shape above (which always
  // starts "*.{" — its members are bare extensions, these are whole names).
  const nameBrace = pattern.match(/^\{([^}]+)\}$/);
  if (nameBrace) {
    const names = new Set(nameBrace[1].split(",").map((n) => n.trim()));
    return (relPath) => names.has(relPath);
  }

  const star = pattern.match(/^\*(\.[A-Za-z0-9]+)$/);
  if (star) {
    const ext = star[1].toLowerCase();
    return (relPath) => path.extname(relPath).toLowerCase() === ext;
  }
  return (relPath) => relPath === pattern;
}

export function createFileSystemWatcher(base: string, pattern: string): FileWatcher {
  const matches = matcherFor(pattern);
  // Only a directory-scoped pattern needs to see past chokidar's default
  // root-only depth — exactly as many levels as its own directory prefix has,
  // so "constant/polyMesh/*" (two directory segments) needs depth 2. Every
  // other pattern here has no "/" at all, so this stays 0 — unchanged.
  const depth = pattern.includes("/") ? pattern.split("/").length - 1 : 0;
  const changeCbs: Array<(p: string) => void> = [];
  const createCbs: Array<(p: string) => void> = [];
  const deleteCbs: Array<(p: string) => void> = [];

  const relOf = (fsPath: string): string => path.relative(base, fsPath).split(path.sep).join("/");

  const watcher = chokidar.watch(base, { ignoreInitial: true, depth });
  watcher.on("add", (fsPath) => {
    if (matches(relOf(fsPath))) for (const cb of createCbs) cb(fsPath);
  });
  watcher.on("change", (fsPath) => {
    if (matches(relOf(fsPath))) for (const cb of changeCbs) cb(fsPath);
  });
  // mesh 3.2.0's mdpa provider pairs this with onDidCreate to survive the
  // atomic delete-then-create save pattern some editors use.
  watcher.on("unlink", (fsPath) => {
    if (matches(relOf(fsPath))) for (const cb of deleteCbs) cb(fsPath);
  });
  watcher.on("error", () => {
    /* a vanished directory is not fatal for a preview */
  });

  const sub = (list: Array<(p: string) => void>) => (cb: (p: string) => void) => {
    list.push(cb);
    return {
      dispose() {
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      },
    };
  };

  return {
    onDidChange: sub(changeCbs),
    onDidCreate: sub(createCbs),
    onDidDelete: sub(deleteCbs),
    dispose: () => void watcher.close(),
  };
}
