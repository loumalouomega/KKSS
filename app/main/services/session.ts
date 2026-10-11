/**
 * Session restore: reopen the last run's documents, screen and panels.
 *
 * Thin Electron binding over `sessionCore` — this module owns the stateStore
 * keys, the filesystem check and the gating rules. Restore is skipped when:
 *
 * - `KKSS_E2E` is set without `KKSS_E2E_RESTORE=1`. Required, not cosmetic: tools/smoke.e2e.mjs and
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
  isEmptyPlan,
  parseSession,
  planRestore,
  SESSION_KEY,
  type RestorePlan,
  type SessionState,
} from "./sessionCore";

/** Settings ▸ Restore Last Session (default on). */
export const RESTORE_SESSION_KEY = "restoreSession";

export function restoreEnabled(): boolean {
  if ((process.env.KKSS_E2E && process.env.KKSS_E2E_RESTORE !== "1") || process.env.KKSS_NO_RESTORE === "1") return false;
  return stateStore.get<boolean>(RESTORE_SESSION_KEY, true) !== false;
}

/** The stored session as a plan: vanished files dropped, evicted cloud documents
 *  kept as pending slots. `undefined` when there is nothing worth restoring.
 *  `plan.missing` counts only the dropped ones, so a short restore is explained
 *  rather than mysterious. */
export function loadSession(): RestorePlan | undefined {
  const stored = parseSession(stateStore.get(SESSION_KEY));
  if (!stored) return undefined;
  const plan = planRestore(stored, fs.existsSync);
  return isEmptyPlan(plan) ? undefined : plan;
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
