/**
 * The pure half of KKSS's app-wide recent-files list.
 *
 * No `electron`, so the list's actual decisions — ordering, de-duplication, the
 * cap and the tolerance of a damaged store — are vitest-testable;
 * `recentFiles.ts` is the thin stateStore glue. Same core/glue split as
 * `jsonStore.ts`/`stateStore.ts` and `chat/secretCodec.ts`/`chat/secrets.ts`,
 * and for the same reason: `test/` cannot import Electron.
 *
 * Why not just use the mesh submodule's `recentMeshesCore`: KKSS remembers a
 * `mode` per entry (a recent CAD document must reopen in pre mode, a mesh one
 * in post), and that core's `recordRecent`/`parseRecentList` both construct a
 * bare `{path, openedAt}` — routing our entries through them would silently
 * drop `mode` and send every recent file to whichever mode happened to be
 * active. The genuinely subtle part, `recentKey`'s win32-only case folding, IS
 * reused, along with the label/description formatting used by both surfaces.
 */
import * as path from "node:path";
import { RECENT_CAP, recentKey } from "../../../mesh/src/recentMeshesCore";
import type { Mode } from "../ipc";

/** stateStore key. NOT `recentMeshes`: the mesh extension's globalState is
 *  mapped onto this same flat store with no prefix (mesh/meshHost.ts), so that
 *  name already belongs to the submodule's own list. */
export const RECENT_FILES_KEY = "recentFiles";

/** The home screen shows a short list; the File menu shows all RECENT_CAP. */
export const HOME_RECENT_LIMIT = 5;

export { RECENT_CAP };

/** What a recent entry needs to re-fetch a cloud document in a later session. */
export interface RecentCloudRef {
  provider: string;
  accountId: string;
  itemId: string;
  name: string;
  parentId?: string;
  folder?: string;
}

/** One remembered document. Plain JSON — it round-trips through stateStore. */
export interface RecentFile {
  /** Absolute path, as resolved when it was recorded. For a cloud document
   *  this is the staging copy, which is why `cloud` exists. */
  path: string;
  /** Which mode opened it — the mode it reopens in. */
  mode: Mode;
  /** Epoch ms of the most recent open, which is also the sort key. */
  openedAt: number;
  /**
   * Set when `path` is a staging copy of a remote file. Two consequences: the
   * row survives a cache eviction (see `pruneRecentFiles`), and clicking it
   * re-downloads instead of reporting a missing file.
   */
  cloud?: RecentCloudRef;
}

const isMode = (value: unknown): value is Mode => value === "cad" || value === "mesh";

/**
 * Records an open, returning a new list — newest first, de-duplicated, capped.
 *
 * De-duplication is by **path alone**, and a re-open refreshes the entry's
 * `mode`. Keying on path+mode instead would give a format both modes can read
 * (`.stl`, `.obj`, `.ply`) two of the ten rows for what the user thinks of as
 * one file, the older of which would reopen in the mode they just moved away
 * from. One row that remembers where the file was last opened is the honest
 * model.
 */
export function addRecentFile(
  list: readonly RecentFile[],
  fsPath: string,
  mode: Mode,
  now: number,
  cloud?: RecentCloudRef,
  cap: number = RECENT_CAP,
  platform: string = process.platform
): RecentFile[] {
  const resolved = path.resolve(fsPath);
  const key = recentKey(resolved, platform);
  const kept = list.filter((e) => recentKey(e.path, platform) !== key);
  const entry: RecentFile = { path: resolved, mode, openedAt: now };
  if (cloud) entry.cloud = cloud;
  return [entry, ...kept].slice(0, Math.max(0, cap));
}

function parseCloudRef(raw: unknown): RecentCloudRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  const provider = str(v.provider);
  const accountId = str(v.accountId);
  const itemId = str(v.itemId);
  const name = str(v.name);
  if (!provider || !accountId || !itemId || !name) return undefined;
  return { provider, accountId, itemId, name, parentId: str(v.parentId), folder: str(v.folder) };
}

/**
 * Reads a stored value back. Tolerant by design: this store is shared with the
 * mesh extension's own keys and hand-editable on disk, so anything malformed is
 * skipped rather than throwing the list (or the launch) away.
 */
export function parseRecentFiles(raw: unknown): RecentFile[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentFile[] = [];
  for (const stored of raw) {
    if (!stored || typeof stored !== "object") continue;
    const { path: p, mode, openedAt, cloud } = stored as Record<string, unknown>;
    if (typeof p !== "string" || p.length === 0 || !isMode(mode)) continue;
    const entry: RecentFile = {
      path: p,
      mode,
      openedAt: typeof openedAt === "number" ? openedAt : 0,
    };
    // A malformed cloud blob costs the re-download, not the whole entry: the
    // local copy may still be there, and the row is still worth offering.
    const ref = parseCloudRef(cloud);
    if (ref) entry.cloud = ref;
    out.push(entry);
  }
  return out;
}

/**
 * Drops entries whose file is gone. `exists` is injected so this is testable
 * without touching a filesystem.
 *
 * A **cloud entry is kept even when its local copy is gone**: the staging cache
 * evicts on an LRU budget, and the remote file is still there. Clicking such a
 * row re-downloads it. Pruning them would silently empty the recents list of
 * exactly the documents that are hardest to find again.
 */
export function pruneRecentFiles(
  list: readonly RecentFile[],
  exists: (fsPath: string) => boolean
): RecentFile[] {
  return list.filter((e) => e.cloud !== undefined || exists(e.path));
}
