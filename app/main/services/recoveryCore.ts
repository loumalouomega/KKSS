/**
 * The pure half of crash/shutdown recovery: what a recovery entry is, how a
 * session folder proves who owns it, and when a restore may proceed.
 *
 * No `electron` and no `node:fs`, so the decisions that matter — a reused pid
 * is not a live session, a damaged entry degrades instead of throwing, a
 * source that changed since the checkpoint is reported rather than replayed —
 * are vitest-testable. `recovery.ts` is the filesystem glue (the
 * `sessionCore.ts` / `session.ts` split).
 *
 * Layout under `<userData>/recovery/`:
 *   <pid>-<startSeconds>/session.json   who owns this folder
 *   <pid>-<startSeconds>/<id>.json      one RecoveryEntry
 *   <pid>-<startSeconds>/<id>.ops.json  a mesh entry's operation recipe
 *   mesh-*.json (+ .source.json), editor-*.json
 *                                       legacy flat files the quit path wrote
 *                                       before checkpoints existed
 */

/** Bumped when the stored shape changes; a different value is ignored. */
export const RECOVERY_VERSION = 1;

/** Never offer (or keep) an unbounded number of entries. */
export const RECOVERY_ENTRY_CAP = 64;

/** An editor buffer larger than this is not checkpointed (the file on disk is
 *  the better answer for a multi-megabyte paste). */
export const RECOVERY_EDITOR_MAX_BYTES = 8 * 1024 * 1024;

export type RecoveryKind = "mesh" | "editor";

interface EntryBase {
  version: number;
  /** Stable within a session: one live checkpoint per tab / buffer. */
  id: string;
  /** The document the work belongs to; null for an untitled editor buffer. */
  originalPath: string | null;
  /** Source mtime/size when the checkpoint was written (null when unknown). */
  sourceMtimeMs: number | null;
  sourceSize: number | null;
  savedAt: number;
  /** Short label of what the session was doing ("A solve was running"). */
  task?: string;
}

export interface MeshRecoveryEntry extends EntryBase {
  kind: "mesh";
  originalPath: string;
  /** Operation recipe file, a sibling of the entry (basename only). */
  recipeFile: string;
}

export interface EditorRecoveryEntry extends EntryBase {
  kind: "editor";
  content: string;
}

export type RecoveryEntry = MeshRecoveryEntry | EditorRecoveryEntry;

/** A stored entry plus where it lives, as the glue lists it. */
export interface ListedRecovery {
  entry: RecoveryEntry;
  /** Directory holding the entry (session folder or the recovery root). */
  directory: string;
  /** Every file that belongs to the entry, as paths relative to `directory`. */
  files: string[];
}

// ---- Session ownership -------------------------------------------------------

export interface SessionStamp {
  pid: number;
  /** Process start time in whole seconds since the epoch. */
  startSeconds: number;
}

export function sessionDirName(stamp: SessionStamp): string {
  return `${stamp.pid}-${stamp.startSeconds}`;
}

export function parseSessionDirName(name: string): SessionStamp | null {
  const m = /^(\d{1,10})-(\d{1,12})$/.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  const startSeconds = Number(m[2]);
  return pid > 0 && startSeconds > 0 ? { pid, startSeconds } : null;
}

/** Tolerance for comparing two readings of one process's start time. */
export const START_TIME_SLACK_SECONDS = 2;

/**
 * Whether a session folder's owner is gone. `liveStartSeconds(pid)` returns
 * the start time of whatever process now holds that pid, or null when none
 * does. A pid that exists with a *different* start time is a reused pid — the
 * original owner is gone — and an unreadable start time on a live pid keeps
 * the folder (a kept orphan is tidy-up; a deleted live checkpoint is lost work).
 */
export function isOrphanSession(
  stamp: SessionStamp,
  liveStartSeconds: (pid: number) => number | null | "unknown",
): boolean {
  const live = liveStartSeconds(stamp.pid);
  if (live === null) return true;
  if (live === "unknown") return false;
  return Math.abs(live - stamp.startSeconds) > START_TIME_SLACK_SECONDS;
}

// ---- Parsing -----------------------------------------------------------------

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeBase(value: unknown): string | null {
  // A recipe file is a sibling named by basename; anything with a separator or
  // a traversal segment is a damaged (or hostile) entry, not a path to follow.
  if (typeof value !== "string" || !value || value.length > 200) return null;
  if (/[\\/]/.test(value) || value === "." || value === "..") return null;
  return value;
}

/** Repair-on-parse: a damaged or foreign-version entry is `null`, never a throw. */
export function parseEntry(raw: unknown): RecoveryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== RECOVERY_VERSION) return null;
  const id = typeof r.id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(r.id) ? r.id : null;
  if (!id) return null;
  const common = {
    version: RECOVERY_VERSION,
    id,
    sourceMtimeMs: num(r.sourceMtimeMs),
    sourceSize: num(r.sourceSize),
    savedAt: num(r.savedAt) ?? 0,
    ...(typeof r.task === "string" && r.task ? { task: r.task.slice(0, 200) } : {}),
  };
  if (r.kind === "mesh") {
    const recipeFile = safeBase(r.recipeFile);
    if (typeof r.originalPath !== "string" || !r.originalPath || !recipeFile) return null;
    return { ...common, kind: "mesh", originalPath: r.originalPath, recipeFile };
  }
  if (r.kind === "editor") {
    if (typeof r.content !== "string") return null;
    const originalPath = typeof r.originalPath === "string" && r.originalPath ? r.originalPath : null;
    return { ...common, kind: "editor", originalPath, content: r.content };
  }
  return null;
}

/** `editor-<time>.json` as the quit path wrote it before checkpoints existed. */
export function parseLegacyEditor(name: string, raw: unknown, savedAt: number): RecoveryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.content !== "string") return null;
  return {
    version: RECOVERY_VERSION,
    id: name.replace(/\.json$/, ""),
    kind: "editor",
    originalPath: typeof r.originalPath === "string" && r.originalPath ? r.originalPath : null,
    content: r.content,
    sourceMtimeMs: null,
    sourceSize: null,
    savedAt,
  };
}

/** `mesh-*.json.source.json` as the quit path wrote it (names the recipe). */
export function parseLegacyMesh(sourceName: string, raw: unknown, savedAt: number): RecoveryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.originalPath !== "string" || !r.originalPath) return null;
  const recipeFile = sourceName.replace(/\.source\.json$/, "");
  if (!safeBase(recipeFile)) return null;
  return {
    version: RECOVERY_VERSION,
    id: recipeFile.replace(/\.json$/, ""),
    kind: "mesh",
    originalPath: r.originalPath,
    recipeFile,
    sourceMtimeMs: null,
    sourceSize: null,
    savedAt,
  };
}

// ---- Restore decisions -------------------------------------------------------

export type RestoreVerdict =
  /** The source is as it was (or the entry has none): safe to restore. */
  | "restorable"
  /** The source changed since the checkpoint: report, offer Show/Discard only. */
  | "sourceChanged"
  /** The source file is gone. */
  | "sourceMissing";

export interface SourceStat {
  mtimeMs: number;
  size: number;
}

/**
 * Mesh recipes replay over the original file, so they are only safe when that
 * file is what the checkpoint was written against. Legacy entries carry no
 * stamp; for them an existing file is accepted (the recipe is what the user
 * lost, and the restore is opt-in and reviewable). An editor buffer is a whole
 * replacement, so a changed source is still reported before it overwrites.
 */
export function classifyRestore(entry: RecoveryEntry, stat: SourceStat | null): RestoreVerdict {
  if (entry.originalPath === null) return "restorable";
  if (!stat) return "sourceMissing";
  if (entry.sourceMtimeMs === null || entry.sourceSize === null) return "restorable";
  const sameSize = stat.size === entry.sourceSize;
  const sameTime = Math.abs(stat.mtimeMs - entry.sourceMtimeMs) < 1;
  return sameSize && sameTime ? "restorable" : "sourceChanged";
}

/** Newest first, capped; the glue deletes whatever falls off the end. */
export function capEntries<T extends { entry: RecoveryEntry }>(listed: T[]): { kept: T[]; dropped: T[] } {
  const sorted = [...listed].sort((a, b) => b.entry.savedAt - a.entry.savedAt);
  return { kept: sorted.slice(0, RECOVERY_ENTRY_CAP), dropped: sorted.slice(RECOVERY_ENTRY_CAP) };
}
