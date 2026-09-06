/**
 * The on-disk staging cache: downloads a remote document (and its sidecars)
 * into a directory of its own, and remembers what it is a copy of.
 *
 * `<userData>/cloud-cache/<provider>/<opaqueId>/<original filename>` — the path
 * derivation and the sidecar rules are pure (cachePathCore), this file is the
 * fs and JsonStore glue, the recentFilesCore/recentFiles split.
 *
 * The manifest is a `JsonStore` instance rather than a hand-rolled file: it
 * needs exactly what that class already provides — atomic writes, its own
 * writer chain, and a `flushSync()` for `will-quit` — the same way each chat
 * transcript gets its own store.
 *
 * **`allowRoot()` is deliberately not called here.** `CadHost.openPath` already
 * allow-lists `path.dirname(fsPath)`, and the staged path's dirname *is* the
 * per-document staging directory, so a webview can reach exactly the document
 * it opened. Allow-listing `cloud-cache/` itself would make every cached
 * document from every account fetchable by any webview — the same mistake the
 * project-root invariant exists to avoid.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { JsonStore } from "../jsonStore";
import {
  cacheDirRelPath,
  cacheRelPath,
  sanitizeFileName,
  sidecarNamesFor,
} from "./cachePathCore";
import { CloudError, DEFAULT_CACHE_LIMIT_MB, type CloudRef } from "./cloudCore";
import type { CloudProvider, TransferOptions } from "./cloudProvider";
import {
  evictionCandidates,
  parseManifest,
  type CloudEntry,
  type Manifest,
} from "./manifestCore";

const MANIFEST_KEY = "entries";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface StagedDocument {
  /** Manifest key, and the cache-relative path of the document. */
  key: string;
  /** Absolute path handed to `openFile()` — the only path the app ever sees. */
  localPath: string;
  dir: string;
  fileName: string;
}

export class StagingCache {
  private readonly store: JsonStore;

  constructor(private readonly root: string) {
    this.store = new JsonStore(path.join(root, "manifest.json"));
  }

  manifest(): Manifest {
    return parseManifest(this.store.get(MANIFEST_KEY));
  }

  entry(key: string): CloudEntry | undefined {
    return this.manifest()[key];
  }

  saveEntry(key: string, entry: CloudEntry): void {
    void this.store.update(MANIFEST_KEY, { ...this.manifest(), [key]: entry });
  }

  removeEntry(key: string): void {
    const { [key]: _dropped, ...rest } = this.manifest();
    void this.store.update(MANIFEST_KEY, rest);
  }

  /** `will-quit` cannot await; this is the manifest's last synchronous write. */
  flushSync(): void {
    this.store.flushSync();
  }

  /** Where a ref's document would live, whether or not it has been fetched. */
  localPathFor(ref: CloudRef): string {
    return path.join(this.root, cacheRelPath(ref));
  }

  documentFor(ref: CloudRef): StagedDocument {
    const key = cacheRelPath(ref);
    const dir = path.join(this.root, cacheDirRelPath(ref));
    return { key, dir, fileName: sanitizeFileName(ref.name), localPath: path.join(this.root, key) };
  }

  /** True when the local copy is still on disk (an eviction removes it). */
  isStaged(ref: CloudRef): boolean {
    return fs.existsSync(this.localPathFor(ref));
  }

  /**
   * Downloads the document and every sidecar that exists beside it remotely,
   * then records the baseline revision the conflict check compares against.
   *
   * Pulling the sidecars is not optional: without them cad opens a cloud model
   * with an empty edit history and no parts, which looks like data loss.
   */
  async stage(
    provider: CloudProvider,
    ref: CloudRef,
    options: TransferOptions = {}
  ): Promise<StagedDocument> {
    const doc = this.documentFor(ref);
    const remote = await provider.stat(ref.itemId);
    if (remote.isFolder) {
      throw new CloudError("other", `${ref.name} is a folder, not a file.`);
    }
    await fs.promises.mkdir(doc.dir, { recursive: true });
    await provider.download(remote, doc.localPath, options);

    const parentId = ref.parentId ?? remote.parentId;
    if (parentId) await this.stageSidecars(provider, parentId, doc, options.signal);

    const now = Date.now();
    this.saveEntry(doc.key, {
      provider: ref.provider,
      accountId: ref.accountId,
      itemId: ref.itemId,
      parentId,
      name: remote.name,
      remoteRev: remote.rev,
      remotePrecondition: remote.precondition,
      remoteHash: remote.hash,
      bytes: remote.size ?? 0,
      syncedAt: now,
      lastOpenedAt: now,
    });
    return doc;
  }

  /** Refreshes lastOpenedAt so LRU eviction reflects real use. */
  touch(key: string): void {
    const entry = this.entry(key);
    if (entry) this.saveEntry(key, { ...entry, lastOpenedAt: Date.now() });
  }

  private async stageSidecars(
    provider: CloudProvider,
    parentId: string,
    doc: StagedDocument,
    signal?: AbortSignal
  ): Promise<void> {
    // One listing beats N lookups, and the sidecar set is small and known.
    const wanted = new Set(sidecarNamesFor(doc.fileName));
    let pageToken: string | undefined;
    do {
      const page = await provider.list(parentId, pageToken);
      for (const file of page.files) {
        if (file.isFolder || !wanted.has(file.name)) continue;
        // A sidecar that fails to download is not worth failing the open for —
        // the viewer treats a missing one as "no edits yet", which is right.
        await provider
          .download(file, path.join(doc.dir, sanitizeFileName(file.name)), { signal })
          .catch(() => undefined);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  /**
   * Deletes least-recently-opened staging directories once the cache is over
   * budget or an entry has gone stale.
   *
   * `keep` must carry every path that is open in a tab or named by the stored
   * session — without it a restore could find its documents gone. A dirty entry
   * is never evicted regardless, because it holds the only copy of a change
   * that never reached the provider.
   */
  async evict(keep: ReadonlySet<string>, limitMb: number = DEFAULT_CACHE_LIMIT_MB): Promise<void> {
    const manifest = this.manifest();
    const doomed = evictionCandidates(manifest, {
      now: Date.now(),
      maxBytes: Math.max(0, limitMb) * 1024 * 1024,
      maxAgeMs: MAX_AGE_MS,
      keep,
    });
    if (!doomed.length) return;
    const next = { ...manifest };
    for (const key of doomed) {
      // The whole directory, so a model is never left without its sidecars.
      await fs.promises
        .rm(path.dirname(path.join(this.root, key)), { recursive: true, force: true })
        .catch(() => undefined);
      delete next[key];
    }
    void this.store.update(MANIFEST_KEY, next);
  }

  /** Settings ▸ Cloud Accounts ▸ Disconnect / Clear Cloud Cache. */
  async clear(provider?: string): Promise<void> {
    const manifest = this.manifest();
    const next: Manifest = {};
    for (const [key, entry] of Object.entries(manifest)) {
      if (provider && entry.provider !== provider) next[key] = entry;
    }
    await fs.promises
      .rm(provider ? path.join(this.root, provider) : this.root, { recursive: true, force: true })
      .catch(() => undefined);
    void this.store.update(MANIFEST_KEY, next);
  }

  /** Entries carrying a local change that never reached the provider. */
  dirtyEntries(): Array<{ key: string; entry: CloudEntry }> {
    return Object.entries(this.manifest())
      .filter(([, entry]) => entry.dirty)
      .map(([key, entry]) => ({ key, entry }));
  }
}
