/**
 * Durable JSON key/value store — the Electron-free half of stateStore.ts, split
 * out so it is unit-testable without an Electron runtime (the same split as
 * chat/secretCodec.ts under chat/secrets.ts).
 *
 * Two properties the naive "mutate an object, then writeFile the whole thing"
 * version lacked, both of which cost real user data:
 *
 * - **Atomic.** Every flush writes a sibling temp file, fsyncs it, and
 *   renames it over the target (atomic on POSIX and NTFS; a sibling so the
 *   rename never crosses a filesystem). A crash or a full disk can no longer
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
import * as path from "node:path";
import type { FileHandle } from "node:fs/promises";

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
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    // The pid keeps two processes from colliding on the temp name — the
    // single-instance lock makes that unlikely, but it is not free (the e2e
    // harness deliberately runs without the lock).
    const tmp = `${this.file}.${process.pid}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await fs.promises.open(tmp, "w");
      await handle.writeFile(snapshot, "utf8");
      // Durable before the rename, so a power loss cannot swap in an empty file.
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (this.stopped) {
        // flushSync() ran while this write was awaiting — its snapshot is newer.
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
        return;
      }
      await this.rename(tmp);
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
      this.dirty = true; // the mutation never reached disk — let a later flush retry
      throw err;
    }
  }

  /** On Windows an AV scanner or the search indexer can hold the target open for
   *  a moment; POSIX never hits this path. */
  private async rename(tmp: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(tmp, this.file);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
        if (attempt >= 3 || !transient) throw err;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
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
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* nothing left to do on the way out */
      }
    }
  }
}
