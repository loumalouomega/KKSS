/**
 * chokidar-backed replacement for vscode.workspace.createFileSystemWatcher
 * over a RelativePattern(base, pattern). Supports the two pattern shapes the
 * mesh providers actually use: an exact filename (mdpa reparse watcher) and
 * a brace extension glob like `*.{vtk,vtu,vtm}` (vtk timeline discovery).
 */
import * as chokidar from "chokidar";
import * as path from "node:path";

export interface FileWatcher {
  onDidChange(cb: (fsPath: string) => void): { dispose(): void };
  onDidCreate(cb: (fsPath: string) => void): { dispose(): void };
  dispose(): void;
}

/** Exported for unit tests. */
export function matcherFor(pattern: string): (name: string) => boolean {
  const brace = pattern.match(/^\*\.\{([^}]+)\}$/);
  if (brace) {
    const exts = new Set(brace[1].split(",").map((e) => `.${e.trim().toLowerCase()}`));
    return (name) => exts.has(path.extname(name).toLowerCase());
  }
  const star = pattern.match(/^\*(\.[A-Za-z0-9]+)$/);
  if (star) {
    const ext = star[1].toLowerCase();
    return (name) => path.extname(name).toLowerCase() === ext;
  }
  return (name) => name === pattern;
}

export function createFileSystemWatcher(base: string, pattern: string): FileWatcher {
  const matches = matcherFor(pattern);
  const changeCbs: Array<(p: string) => void> = [];
  const createCbs: Array<(p: string) => void> = [];

  const watcher = chokidar.watch(base, { ignoreInitial: true, depth: 0 });
  watcher.on("add", (fsPath) => {
    if (matches(path.basename(fsPath))) for (const cb of createCbs) cb(fsPath);
  });
  watcher.on("change", (fsPath) => {
    if (matches(path.basename(fsPath))) for (const cb of changeCbs) cb(fsPath);
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
    dispose: () => void watcher.close(),
  };
}
