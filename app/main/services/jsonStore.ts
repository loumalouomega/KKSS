/**
 * Durable JSON key/value store — the Electron-free half of stateStore.ts, split
 * out so it is unit-testable without an Electron runtime (the same split as
 * chat/secretCodec.ts under chat/secrets.ts).
 *
 * Two properties the naive "mutate an object, then writeFile the whole thing"
 * version lacked, both of which cost real user data:
 *
 * - **Atomic.** Every flush goes through services/atomicWrite.ts, which writes
 *   a sibling temp file, fsyncs it, and renames it over the target (atomic on
 *   POSIX and NTFS; a sibling so the rename never crosses a filesystem, and
 *   serialized per path). A crash or a full disk can no longer
 *   truncate the store — which mattered because the app's secrets (LLM API
 *   key, MCP meta-server bearer token) live in this same file, so one torn
 *   write used to lose every setting *and* both credentials at once, after
 *   which load()'s silent fallback booted the app looking factory-fresh.
 * - **Serialized.** Flushes run one at a time on a single-writer chain, so
 *   concurrent update() calls cannot interleave their writes. A write that has
 *   not started yet absorbs later mutations instead of queueing behind them —
 *   the right behavior for the many fire-and-forget `void update()` callers
 *   (every Settings menu click, the zoom picker, the mesh Memento).
 */
import * as fs from "node:fs";
import { writeFileAtomic, writeFileAtomicSync } from "./atomicWrite";

export class JsonStore {
  private data: Record<string, unknown> | undefined;
  /** Set by a mutation, cleared when a write serializes the snapshot. */
  private dirty = false;
  /** Set by flushSync() — an async write still in flight must not land after it. */
  private stopped = false;
  /** The write currently in flight (or the last finished one). */
  private chain: Promise<void> = Promise.resolve();
  /** A queued write that has not started yet — later updates join it. */
  private queued: Promise<void> | undefined;

  constructor(private readonly file: string) {}

  /** Loads and caches the file once. A missing or corrupt file reads as empty. */
  private load(): Record<string, unknown> {
    if (!this.data) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      } catch {
        parsed = undefined;
      }
      // A JSON scalar or array would break the key/value contract, so it counts
      // as corrupt rather than something to index into.
      this.data =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    }
    return this.data;
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.load()[key];
    return value === undefined ? defaultValue : (value as T);
  }

  /** Sets (or, for `undefined`, deletes) a key. Resolves once it is on disk. */
  update(key: string, value: unknown): Promise<void> {
    const store = this.load();
    if (value === undefined) delete store[key];
    else store[key] = value;
    this.dirty = true;
    return this.flush();
  }

  /** Resolves once every mutation made so far is durable. */
  flush(): Promise<void> {
    // Coalesce: a write that is still queued has not read the snapshot yet, so
    // it will pick up this mutation too.
    if (this.queued) return this.queued;
    const run = async () => {
      // Never let a failed write poison the chain for the next one.
      await this.chain.catch(() => undefined);
      // From here the snapshot is read, so later mutations need their own write.
      this.queued = undefined;
      await this.write();
    };
    const pending = run();
    this.queued = pending;
    this.chain = pending;
    return pending;
  }

  private async write(): Promise<void> {
    if (this.stopped) return; // flushSync() already wrote the final state
    const snapshot = JSON.stringify(this.load(), null, 2);
    this.dirty = false;
    try {
      // The beforeRename veto is this store's `stopped` re-check: flushSync()
      // may have run while this write was awaiting, and its snapshot is newer.
      await writeFileAtomic(this.file, snapshot, { beforeRename: () => !this.stopped });
    } catch (err) {
      this.dirty = true; // the mutation never reached disk — let a later flush retry
      throw err;
    }
  }

  /**
   * Last-chance synchronous write for app shutdown, where `will-quit` cannot
   * await anything. Any async write still in flight is neutered rather than
   * raced: JS is single-threaded, so it can only resume at an await point —
   * strictly after this returns — and it re-checks `stopped` before its own
   * rename, so a stale snapshot can never land on top of this one.
   */
  flushSync(): void {
    this.stopped = true;
    if (!this.data || !this.dirty) return;
    try {
      writeFileAtomicSync(this.file, JSON.stringify(this.data, null, 2));
      this.dirty = false;
    } catch {
      /* nothing left to do on the way out */
    }
  }
}
