/**
 * services/cloud/cloudSync.ts — the write-back engine, driven end to end
 * against a real temp directory, real chokidar (via services/watcher.ts, the
 * same factory the app uses) and a recording fake provider.
 *
 * This is the highest-value test in the feature: everything it asserts is a
 * property that would otherwise only show up as a user's overwritten Drive file
 * or a folder full of spurious "(conflict …)" copies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CloudSync, type CloudSyncDeps, type SyncTarget } from "../app/main/services/cloud/cloudSync";
import type { CloudEntry, Manifest } from "../app/main/services/cloud/manifestCore";
import type { CloudFile } from "../app/main/services/cloud/cloudCore";
import type { CloudProvider } from "../app/main/services/cloud/cloudProvider";
import { createFileSystemWatcher } from "../app/main/services/watcher";

const DEBOUNCE = 40;
/** chokidar needs a moment to see a write; generous, so CI is not flaky. */
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
/** chokidar ignores writes that land during its initial scan, so a watch is
 *  only live a moment after it is created. In the app that gap is invisible —
 *  the directory is tracked when the document opens, long before an edit. */
const watcherReady = () => settle(300);

interface Call {
  op: "upload" | "create" | "stat" | "findChild";
  id?: string;
  name?: string;
}

class FakeProvider implements CloudProvider {
  readonly id = "dropbox" as const;
  readonly label = "Dropbox";
  readonly needsClientSecret = false;
  readonly calls: Call[] = [];
  /** What `stat` reports — a test moves this to simulate a remote edit. */
  remote: CloudFile = {
    id: "item1",
    name: "bull.stp",
    isFolder: false,
    rev: "r1",
    precondition: "r1",
    parentId: "/kkss",
  };
  /** Sidecars that already exist remotely, by name. */
  existing = new Map<string, CloudFile>();
  failNext: Error | undefined;
  failAlways: Error | undefined;
  /** When set, `stat` blocks on it — lets a test observe a pass mid-flight. */
  gate: Promise<void> | undefined;

  async connect() {
    return { id: "a", label: "a" };
  }
  async disconnect() {}
  account() {
    return { id: "a", label: "a" };
  }
  isConnected() {
    return true;
  }
  async list() {
    return { files: [] };
  }
  async stat(id: string): Promise<CloudFile> {
    this.calls.push({ op: "stat", id });
    if (this.gate) await this.gate;
    return this.remote;
  }
  async findChild(_parentId: string, name: string): Promise<CloudFile | undefined> {
    this.calls.push({ op: "findChild", name });
    return this.existing.get(name);
  }
  async download() {}
  async upload(fileId: string, _localPath: string): Promise<CloudFile> {
    this.calls.push({ op: "upload", id: fileId });
    if (this.failAlways) throw this.failAlways;
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = undefined;
      throw err;
    }
    this.remote = { ...this.remote, rev: "r2", precondition: "r2" };
    return this.remote;
  }
  async create(_parentId: string, name: string): Promise<CloudFile> {
    this.calls.push({ op: "create", name });
    return { id: `new:${name}`, name, isFolder: false, rev: "rn", precondition: "rn" };
  }

  countOf(op: Call["op"]): number {
    return this.calls.filter((c) => c.op === op).length;
  }
}

let dir: string;
let provider: FakeProvider;
let manifest: Manifest;
let toasts: Array<{ kind: string; text: string }>;
let sync: CloudSync;
let target: SyncTarget;

const entry = (over: Partial<CloudEntry> = {}): CloudEntry => ({
  provider: "dropbox",
  accountId: "acct",
  itemId: "item1",
  parentId: "/kkss",
  name: "bull.stp",
  remoteRev: "r1",
  remotePrecondition: "r1",
  bytes: 4,
  syncedAt: 1_000,
  lastOpenedAt: 1_000,
  ...over,
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-sync-"));
  fs.writeFileSync(path.join(dir, "bull.stp"), "SOLID");
  provider = new FakeProvider();
  manifest = { "dropbox/abc/bull.stp": entry() };
  toasts = [];
  target = { key: "dropbox/abc/bull.stp", dir, fileName: "bull.stp" };

  const deps: CloudSyncDeps = {
    provider: (id) => (id === "dropbox" ? provider : undefined),
    entry: (key) => manifest[key],
    saveEntry: (key, value) => {
      manifest[key] = value;
    },
    watch: (watchDir, onChange) => {
      const watcher = createFileSystemWatcher(watchDir, "*");
      const subs = [
        watcher.onDidChange((p) => onChange(path.basename(p))),
        watcher.onDidCreate((p) => onChange(path.basename(p))),
      ];
      return {
        dispose() {
          for (const s of subs) s.dispose();
          watcher.dispose();
        },
      };
    },
    toast: (kind, text) => toasts.push({ kind, text }),
    debounceMs: DEBOUNCE,
    now: () => Date.UTC(2026, 8, 6, 14, 3, 11),
  };
  sync = new CloudSync(deps);
  sync.track(target);
  await watcherReady();
});

afterEach(() => {
  sync.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
const lastToast = () => toasts[toasts.length - 1];

describe("CloudSync", () => {
  it("uploads the document once after a change settles", async () => {
    write("bull.stp", "SOLID edited");
    await settle();
    await sync.flushPending();
    expect(provider.countOf("upload")).toBe(1);
    expect(provider.calls.find((c) => c.op === "upload")?.id).toBe("item1");
  });

  it("coalesces a burst of sidecar writes into a single pass", async () => {
    // Exactly the cad shape: six debounce timers firing within half a second.
    for (const suffix of [
      ".parts.json",
      ".edits.json",
      ".annotations.json",
      ".view.json",
      ".planes.json",
      ".mesh.json",
    ]) {
      write(`bull.stp${suffix}`, "{}");
    }
    await settle();
    await sync.flushPending();
    // One create per sidecar, but only one stat — i.e. one pass, not six.
    expect(provider.countOf("stat")).toBeLessThanOrEqual(1);
    expect(provider.countOf("create")).toBe(6);
  });

  it("ignores our own atomic-write temps and in-flight downloads", async () => {
    write("bull.stp.parts.json.12345.tmp", "half written");
    write("bull.stp.download", "partial");
    write(".DS_Store", "junk");
    await settle();
    await sync.flushPending();
    expect(provider.calls).toEqual([]);
  });

  it("never uploads the per-folder macro library", async () => {
    // Per FOLDER, per-FILE cache: syncing it would let two models from one
    // remote folder overwrite each other's macros.
    write("cad-preview-macros.json", "{}");
    await settle();
    await sync.flushPending();
    expect(provider.calls).toEqual([]);
  });

  it("ignores an unrelated neighbour that is not a sidecar of this document", async () => {
    write("other.stp", "SOLID");
    await settle();
    await sync.flushPending();
    expect(provider.calls).toEqual([]);
  });

  it("keeps the local copy and uploads a conflict sibling when the remote moved", async () => {
    provider.remote = { ...provider.remote, rev: "SOMEONE_ELSE", precondition: "SOMEONE_ELSE" };
    write("bull.stp", "my local work");
    await settle();
    await sync.flushPending();

    // The remote is never overwritten...
    expect(provider.countOf("upload")).toBe(0);
    // ...and the local bytes land beside it under a dated name.
    expect(provider.calls.find((c) => c.op === "create")?.name).toBe(
      "bull (conflict 2026-09-06 14-03-11).stp"
    );
    expect(fs.readFileSync(path.join(dir, "bull.stp"), "utf8")).toBe("my local work");
    expect(toasts[0].kind).toBe("warning");
    expect(toasts[0].text).toContain("conflict");
  });

  it("adopts the remote revision after a conflict, so it does not repeat forever", async () => {
    provider.remote = { ...provider.remote, rev: "SOMEONE_ELSE", precondition: "SOMEONE_ELSE" };
    write("bull.stp", "one");
    await settle();
    await sync.flushPending();
    expect(manifest[target.key].remoteRev).toBe("SOMEONE_ELSE");

    write("bull.stp", "two");
    await settle();
    await sync.flushPending();
    // The second edit is an ordinary upload, not a second conflict copy.
    expect(provider.countOf("create")).toBe(1);
    expect(provider.countOf("upload")).toBe(1);
  });

  it("treats a missing baseline as a conflict rather than a blind overwrite", async () => {
    manifest[target.key] = entry({ remoteRev: undefined });
    write("bull.stp", "edited");
    await settle();
    await sync.flushPending();
    expect(provider.countOf("upload")).toBe(0);
    expect(provider.countOf("create")).toBe(1);
  });

  it("updates an existing sidecar instead of creating a duplicate", async () => {
    provider.existing.set("bull.stp.parts.json", {
      id: "sidecar1",
      name: "bull.stp.parts.json",
      isFolder: false,
      rev: "s1",
      precondition: "s1",
    });
    write("bull.stp.parts.json", "[]");
    await settle();
    await sync.flushPending();
    expect(provider.countOf("create")).toBe(0);
    expect(provider.calls.find((c) => c.op === "upload")?.id).toBe("sidecar1");
  });

  it("marks the entry dirty on a change and clears it after a successful pass", async () => {
    // Hold the pass open so the dirty window is observable: on disk, `dirty`
    // is what survives a crash mid-upload and makes the change recoverable.
    let release = () => {};
    provider.gate = new Promise<void>((resolve) => (release = resolve));
    write("bull.stp", "edited");
    await settle();
    expect(manifest[target.key].dirty).toBe(true);
    release();
    provider.gate = undefined;
    await sync.flushPending();
    expect(manifest[target.key].dirty).toBe(false);
  });

  it("leaves the entry dirty when the upload fails, so it is retried later", async () => {
    provider.failAlways = new Error("network down");
    write("bull.stp", "edited");
    await settle();
    await sync.flushPending();
    expect(manifest[target.key].dirty).toBe(true);
    expect(lastToast().kind).toBe("error");
    expect(sync.hasPending()).toBe(true);
  });

  it("reports pending work only while there is some", async () => {
    // This is what the before-quit drain reads to decide whether to hold the
    // quit open, so a stuck `true` would delay every shutdown by 10 seconds.
    expect(sync.hasPending()).toBe(false);
    let release = () => {};
    provider.gate = new Promise<void>((resolve) => (release = resolve));
    write("bull.stp", "edited");
    await settle();
    expect(sync.hasPending()).toBe(true);
    release();
    provider.gate = undefined;
    await sync.flushPending();
    expect(sync.hasPending()).toBe(false);
  });

  it("saveNow() pushes the document without waiting for a watch event", async () => {
    // File ▸ Save means "push what is on disk", even when a rewrite produced
    // byte-identical content and fired nothing.
    await sync.saveNow();
    expect(provider.countOf("upload")).toBe(1);
  });

  it("warns instead of throwing when the provider is not connected", async () => {
    manifest[target.key] = entry({ provider: "gdrive" });
    write("bull.stp", "edited");
    await settle();
    await sync.flushPending();
    expect(provider.calls).toEqual([]);
    expect(lastToast().text).toContain("Not connected");
  });

  it("stops watching after untrack", async () => {
    sync.untrack(target.key);
    await sync.flushPending();
    provider.calls.length = 0;
    write("bull.stp", "edited after close");
    await settle();
    await sync.flushPending();
    expect(provider.calls).toEqual([]);
  });
});
