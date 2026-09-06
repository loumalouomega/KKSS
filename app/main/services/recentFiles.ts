/**
 * App-wide recent files: the documents the user opened, in either mode.
 *
 * Thin Electron binding over the pure `recentFilesCore` — this module owns the
 * stateStore key and the one filesystem call. Recording happens at exactly one
 * choke point (`openFile()` in index.ts); see the comment there for what is
 * deliberately NOT recorded.
 *
 * Distinct from the mesh submodule's own `RecentMeshStore`, which keeps running
 * (both mesh providers require it) but no longer drives any UI: it records only
 * what the mesh providers resolve, so it never saw a CAD document.
 */
import * as fs from "node:fs";
import { stateStore } from "./stateStore";
import type { Mode } from "../ipc";
import {
  addRecentFile,
  parseRecentFiles,
  pruneRecentFiles,
  RECENT_FILES_KEY,
  type RecentFile,
} from "./recentFilesCore";

const listeners: (() => void)[] = [];

function write(list: RecentFile[]): void {
  void stateStore.update(RECENT_FILES_KEY, list);
  for (const listener of listeners) listener();
}

export const recentFiles = {
  /** Newest first, with vanished files dropped. Pruning happens on read (at
   *  most RECENT_CAP stats) rather than through a watcher, so the menu never
   *  offers a path that no longer exists. */
  list(): RecentFile[] {
    const stored = parseRecentFiles(stateStore.get(RECENT_FILES_KEY));
    const pruned = pruneRecentFiles(stored, fs.existsSync);
    // Only write back when something actually went away, so a plain read of an
    // intact list costs no disk write.
    if (pruned.length !== stored.length) write(pruned);
    return pruned;
  },

  record(fsPath: string, mode: Mode): void {
    write(addRecentFile(this.list(), fsPath, mode, Date.now()));
  },

  clear(): void {
    write([]);
  },

  /** Fires after every change — the File menu must be rebuilt wholesale (an
   *  Electron menu is static once built) and the home screen re-pushed. */
  onDidChange(listener: () => void): void {
    listeners.push(listener);
  },
};
