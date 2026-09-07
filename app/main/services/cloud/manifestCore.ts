/**
 * The staging cache's manifest: what each local copy is a copy *of*, what
 * revision it was at when we last synced, and whether it carries a local change
 * that never reached the provider. Pure — the fs/JsonStore glue is in
 * stagingCache.ts (the recentFilesCore/recentFiles split).
 *
 * Keyed by the cache-relative path of the *document* (`cacheRelPath`), so one
 * entry owns one staging directory. Sidecars are not tracked individually:
 * they belong to whichever document shares their directory.
 *
 * `parseManifest` is deliberately tolerant, the same way `parseRecentFiles` is:
 * a hand-edited or half-written manifest degrades to "these entries are gone",
 * never to a crash on launch.
 */
import type { ProviderId } from "./cloudCore";

export interface CloudEntry {
  provider: ProviderId;
  accountId: string;
  itemId: string;
  parentId?: string;
  /** The remote name, which may differ from the sanitized local one. */
  name: string;
  /** Baseline for the conflict check — the revision we downloaded. */
  remoteRev?: string;
  /** The provider's conditional-write token for that revision, where it differs
   *  from `remoteRev` (Graph's eTag vs cTag). */
  remotePrecondition?: string;
  remoteHash?: string;
  bytes: number;
  syncedAt: number;
  lastOpenedAt: number;
  /** A local change that has not landed remotely. Survives a crash, which is
   *  what makes an interrupted upload recoverable instead of silent. */
  dirty?: boolean;
}

export type Manifest = Record<string, CloudEntry>;

const PROVIDERS = new Set(["gdrive", "dropbox", "onedrive"]);

function parseEntry(value: unknown): CloudEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.provider !== "string" || !PROVIDERS.has(v.provider)) return undefined;
  if (typeof v.accountId !== "string" || !v.accountId) return undefined;
  if (typeof v.itemId !== "string" || !v.itemId) return undefined;
  if (typeof v.name !== "string" || !v.name) return undefined;
  const num = (x: unknown, fallback: number) =>
    typeof x === "number" && Number.isFinite(x) ? x : fallback;
  return {
    provider: v.provider as ProviderId,
    accountId: v.accountId,
    itemId: v.itemId,
    parentId: typeof v.parentId === "string" ? v.parentId : undefined,
    name: v.name,
    remoteRev: typeof v.remoteRev === "string" ? v.remoteRev : undefined,
    remotePrecondition: typeof v.remotePrecondition === "string" ? v.remotePrecondition : undefined,
    remoteHash: typeof v.remoteHash === "string" ? v.remoteHash : undefined,
    bytes: Math.max(0, num(v.bytes, 0)),
    syncedAt: num(v.syncedAt, 0),
    lastOpenedAt: num(v.lastOpenedAt, num(v.syncedAt, 0)),
    dirty: v.dirty === true ? true : undefined,
  };
}

/** Drops only the entries it cannot understand, never the whole file. */
export function parseManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Manifest = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = parseEntry(value);
    if (entry) out[key] = entry;
  }
  return out;
}

export function upsertEntry(manifest: Manifest, key: string, entry: CloudEntry): Manifest {
  return { ...manifest, [key]: entry };
}

export function removeEntry(manifest: Manifest, key: string): Manifest {
  const { [key]: _dropped, ...rest } = manifest;
  return rest;
}

export interface EvictionOptions {
  now: number;
  maxBytes: number;
  maxAgeMs: number;
  /** Keys that must survive: open in a tab, or named by the stored session.
   *  Without this a restore could find its documents gone. */
  keep?: ReadonlySet<string>;
}

/**
 * Least-recently-opened first, and never an entry that is kept, dirty, or
 * young enough to still be under the size limit. Returns document keys; the
 * caller deletes each one's whole staging directory as a unit, so a partial
 * eviction (a model without its sidecars) is never emitted.
 */
export function evictionCandidates(manifest: Manifest, options: EvictionOptions): string[] {
  const keep = options.keep ?? new Set<string>();
  const evictable = Object.entries(manifest)
    .filter(([key, entry]) => !keep.has(key) && !entry.dirty)
    .sort((a, b) => a[1].lastOpenedAt - b[1].lastOpenedAt);

  const doomed = new Set<string>();
  for (const [key, entry] of evictable) {
    if (options.maxAgeMs > 0 && options.now - entry.lastOpenedAt > options.maxAgeMs) {
      doomed.add(key);
    }
  }
  // Size is measured over everything still present, kept entries included —
  // the limit is a cache-size budget, not an "evictable bytes" budget.
  let total = Object.entries(manifest)
    .filter(([key]) => !doomed.has(key))
    .reduce((sum, [, entry]) => sum + entry.bytes, 0);
  for (const [key, entry] of evictable) {
    if (total <= options.maxBytes) break;
    if (doomed.has(key)) continue;
    doomed.add(key);
    total -= entry.bytes;
  }
  return evictable.filter(([key]) => doomed.has(key)).map(([key]) => key);
}
