/**
 * The pure half of session restore: what "where I left off" is, how it is
 * serialized, and how it degrades when the world moved on underneath it.
 *
 * No `electron`, so the decisions that matter — what gets dropped at capture,
 * what a damaged or stale stored value does, and how a restore copes with files
 * that vanished — are vitest-testable. `session.ts` is the stateStore glue.
 */
import type { Mode, Screen } from "../ipc";
import { STAGED_PROVIDER_IDS } from "./cloud/cloudCore";

export const SESSION_KEY = "session";

/** Bumped when the stored shape changes; an older/newer value is ignored
 *  wholesale rather than migrated, since losing a session is cheap. */
export const SESSION_VERSION = 1;

/** Never reopen an unbounded number of documents at launch. */
export const SESSION_TAB_CAP = 8;

/**
 * What a later launch needs to re-fetch a cloud document the staging cache has
 * since evicted. It lives **in the session** because nothing else can supply
 * it: eviction deletes the manifest entry together with the file, the staging
 * path is a one-way hash of account + item (`cachePathCore.opaqueId`), and
 * recents is capped and loses a ref whenever a path is re-recorded without one.
 */
export interface SessionCloudRef {
  provider: string;
  accountId: string;
  itemId: string;
  name: string;
  parentId?: string;
}

/** One mode's open documents, in tab order. */
export interface ModeSession {
  files: string[];
  /** Which one was focused. A *path*, not an index: an index silently shifts
   *  when pruning drops an earlier file. */
  activeFile: string | null;
  /** Cloud-backed files among `files`, by path. Optional (and absent when there
   *  are none) so an older stored session still parses and `SESSION_VERSION`
   *  stays 1. */
  cloud?: Record<string, SessionCloudRef>;
}

/** The screens worth restoring. "editor" is deliberately not among them. */
export type SessionScreen = "home" | Mode;

export interface SessionState {
  version: number;
  cad: ModeSession;
  mesh: ModeSession;
  screen: SessionScreen;
  terminal: boolean;
  chat: boolean;
}

export interface ModeSnapshot {
  /** Each open tab's document, in tab order; `undefined` for a blank tab. */
  files: (string | undefined)[];
  activeFile: string | undefined;
  /** The cloud origin of any open document that is a staged copy, by path. */
  cloud?: Record<string, SessionCloudRef>;
}

function captureMode({ files, activeFile, cloud }: ModeSnapshot): ModeSession {
  // Blank tabs carry no state worth restoring, and reopening them would just
  // accumulate empty tabs across launches.
  const open = files.filter((f): f is string => !!f).slice(0, SESSION_TAB_CAP);
  const mode: ModeSession = { files: open, activeFile: activeFile && open.includes(activeFile) ? activeFile : null };
  // Only refs for documents that are actually kept, and only when there are any.
  const refs = Object.fromEntries(open.flatMap((f) => (cloud?.[f] ? [[f, cloud[f]] as const] : [])));
  if (Object.keys(refs).length) mode.cloud = refs;
  return mode;
}

/** A stored cloud ref, or undefined when any required part is missing or the
 *  provider is not one we know — a hand-edited state.json must not become a
 *  request to an arbitrary provider. */
function parseCloudRef(raw: unknown): SessionCloudRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const text = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  if (!text(v.provider) || !(STAGED_PROVIDER_IDS as readonly string[]).includes(v.provider)) return undefined;
  if (!text(v.accountId) || !text(v.itemId) || !text(v.name)) return undefined;
  return { provider: v.provider, accountId: v.accountId, itemId: v.itemId, name: v.name, ...(text(v.parentId) ? { parentId: v.parentId } : {}) };
}

export function captureSession(input: {
  cad: ModeSnapshot;
  mesh: ModeSnapshot;
  screen: Screen;
  terminal: boolean;
  chat: boolean;
}): SessionState {
  return {
    version: SESSION_VERSION,
    cad: captureMode(input.cad),
    mesh: captureMode(input.mesh),
    // The text editor's document lives in EditorService and is not persisted,
    // so restoring that screen would land on an empty editor — worse than the
    // home screen. Degrade at capture time so the stored state is never
    // self-contradictory.
    screen: input.screen === "cad" || input.screen === "mesh" ? input.screen : "home",
    terminal: input.terminal,
    chat: input.chat,
  };
}

const parseMode = (raw: unknown): ModeSession => {
  const value = (raw ?? {}) as Record<string, unknown>;
  const files = Array.isArray(value.files)
    ? value.files.filter((f): f is string => typeof f === "string" && f.length > 0).slice(0, SESSION_TAB_CAP)
    : [];
  const active = value.activeFile;
  const mode: ModeSession = { files, activeFile: typeof active === "string" && files.includes(active) ? active : null };
  const rawRefs = value.cloud && typeof value.cloud === "object" && !Array.isArray(value.cloud) ? (value.cloud as Record<string, unknown>) : {};
  const refs = Object.fromEntries(files.flatMap((f) => { const ref = parseCloudRef(rawRefs[f]); return ref ? [[f, ref] as const] : []; }));
  if (Object.keys(refs).length) mode.cloud = refs;
  return mode;
};

/** Reads a stored session, or `undefined` if it is missing, damaged, or from a
 *  different version. */
export function parseSession(raw: unknown): SessionState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== SESSION_VERSION) return undefined;
  const screen = value.screen;
  return {
    version: SESSION_VERSION,
    cad: parseMode(value.cad),
    mesh: parseMode(value.mesh),
    screen: screen === "cad" || screen === "mesh" ? screen : "home",
    terminal: value.terminal === true,
    chat: value.chat === true,
  };
}

/**
 * Drops files that are no longer on disk, **before** anything is opened. This
 * has to happen up front: both hosts' `openPath()` is synchronous and never
 * touches the filesystem — it titles the tab and reloads the view — so a
 * missing file surfaces much later as an in-pane error banner, leaving a window
 * full of ghost tabs. `exists` is injected to keep this testable.
 */
export function pruneSession(
  state: SessionState,
  exists: (fsPath: string) => boolean
): SessionState {
  const prune = (mode: ModeSession): ModeSession => {
    const files = mode.files.filter(exists);
    return { files, activeFile: mode.activeFile && files.includes(mode.activeFile) ? mode.activeFile : null };
  };
  const cad = prune(state.cad);
  const mesh = prune(state.mesh);
  // A mode screen whose documents all vanished would restore to a blank viewer;
  // the home screen is the honest landing place.
  const screen =
    (state.screen === "cad" && cad.files.length === 0) || (state.screen === "mesh" && mesh.files.length === 0)
      ? "home"
      : state.screen;
  return { ...state, cad, mesh, screen };
}

/** One tab to recreate. A slot with a `ref` is a cloud document that is no longer
 *  on disk: restore makes its tab immediately (so order and focus are right) and
 *  fills it from the cloud in the background. */
export interface RestoreSlot {
  path: string;
  ref?: SessionCloudRef;
}

export interface ModePlan {
  slots: RestoreSlot[];
  activeFile: string | null;
}

export interface RestorePlan {
  cad: ModePlan;
  mesh: ModePlan;
  screen: SessionScreen;
  terminal: boolean;
  chat: boolean;
  /** Documents dropped for good: gone from disk and not re-fetchable. A pending
   *  cloud slot is *not* counted — it is expected to come back. */
  missing: number;
}

/**
 * `pruneSession`, extended for evicted cloud documents: a file that has vanished
 * is dropped **unless** the session knows where it came from, in which case it
 * stays in its saved slot as a pending download. Still synchronous and still
 * decided before anything opens — the download itself happens afterwards.
 */
export function planRestore(state: SessionState, exists: (fsPath: string) => boolean): RestorePlan {
  let missing = 0;
  const plan = (mode: ModeSession): ModePlan => {
    const slots: RestoreSlot[] = [];
    for (const path of mode.files) {
      if (exists(path)) slots.push({ path });
      else if (mode.cloud?.[path]) slots.push({ path, ref: mode.cloud[path] });
      else missing += 1;
    }
    const active = mode.activeFile;
    return { slots, activeFile: active && slots.some((s) => s.path === active) ? active : null };
  };
  const cad = plan(state.cad);
  const mesh = plan(state.mesh);
  const screen =
    (state.screen === "cad" && cad.slots.length === 0) || (state.screen === "mesh" && mesh.slots.length === 0)
      ? "home"
      : state.screen;
  return { cad, mesh, screen, terminal: state.terminal, chat: state.chat, missing };
}

/** Nothing worth restoring — no documents in either mode. */
export function isEmptySession(state: SessionState): boolean {
  return state.cad.files.length === 0 && state.mesh.files.length === 0;
}

/** True when a plan has no tab to recreate in either mode. */
export function isEmptyPlan(plan: RestorePlan): boolean {
  return plan.cad.slots.length === 0 && plan.mesh.slots.length === 0;
}

/** How many documents a state would reopen. */
export function sessionFileCount(state: SessionState): number {
  return state.cad.files.length + state.mesh.files.length;
}
