/**
 * The one object `index.ts` and `menu.ts` talk to. Owns the three providers,
 * the staging cache, the sync engine, and the quick-pick file browser.
 *
 * Credentials follow the meta server's precedent exactly (`META_SERVER_KEYS`,
 * `ensureMetaServerToken`, the lazy `() => getSecret(...)` getter): the client
 * ID is a plain stateStore value because OAuth treats it as public, while the
 * client secret and the refresh token go through `chat/secrets.ts` and are
 * safeStorage-encrypted. **No KKSS-owned client id is baked in** — the user
 * brings their own, which is why every action degrades to "set a client ID
 * first" rather than to a confusing provider error.
 */
import * as path from "node:path";
import { app } from "electron";
import { stateStore } from "../stateStore";
import { getSecret, setSecret } from "../chat/secrets";
import { showQuickPick } from "../quickPick";
import { toast } from "../notifications";
import { createFileSystemWatcher } from "../watcher";
import {
  CLOUD_KEYS,
  CloudError,
  DEFAULT_CACHE_LIMIT_MB,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  parseAccount,
  type CloudAccount,
  type CloudFile,
  type CloudRef,
  type ProviderId,
} from "./cloudCore";
import type { CloudProvider, ProviderStore, TransferOptions } from "./cloudProvider";
import { DropboxProvider } from "./providers/dropbox";
import { GoogleDriveProvider } from "./providers/gdrive";
import { OneDriveProvider } from "./providers/onedrive";
import { StagingCache, type StagedDocument } from "./stagingCache";
import { CloudSync } from "./cloudSync";

export interface CloudStatus {
  id: ProviderId;
  label: string;
  needsClientSecret: boolean;
  hasClientId: boolean;
  hasClientSecret: boolean;
  connected: boolean;
  account?: CloudAccount;
}

type RowKind = "up" | "item" | "more" | "empty";

/** How a staged path is described to the tab strip, recents and the assistant. */
export interface CloudOrigin {
  provider: ProviderId;
  providerLabel: string;
  name: string;
  accountId: string;
  itemId: string;
}

export class CloudService {
  private readonly providers = new Map<ProviderId, CloudProvider>();
  private readonly cache: StagingCache;
  private readonly sync: CloudSync;
  private readonly listeners = new Set<() => void>();

  constructor(userDataDir: string = app.getPath("userData")) {
    this.cache = new StagingCache(path.join(userDataDir, "cloud-cache"));
    for (const id of PROVIDER_IDS) this.providers.set(id, makeProvider(id, storeFor(id)));
    this.sync = new CloudSync({
      provider: (id) => (this.providers.get(id)?.isConnected() ? this.providers.get(id) : undefined),
      entry: (key) => this.cache.entry(key),
      saveEntry: (key, entry) => this.cache.saveEntry(key, entry),
      watch: (dir, onChange) => {
        // The bare `*` pattern exists for exactly this: any write into a staged
        // directory counts, because a mesh save happens inside the submodule.
        const watcher = createFileSystemWatcher(dir, "*");
        const subs = [
          watcher.onDidChange((p) => onChange(path.basename(p))),
          watcher.onDidCreate((p) => onChange(path.basename(p))),
        ];
        return {
          dispose() {
            for (const sub of subs) sub.dispose();
            watcher.dispose();
          },
        };
      },
      toast,
    });
  }

  onDidChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- Accounts ------------------------------------------------------------

  statuses(): CloudStatus[] {
    return PROVIDER_IDS.map((id) => {
      const provider = this.providers.get(id)!;
      return {
        id,
        label: provider.label,
        needsClientSecret: provider.needsClientSecret,
        hasClientId: stateStore.get<string>(CLOUD_KEYS.clientId(id)) !== undefined,
        hasClientSecret: getSecret(CLOUD_KEYS.clientSecret(id)) !== undefined,
        connected: provider.isConnected(),
        account: provider.account(),
      };
    });
  }

  connected(): CloudStatus[] {
    return this.statuses().filter((s) => s.connected);
  }

  isConnected(): boolean {
    return this.connected().length > 0;
  }

  async connect(id: ProviderId): Promise<void> {
    const provider = this.providers.get(id);
    if (!provider) return;
    try {
      const account = await provider.connect();
      toast("info", `Connected to ${provider.label} as ${account.label}.`);
    } catch (err) {
      toast("error", describe(err));
    }
    this.changed();
  }

  async disconnect(id: ProviderId, clearCache: boolean): Promise<void> {
    await this.providers.get(id)?.disconnect();
    if (clearCache) await this.cache.clear(id);
    this.changed();
  }

  async setClientId(id: ProviderId, value: string | undefined): Promise<void> {
    await stateStore.update(CLOUD_KEYS.clientId(id), value || undefined);
    this.changed();
  }

  async setClientSecret(id: ProviderId, value: string): Promise<void> {
    await setSecret(CLOUD_KEYS.clientSecret(id), value);
    this.changed();
  }

  /** The exact loopback URI a provider console has to be told about. */
  redirectHint(id: ProviderId): string {
    return id === "dropbox"
      ? "http://127.0.0.1:53682/callback"
      : "http://127.0.0.1:<any port>/callback";
  }

  // ---- Browsing ------------------------------------------------------------

  /**
   * File ▸ Open from Cloud… — a quick-pick folder drill-down.
   *
   * Deliberately not a WebContentsView: a browser view would need a generated
   * page, a CSP, an IPC channel and `wireView()`'s crash-recovery policy, for a
   * list of names. The cost is real (no search, no thumbnails, one modal per
   * level) and is documented rather than hidden.
   */
  async browse(): Promise<CloudRef | undefined> {
    const connected = this.connected();
    if (!connected.length) return undefined;
    const chosen =
      connected.length === 1
        ? connected[0]
        : await pickOne(
            connected.map((s) => ({
              label: s.label,
              description: s.account?.label,
              status: s,
            })),
            "Open from Cloud"
          ).then((r) => r?.status);
    if (!chosen) return undefined;
    const provider = this.providers.get(chosen.id)!;
    return this.drillDown(provider, chosen);
  }

  private async drillDown(
    provider: CloudProvider,
    status: CloudStatus
  ): Promise<CloudRef | undefined> {
    type Row = { label: string; description?: string; kind: RowKind; file?: CloudFile };
    const trail: Array<{ id: string | undefined; label: string }> = [
      { id: undefined, label: provider.label },
    ];
    let pageToken: string | undefined;
    let accumulated: CloudFile[] = [];

    for (;;) {
      const here = trail[trail.length - 1];
      let page;
      try {
        page = await provider.list(here.id, pageToken);
      } catch (err) {
        toast("error", describe(err));
        return undefined;
      }
      accumulated = pageToken ? [...accumulated, ...page.files] : page.files;

      const items: Row[] = [
        ...(trail.length > 1
          ? [{ label: "⬆  ..", description: "Parent folder", kind: "up" as RowKind }]
          : []),
        ...accumulated.map((file) => ({
          label: file.isFolder ? `📁  ${file.name}` : file.name,
          description: file.isFolder ? undefined : sizeLabel(file.size),
          kind: "item" as RowKind,
          file,
        })),
        ...(page.nextPageToken
          ? [{ label: "Load more…", description: "This folder has more items", kind: "more" as RowKind }]
          : []),
      ];
      // An empty folder still needs a row, or the picker shows nothing at all
      // and the user cannot tell it apart from a failed listing.
      if (items.length === 0) items.push({ label: "(empty folder)", kind: "empty" });

      const picked = await pickOne(items, trail.map((t) => t.label).join(" / "));
      if (!picked || picked.kind === "empty") return undefined;
      if (picked.kind === "up") {
        trail.pop();
        pageToken = undefined;
        accumulated = [];
        continue;
      }
      if (picked.kind === "more") {
        pageToken = page.nextPageToken;
        continue;
      }
      const file = picked.file!;
      if (file.isFolder) {
        trail.push({ id: file.id, label: file.name });
        pageToken = undefined;
        accumulated = [];
        continue;
      }
      return {
        provider: provider.id,
        accountId: status.account?.id ?? "",
        itemId: file.id,
        name: file.name,
        parentId: file.parentId ?? here.id,
        folder: trail.map((t) => t.label).join(" / "),
      };
    }
  }

  // ---- Staging -------------------------------------------------------------

  /** Downloads a document (and its sidecars) and returns the local path. */
  async stage(ref: CloudRef, options: TransferOptions = {}): Promise<string> {
    const provider = this.providers.get(ref.provider);
    if (!provider?.isConnected()) {
      throw new CloudError("auth", `Not connected to ${PROVIDER_LABELS[ref.provider]}.`);
    }
    const doc = await this.cache.stage(provider, ref, options);
    this.sync.track(doc);
    return doc.localPath;
  }

  /**
   * Starts syncing a local path that is already a staging copy — the entry
   * point for opens that never went through `stage()`/`stagedPath()`: session
   * restore, and a crash replay. Without it a restored cloud tab would show the
   * ☁ mark but never upload a single edit.
   */
  trackIfStaged(localPath: string): void {
    const found = this.entryForPath(localPath);
    if (!found) return;
    this.cache.touch(found.key);
    this.sync.track({
      key: found.key,
      dir: path.dirname(localPath),
      fileName: path.basename(localPath),
    });
  }

  /** Stops syncing a staged path; a pending upload is still finished. */
  untrackPath(localPath: string): void {
    const found = this.entryForPath(localPath);
    if (found) this.sync.untrack(found.key);
  }

  /** A ref already staged and still on disk — reopened without a download. */
  stagedPath(ref: CloudRef): string | undefined {
    if (!this.cache.isStaged(ref)) return undefined;
    const doc = this.cache.documentFor(ref);
    this.cache.touch(doc.key);
    this.sync.track(doc);
    return doc.localPath;
  }

  /** What `localPath` is a copy of, or undefined when it is an ordinary file. */
  describe(localPath: string): CloudOrigin | undefined {
    const found = this.entryForPath(localPath);
    if (!found) return undefined;
    return {
      provider: found.entry.provider,
      providerLabel: PROVIDER_LABELS[found.entry.provider],
      name: found.entry.name,
      accountId: found.entry.accountId,
      itemId: found.entry.itemId,
    };
  }

  describeAll(paths: string[]): Record<string, CloudOrigin> {
    const out: Record<string, CloudOrigin> = {};
    for (const p of paths) {
      const origin = this.describe(p);
      if (origin) out[p] = origin;
    }
    return out;
  }

  private entryForPath(localPath: string) {
    const manifest = this.cache.manifest();
    for (const [key, entry] of Object.entries(manifest)) {
      if (path.resolve(this.cache.localPathFor({ ...entry })) === path.resolve(localPath)) {
        return { key, entry };
      }
    }
    return undefined;
  }

  // ---- Write-back ----------------------------------------------------------

  saveNow(): Promise<void> {
    return this.sync.saveNow();
  }

  hasPending(): boolean {
    return this.sync.hasPending();
  }

  flushPending(): Promise<void> {
    return this.sync.flushPending();
  }

  /** `will-quit`: the manifest's last synchronous write. Uploads cannot be
   *  completed here — that is what the `before-quit` drain is for. */
  flushSync(): void {
    this.sync.dispose();
    this.cache.flushSync();
  }

  /** Re-offers uploads that a crash or a timed-out drain left behind. */
  reportUnsynced(): void {
    const dirty = this.cache.dirtyEntries();
    if (!dirty.length) return;
    const names = dirty.map((d) => d.entry.name).join(", ");
    toast(
      "warning",
      `${dirty.length} cloud file(s) have local changes that never reached the provider: ${names}. ` +
        `They are safe in the staging cache — open one and save to retry.`
    );
  }

  cacheLimitMb(): number {
    const value = stateStore.get<number>(CLOUD_KEYS.cacheLimitMb);
    return typeof value === "number" && value > 0 ? value : DEFAULT_CACHE_LIMIT_MB;
  }

  async setCacheLimitMb(value: number | undefined): Promise<void> {
    await stateStore.update(CLOUD_KEYS.cacheLimitMb, value);
    this.changed();
  }

  /** `keep` must name every open and session-referenced local path. */
  async evict(keepPaths: readonly string[]): Promise<void> {
    const keep = new Set<string>();
    for (const p of keepPaths) {
      const found = this.entryForPath(p);
      if (found) keep.add(found.key);
    }
    // Stop watching a directory before deleting it, or its watcher outlives the
    // files and the tracked target lingers for the process lifetime.
    const before = new Set(Object.keys(this.cache.manifest()));
    await this.cache.evict(keep, this.cacheLimitMb());
    for (const key of before) {
      if (!this.cache.entry(key)) this.sync.untrack(key);
    }
    this.changed();
  }

  async clearCache(): Promise<void> {
    for (const key of Object.keys(this.cache.manifest())) this.sync.untrack(key);
    await this.cache.clear();
    this.changed();
  }
}

function storeFor(id: ProviderId): ProviderStore {
  return {
    clientId: () => stateStore.get<string>(CLOUD_KEYS.clientId(id)),
    clientSecret: () => getSecret(CLOUD_KEYS.clientSecret(id)),
    refreshToken: () => getSecret(CLOUD_KEYS.refreshToken(id)),
    setRefreshToken: (value) => setSecret(CLOUD_KEYS.refreshToken(id), value ?? ""),
    account: () => parseAccount(stateStore.get(CLOUD_KEYS.account(id))),
    setAccount: (value) => stateStore.update(CLOUD_KEYS.account(id), value),
  };
}

function makeProvider(id: ProviderId, store: ProviderStore): CloudProvider {
  switch (id) {
    case "gdrive":
      return new GoogleDriveProvider(store);
    case "dropbox":
      return new DropboxProvider(store);
    case "onedrive":
      return new OneDriveProvider(store);
  }
}

async function pickOne<T extends { label: string; description?: string }>(
  items: T[],
  title: string
): Promise<T | undefined> {
  return showQuickPick(items, { title });
}

function sizeLabel(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function describe(err: unknown): string {
  return err instanceof CloudError ? err.message : err instanceof Error ? err.message : String(err);
}

export type { StagedDocument };
