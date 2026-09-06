/**
 * The pure half of session restore: what "where I left off" is, how it is
 * serialized, and how it degrades when the world moved on underneath it.
 *
 * No `electron`, so the decisions that matter — what gets dropped at capture,
 * what a damaged or stale stored value does, and how a restore copes with files
 * that vanished — are vitest-testable. `session.ts` is the stateStore glue.
 */
import type { Mode, Screen } from "../ipc";

export const SESSION_KEY = "session";

/** Bumped when the stored shape changes; an older/newer value is ignored
 *  wholesale rather than migrated, since losing a session is cheap. */
export const SESSION_VERSION = 1;

/** Never reopen an unbounded number of documents at launch. */
export const SESSION_TAB_CAP = 8;

/** One mode's open documents, in tab order. */
export interface ModeSession {
  files: string[];
  /** Which one was focused. A *path*, not an index: an index silently shifts
   *  when pruning drops an earlier file. */
  activeFile: string | null;
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
}

function captureMode({ files, activeFile }: ModeSnapshot): ModeSession {
  // Blank tabs carry no state worth restoring, and reopening them would just
  // accumulate empty tabs across launches.
  const open = files.filter((f): f is string => !!f).slice(0, SESSION_TAB_CAP);
  return { files: open, activeFile: activeFile && open.includes(activeFile) ? activeFile : null };
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
  return { files, activeFile: typeof active === "string" && files.includes(active) ? active : null };
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

/** Nothing worth restoring — no documents in either mode. */
export function isEmptySession(state: SessionState): boolean {
  return state.cad.files.length === 0 && state.mesh.files.length === 0;
}

/** How many documents a state would reopen. */
export function sessionFileCount(state: SessionState): number {
  return state.cad.files.length + state.mesh.files.length;
}
