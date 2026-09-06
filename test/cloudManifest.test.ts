/**
 * services/cloud/manifestCore.ts — the staging cache's bookkeeping.
 *
 * Two properties carry real weight: a damaged manifest must degrade rather than
 * crash the launch, and eviction must never delete a document the user is about
 * to need (open in a tab, named by the stored session, or carrying a local
 * change that never reached the provider).
 */
import { describe, expect, it } from "vitest";
import {
  evictionCandidates,
  parseManifest,
  removeEntry,
  upsertEntry,
  type CloudEntry,
  type Manifest,
} from "../app/main/services/cloud/manifestCore";

const entry = (over: Partial<CloudEntry> = {}): CloudEntry => ({
  provider: "dropbox",
  accountId: "acct",
  itemId: "/a/bull.stp",
  name: "bull.stp",
  remoteRev: "r1",
  bytes: 1_000,
  syncedAt: 1_000,
  lastOpenedAt: 1_000,
  ...over,
});

describe("parseManifest", () => {
  it("round-trips a well-formed manifest", () => {
    const manifest: Manifest = { "dropbox/abc/bull.stp": entry() };
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it("reads a missing, scalar or array blob as empty", () => {
    expect(parseManifest(undefined)).toEqual({});
    expect(parseManifest(42)).toEqual({});
    expect(parseManifest([1, 2])).toEqual({});
  });

  it("drops only the entries it cannot understand", () => {
    const parsed = parseManifest({
      good: entry(),
      noProvider: { ...entry(), provider: "icloud" },
      noItem: { ...entry(), itemId: "" },
      notAnObject: "nonsense",
    });
    expect(Object.keys(parsed)).toEqual(["good"]);
  });

  it("repairs missing numbers rather than discarding the entry", () => {
    const parsed = parseManifest({
      k: { provider: "gdrive", accountId: "a", itemId: "i", name: "n", syncedAt: 5 },
    });
    expect(parsed.k.bytes).toBe(0);
    // lastOpenedAt falls back to syncedAt, so an old entry is not treated as
    // brand new and immune to age-based eviction.
    expect(parsed.k.lastOpenedAt).toBe(5);
  });

  it("keeps the dirty flag, which is what makes an interrupted upload recoverable", () => {
    expect(parseManifest({ k: { ...entry(), dirty: true } }).k.dirty).toBe(true);
    expect(parseManifest({ k: { ...entry(), dirty: "yes" } }).k.dirty).toBeUndefined();
  });
});

describe("upsert / remove", () => {
  it("does not mutate the input", () => {
    const before: Manifest = { a: entry() };
    const after = upsertEntry(before, "b", entry({ name: "other.stp" }));
    expect(Object.keys(before)).toEqual(["a"]);
    expect(Object.keys(after)).toEqual(["a", "b"]);
    expect(Object.keys(removeEntry(after, "a"))).toEqual(["b"]);
  });
});

describe("evictionCandidates", () => {
  const now = 10_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("evicts least-recently-opened first once over the size limit", () => {
    const manifest: Manifest = {
      old: entry({ lastOpenedAt: now - 3 * day, bytes: 100 }),
      middle: entry({ lastOpenedAt: now - 2 * day, bytes: 100 }),
      fresh: entry({ lastOpenedAt: now, bytes: 100 }),
    };
    expect(evictionCandidates(manifest, { now, maxBytes: 250, maxAgeMs: 0 })).toEqual(["old"]);
    expect(evictionCandidates(manifest, { now, maxBytes: 150, maxAgeMs: 0 })).toEqual([
      "old",
      "middle",
    ]);
  });

  it("evicts nothing while inside the budget", () => {
    const manifest: Manifest = { a: entry({ bytes: 10 }) };
    expect(evictionCandidates(manifest, { now, maxBytes: 1_000, maxAgeMs: 0 })).toEqual([]);
  });

  it("evicts by age even when the cache is small", () => {
    const manifest: Manifest = {
      stale: entry({ lastOpenedAt: now - 40 * day, bytes: 1 }),
      recent: entry({ lastOpenedAt: now - day, bytes: 1 }),
    };
    expect(evictionCandidates(manifest, { now, maxBytes: 1e9, maxAgeMs: 30 * day })).toEqual([
      "stale",
    ]);
  });

  it("never evicts a kept or dirty entry, whatever the pressure", () => {
    const manifest: Manifest = {
      open: entry({ lastOpenedAt: 0, bytes: 1_000 }),
      unsaved: entry({ lastOpenedAt: 0, bytes: 1_000, dirty: true }),
      spare: entry({ lastOpenedAt: 1, bytes: 1_000 }),
    };
    // Budget of zero: everything evictable must go, and nothing else may.
    const doomed = evictionCandidates(manifest, {
      now,
      maxBytes: 0,
      maxAgeMs: day,
      keep: new Set(["open"]),
    });
    expect(doomed).toEqual(["spare"]);
  });
});
