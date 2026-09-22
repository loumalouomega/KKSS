/**
 * vscode `globalState` replacement: a JSON file in Electron's userData dir.
 * Holds the mesh extension's persisted keys (sceneTheme, overwrite-warned, the
 * recent-mesh list), KKSS's own settings, and — safeStorage-encrypted via
 * chat/secrets.ts — the LLM API key and the MCP meta server's bearer token.
 *
 * Thin Electron binding only: the store logic (atomic temp-file + rename
 * writes, serialized behind a single-writer chain) lives in the Electron-free
 * JsonStore so it can be unit tested, mirroring chat/secrets.ts over
 * chat/secretCodec.ts.
 */
import { app } from "electron";
import * as path from "node:path";
import { managedConfig } from "./managedConfig";
import { JsonStore } from "./jsonStore";

let store: JsonStore | undefined;

type ChangeListener = (key: string, value: unknown) => void;
const listeners = new Set<ChangeListener>();

/** Bound lazily — app.getPath("userData") is only valid once Electron is up. */
function backing(): JsonStore {
  if (!store) store = new JsonStore(path.join(app.getPath("userData"), "state.json"));
  return store;
}

export const stateStore = {
  isManaged(key: string): boolean {
    const c = managedConfig(); return c.values.has(key) || c.secrets.has(key);
  },
  get<T>(key: string, defaultValue?: T): T | undefined {
    const c = managedConfig();
    return c.values.has(key) ? c.values.get(key) as T : backing().get(key, defaultValue);
  },
  update(key: string, value: unknown): Promise<void> {
    if (stateStore.isManaged(key)) return Promise.resolve();
    const written = backing().update(key, value);
    // Fired synchronously after the in-memory value changed (the disk write is
    // still queued), so a listener's `get()` already sees the new value.
    for (const listener of [...listeners]) {
      try {
        listener(key, value);
      } catch (err) {
        console.error("stateStore listener failed:", err);
      }
    }
    return written;
  },
  /**
   * Every accepted `update()` — the Settings page, the native menu and the
   * vscode shim's onDidChangeConfiguration all hang off this, so no two edit
   * paths can diverge. A managed key never fires (its update is refused).
   */
  onDidChange(listener: ChangeListener): { dispose(): void } {
    listeners.add(listener);
    return { dispose: () => void listeners.delete(listener) };
  },
  /** Resolves once every queued write is on disk. */
  flush(): Promise<void> {
    return backing().flush();
  },
  /** Synchronous last write, for `will-quit` (which cannot await), so a quit
   *  right after a settings change cannot drop it. */
  flushSync(): void {
    backing().flushSync();
  },
};
