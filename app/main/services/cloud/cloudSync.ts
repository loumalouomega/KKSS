/**
 * Write-back: notices that a staged document or one of its sidecars changed on
 * disk, and pushes it to the provider.
 *
 * **Watcher-driven, not host-driven, and that is forced rather than chosen.**
 * `mesh/src/meshExport.ts`'s `saveMesh()` overwrites the document in place with
 * a bare `fs.promises.writeFile` *inside the submodule* and never reports the
 * path back to `MeshHost`, and the zero-modification invariant forbids changing
 * it. So a save can be observed but never intercepted. One directory watch
 * covers everything at once: cad's eight sidecar writers, mesh's in-place save,
 * a mesh export aimed back into the directory, and `EditorService` saving a
 * staged text file — none of which share a code path.
 *
 * Its `depth: 0` is a real limit, not an oversight: mesh's XDMF `.h5` companion
 * is a *sibling* and is covered, but OpenFOAM's nested `constant/polyMesh/`
 * tree is not, and is deliberately not uploaded rather than half-uploaded.
 *
 * Everything is injected — provider lookup, manifest access, the watcher
 * factory, the clock, the toast sink — so this module imports no Electron and
 * `test/cloudSync.test.ts` can drive the whole engine against a real temp
 * directory, real chokidar and a recording fake provider.
 */
import * as path from "node:path";
import { CLOUD_UPLOAD_DEBOUNCE_MS, CloudError, type ProviderId } from "./cloudCore";
import type { CloudProvider } from "./cloudProvider";
import { conflictName, decideUpload } from "./conflictCore";
import { isSidecarOf, isStagingArtifact } from "./cachePathCore";
import type { CloudEntry } from "./manifestCore";

/** One staged document plus the directory that holds it and its sidecars. */
export interface SyncTarget {
  /** Manifest key — the cache-relative path of the document. */
  key: string;
  /** Absolute staging directory. Holds exactly this document and its sidecars. */
  dir: string;
  /** Local (sanitized) file name of the document itself. */
  fileName: string;
}

export interface WatchHandle {
  dispose(): void;
}

export interface CloudSyncDeps {
  provider(id: ProviderId): CloudProvider | undefined;
  entry(key: string): CloudEntry | undefined;
  /** Persists an updated entry (the manifest JsonStore, atomically). */
  saveEntry(key: string, entry: CloudEntry): void;
  /** Watches one directory, non-recursively, reporting changed basenames. */
  watch(dir: string, onChange: (name: string) => void): WatchHandle;
  toast(kind: "info" | "warning" | "error", text: string): void;
  now?(): number;
  debounceMs?: number;
}

interface Tracked extends SyncTarget {
  watcher: WatchHandle;
  /** Basenames changed since the last pass. */
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes passes for this directory; never rejects. */
  chain: Promise<void>;
  /** Passes started but not finished. A promise-valued `chain` cannot answer
   *  "is anything running?" — it stays settled-but-present forever. */
  inFlight: number;
}

export class CloudSync {
  private readonly tracked = new Map<string, Tracked>();
  private readonly debounceMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: CloudSyncDeps) {
    this.debounceMs = deps.debounceMs ?? CLOUD_UPLOAD_DEBOUNCE_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Starts watching a staged document's directory. Idempotent per key. */
  track(target: SyncTarget): void {
    if (this.tracked.has(target.key)) return;
    const state: Tracked = {
      ...target,
      pending: new Set(),
      timer: undefined,
      chain: Promise.resolve(),
      inFlight: 0,
      watcher: this.deps.watch(target.dir, (name) => this.onChanged(target.key, name)),
    };
    this.tracked.set(target.key, state);
  }

  /** Stops watching. A pending upload is left to finish — a closed tab must not
   *  discard a change the user already made. */
  untrack(key: string): void {
    const state = this.tracked.get(key);
    if (!state) return;
    state.watcher.dispose();
    this.tracked.delete(key);
    if (state.pending.size || state.inFlight > 0) {
      // Re-queue it detached, so the bytes still reach the provider.
      void this.runPass(state).catch(() => undefined);
    }
  }

  hasPending(): boolean {
    for (const state of this.tracked.values()) {
      if (state.pending.size > 0 || state.inFlight > 0) return true;
    }
    return false;
  }

  /** File ▸ Save — upload everything now instead of waiting out the debounce. */
  saveNow(): Promise<void> {
    for (const state of this.tracked.values()) {
      // Save means "push what is on disk", even if nothing fired a watch event
      // (a rewrite with identical bytes still counts as the user asking).
      state.pending.add(state.fileName);
    }
    return this.flushPending();
  }

  /** Resolves once every queued and in-flight upload has finished. */
  async flushPending(): Promise<void> {
    const passes: Promise<void>[] = [];
    for (const state of this.tracked.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      passes.push(this.runPass(state));
    }
    await Promise.all(passes);
  }

  dispose(): void {
    for (const state of this.tracked.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.watcher.dispose();
    }
    this.tracked.clear();
  }

  private onChanged(key: string, name: string): void {
    const state = this.tracked.get(key);
    // Our own atomic-write temps and in-flight downloads are not user edits.
    if (!state || isStagingArtifact(name)) return;
    if (name !== state.fileName && !isSidecarOf(state.fileName, name)) return;
    state.pending.add(name);
    this.markDirty(key);
    if (state.timer) clearTimeout(state.timer);
    // Per directory, not per file: a burst of six sidecar writes coalesces into
    // one pass, which is also what swallows cadHost's own 500 ms debounce.
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.runPass(state).catch(() => undefined);
    }, this.debounceMs);
  }

  private markDirty(key: string): void {
    const entry = this.deps.entry(key);
    if (entry && !entry.dirty) this.deps.saveEntry(key, { ...entry, dirty: true });
  }

  /** Serialized per directory: a second pass waits for the one in flight. */
  private runPass(state: Tracked): Promise<void> {
    state.inFlight++;
    const run = state.chain.then(() => this.uploadPending(state));
    state.chain = run.then(
      () => undefined,
      () => undefined
    );
    // Decrementing on the chain (not on `run`) keeps the count accurate even
    // when the caller never awaits the promise we hand back.
    state.chain = state.chain.then(() => {
      state.inFlight--;
    });
    return run;
  }

  private async uploadPending(state: Tracked): Promise<void> {
    const names = [...state.pending];
    if (!names.length) return;
    state.pending.clear();

    const entry = this.deps.entry(state.key);
    if (!entry) return; // evicted or never staged — nothing to push to
    const provider = this.deps.provider(entry.provider);
    if (!provider) {
      this.deps.toast("warning", `Not connected to ${entry.provider}; ${entry.name} was not uploaded.`);
      return;
    }

    try {
      let updated = entry;
      if (names.includes(state.fileName)) {
        updated = await this.uploadDocument(provider, state, updated);
      }
      for (const name of names) {
        if (name === state.fileName) continue;
        await this.uploadSidecar(provider, state, updated, name);
      }
      this.deps.saveEntry(state.key, { ...updated, dirty: false, syncedAt: this.now() });
    } catch (err) {
      // Re-queue everything this pass drained, not just the document: a sidecar
      // dropped here would never be retried while the entry stayed dirty
      // forever — which also pins it against eviction.
      for (const name of names) state.pending.add(name);
      const detail = err instanceof CloudError ? err.message : String(err);
      this.deps.toast("error", `Could not upload ${entry.name}: ${detail}`);
    }
  }

  /**
   * The conflict rule, in one place: the local file is never touched and the
   * remote is never overwritten when the two have diverged.
   */
  private async uploadDocument(
    provider: CloudProvider,
    state: Tracked,
    entry: CloudEntry
  ): Promise<CloudEntry> {
    const localPath = path.join(state.dir, state.fileName);
    const remote = await provider.stat(entry.itemId);
    const parentId = entry.parentId ?? remote.parentId;

    if (decideUpload({ storedRev: entry.remoteRev, remoteRev: remote.rev }) === "upload") {
      const written = await provider.upload(entry.itemId, localPath, {
        precondition: entry.remotePrecondition,
      });
      return { ...entry, parentId, ...baselineOf(written), bytes: written.size ?? entry.bytes };
    }

    if (!parentId) {
      throw new CloudError(
        "conflict",
        `${entry.name} changed on the provider and KKSS does not know which folder to put a ` +
          `conflict copy in. Your local copy is untouched.`
      );
    }
    const copy = conflictName(entry.name, new Date(this.now()));
    await provider.create(parentId, copy, localPath);
    this.deps.toast(
      "warning",
      `${entry.name} changed on ${provider.label} since KKSS last synced it. Your copy was kept ` +
        `and uploaded as "${copy}".`
    );
    // Adopt the remote's current revision as the new baseline, or every
    // subsequent tick would produce another conflict copy forever.
    return { ...entry, parentId, ...baselineOf(remote) };
  }

  /** A sidecar may not exist remotely yet, so this is find-then-create. */
  private async uploadSidecar(
    provider: CloudProvider,
    state: Tracked,
    entry: CloudEntry,
    name: string
  ): Promise<void> {
    if (!entry.parentId) return;
    const localPath = path.join(state.dir, name);
    const existing = await provider.findChild(entry.parentId, name);
    if (!existing) {
      await provider.create(entry.parentId, name, localPath);
      return;
    }
    // Sidecars are derived state, so a remote change to one is not worth a
    // conflict copy — the local viewer's version is the authoritative one.
    await provider.upload(existing.id, localPath, { precondition: existing.precondition });
  }
}

function baselineOf(file: { rev?: string; precondition?: string; hash?: string }) {
  return {
    remoteRev: file.rev,
    remotePrecondition: file.precondition,
    remoteHash: file.hash,
  };
}
