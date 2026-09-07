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
import { JsonStore } from "./jsonStore";

let store: JsonStore | undefined;

/** Bound lazily — app.getPath("userData") is only valid once Electron is up. */
function backing(): JsonStore {
  if (!store) store = new JsonStore(path.join(app.getPath("userData"), "state.json"));
  return store;
}

export const stateStore = {
  get<T>(key: string, defaultValue?: T): T | undefined {
    return backing().get(key, defaultValue);
  },
  update(key: string, value: unknown): Promise<void> {
    return backing().update(key, value);
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
