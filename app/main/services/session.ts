/**
 * Session restore: reopen the last run's documents, screen and panels.
 *
 * Thin Electron binding over `sessionCore` — this module owns the stateStore
 * keys, the filesystem check and the gating rules. Restore is skipped when:
 *
 * - `KKSS_E2E` is set. Required, not cosmetic: tools/smoke.e2e.mjs and
 *   tools/screenshots.mjs launch the real app, and a restore reopening the
 *   previous run's documents would perturb every case and every screenshot.
 * - the user turned it off (Settings ▸ Restore Last Session).
 * - `KKSS_NO_RESTORE=1` — a rescue hatch for a document that wedges the viewer
 *   at launch, so recovering never needs a hand-edited state.json.
 *
 * The gate covers *restoring* only. Recording (recentFiles.ts) and saving stay
 * live under e2e, so the docs screenshots can show a populated home screen.
 * Silent on a fresh profile, like services/whatsNew.ts.
 */
import * as fs from "node:fs";
import { stateStore } from "./stateStore";
import {
  isEmptySession,
  parseSession,
  pruneSession,
  sessionFileCount,
  SESSION_KEY,
  type SessionState,
} from "./sessionCore";

/** Settings ▸ Restore Last Session (default on). */
export const RESTORE_SESSION_KEY = "restoreSession";

export function restoreEnabled(): boolean {
  if (process.env.KKSS_E2E || process.env.KKSS_NO_RESTORE === "1") return false;
  return stateStore.get<boolean>(RESTORE_SESSION_KEY, true) !== false;
}

export interface LoadedSession {
  state: SessionState;
  /** How many stored documents had vanished — surfaced as a toast so a
   *  short restore is explained rather than mysterious. */
  missing: number;
}

/** The stored session with vanished files already dropped, or `undefined` when
 *  there is nothing worth restoring. */
export function loadSession(): LoadedSession | undefined {
  const stored = parseSession(stateStore.get(SESSION_KEY));
  if (!stored) return undefined;
  const state = pruneSession(stored, fs.existsSync);
  if (isEmptySession(state)) return undefined;
  return { state, missing: sessionFileCount(stored) - sessionFileCount(state) };
}

/**
 * Every document path the stored session would reopen, unpruned.
 *
 * Used as the cloud cache's eviction `keep` set: the pruned view from
 * `loadSession()` is the wrong input there, because a path it already dropped
 * is exactly the one eviction must not have taken.
 */
export function sessionPaths(): string[] {
  const stored = parseSession(stateStore.get(SESSION_KEY));
  if (!stored) return [];
  return [...stored.cad.files, ...stored.mesh.files];
}

export function saveSession(state: SessionState): void {
  void stateStore.update(SESSION_KEY, state);
}
