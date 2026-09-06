/**
 * Atomic file writes — the durability primitive `jsonStore.ts` used to keep to
 * itself, extracted so cadHost's sidecar writers (and the cloud staging layer)
 * get the same guarantees. Electron-free, so `test/` can import it directly:
 * the same core/glue split as jsonStore.ts under stateStore.ts.
 *
 * Two properties, both of which cost real user data when missing:
 *
 * - **Atomic.** A sibling temp file is written, fsynced, then renamed over the
 *   target (atomic on POSIX and NTFS; a *sibling* so the rename never crosses a
 *   filesystem). A reader — including a desktop sync daemon watching the user's
 *   project folder — never observes a truncated file, so it can neither upload
 *   half a sidecar nor raise a spurious "conflicted copy".
 * - **Serialized per path.** Two overlapping writes to one path would otherwise
 *   share the temp name and make the second `rename` fail with ENOENT. That is
 *   not hypothetical: `CadHost.flushSidecars()` clears the six debounce timers
 *   but cannot cancel a timer that has *already fired*, and the macro library
 *   (`cad-preview-macros.json`) is per *folder*, so two tabs on models in one
 *   directory write the same path from one process.
 *
 * The temp file is briefly visible in the user's directory. That is the same
 * trade `state.json` has always made, and the alternative (a temp in the OS
 * temp dir) is wrong: `rename` must not cross filesystems.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileHandle } from "node:fs/promises";

export interface AtomicWriteOptions {
  /** Text encoding; ignored for a Uint8Array payload. Default "utf8". */
  encoding?: BufferEncoding;
  /**
   * Last-chance veto, called after the temp file is durable and before the
   * rename. Returning false removes the temp file and resolves normally.
   *
   * This is JsonStore's `stopped` re-check and it is load-bearing: flushSync()
   * may have written the final state while this write was awaiting, and a
   * stale snapshot must never land on top of it.
   */
  beforeRename?: () => boolean;
}

/** `${file}.${pid}.tmp` — a sibling, so the rename never crosses a filesystem.
 *  The pid keeps two processes from colliding on the name; the single-instance
 *  lock makes that unlikely but not free (the e2e harness runs without it). */
export function tempPathFor(file: string, pid: number = process.pid): string {
  return `${file}.${pid}.tmp`;
}

/**
 * The shutdown path's temp name, deliberately **distinct** from the async one.
 *
 * They must not collide: `writeFileAtomicSync` bypasses the per-path chain (it
 * is synchronous, on the quit path), so if it lands between an async write's
 * `open()` and its `writeFile()`, a shared name would leave the async write
 * holding a handle to the file that is now the *target* — and its stale
 * snapshot would be written straight into `state.json`, defeating the
 * `beforeRename` veto and losing every setting plus both encrypted secrets.
 */
function syncTempPathFor(file: string, pid: number = process.pid): string {
  return `${file}.${pid}.sync.tmp`;
}

/** On Windows an AV scanner or the search indexer can hold the target open for
 *  a moment; POSIX never hits this path. Exported because the cloud downloader
 *  renames a *streamed* temp file into place without going through
 *  writeFileAtomic(). */
export async function renameWithRetry(tmp: string, file: string, attempts = 3): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (attempt >= attempts || !transient) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

/** In-flight (or last finished) write per resolved path. */
const chains = new Map<string, Promise<void>>();

/** Runs `task` after whatever is already queued for `key`, and rejects only its
 *  own caller — a failed write never poisons the queue for the next one. */
function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  chains.set(key, tail);
  void tail.then(() => {
    // Only the current tail may clear the entry, or a later write's turn would
    // be forgotten and the map would stop serializing.
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** temp → fsync → rename, serialized against other writes to the same path. */
export function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const target = path.resolve(file);
  return serialize(target, () => writeOnce(target, data, options));
}

async function writeOnce(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions
): Promise<void> {
  const tmp = tempPathFor(file);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  let handle: FileHandle | undefined;
  try {
    handle = await fs.promises.open(tmp, "w");
    if (typeof data === "string") await handle.writeFile(data, options.encoding ?? "utf8");
    else await handle.writeFile(data);
    // Durable before the rename, so a power loss cannot swap in an empty file.
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.beforeRename && !options.beforeRename()) {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      return;
    }
    await renameWithRetry(tmp, file);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Synchronous variant for the shutdown path, where `will-quit` cannot await.
 * Deliberately does **not** fsync and does **not** retry the rename: both would
 * block the quit, and this call's whole job is to be fast and best-effort.
 * It also bypasses the per-path chain — JS is single-threaded, so an async
 * write can only resume strictly after this returns, and callers neuter theirs
 * with `beforeRename` instead.
 */
export function writeFileAtomicSync(
  file: string,
  data: string | Uint8Array,
  options: { encoding?: BufferEncoding } = {}
): void {
  const target = path.resolve(file);
  const tmp = syncTempPathFor(target);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof data === "string") fs.writeFileSync(tmp, data, options.encoding ?? "utf8");
    else fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing left to do on the way out */
    }
    throw err;
  }
}
