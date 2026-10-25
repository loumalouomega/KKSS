/**
 * Open → edit → write back, and the conflict rule, through the real staging
 * cache and sync engine with the ssh provider running its commands in a local
 * `sh` (the same stand-in sshProvider.test.ts uses for the remote machine).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));

const { SshProvider } = await import("../app/main/services/cloud/providers/ssh");
import type { SshRunner } from "../app/main/services/cloud/providers/ssh";
import { CloudSync } from "../app/main/services/cloud/cloudSync";
import { StagingCache } from "../app/main/services/cloud/stagingCache";
import { createFileSystemWatcher } from "../app/main/services/watcher";

const localSh: SshRunner = (_host, command, options = {}) =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const sink = options.stdoutFile ? fs.createWriteStream(options.stdoutFile) : undefined;
    child.stderr.on("data", (d) => (stderr += d));
    if (sink) child.stdout.pipe(sink);
    else child.stdout.on("data", (d) => (stdout += d));
    if (options.stdinFile) fs.createReadStream(options.stdinFile).pipe(child.stdin);
    else child.stdin.end();
    child.on("close", (code) => {
      if (sink) sink.end(() => resolve({ code: code ?? 1, stdout, stderr }));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

let remote: string;
let cacheRoot: string;
let cache: StagingCache;
let sync: CloudSync;
let toasts: string[];

beforeEach(() => {
  remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-rt-remote-")));
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-rt-cache-"));
  cache = new StagingCache(cacheRoot);
  toasts = [];
  const provider = new SshProvider(localSh);
  sync = new CloudSync({
    provider: (id) => (id === "ssh" ? provider : undefined),
    entry: (key) => cache.entry(key),
    saveEntry: (key, entry) => cache.saveEntry(key, entry),
    watch: (dir, onChange, depth) => {
      const watcher = createFileSystemWatcher(dir, "*", { depth });
      const rel = (p: string) => path.relative(dir, p).split(path.sep).join("/");
      const subs = [watcher.onDidChange((p) => onChange(rel(p))), watcher.onDidCreate((p) => onChange(rel(p)))];
      return { dispose: () => { for (const s of subs) s.dispose(); watcher.dispose(); } };
    },
    toast: (_kind, text) => toasts.push(text),
    debounceMs: 40,
  });
});

afterEach(() => {
  sync.dispose();
  fs.rmSync(remote, { recursive: true, force: true });
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

async function open() {
  fs.writeFileSync(path.join(remote, "model.mdpa"), "original");
  fs.writeFileSync(path.join(remote, "model.mdpa.parts.json"), "{\"parts\":[]}");
  const ref = {
    provider: "ssh" as const,
    accountId: "box",
    itemId: `box:${remote}/model.mdpa`,
    name: "model.mdpa",
    parentId: `box:${remote}`,
  };
  const doc = await cache.stage(new SshProvider(localSh), ref);
  sync.track(doc);
  await settle();
  return doc;
}

describe("ssh document round trip", () => {
  it("stages the document and its sidecar as ordinary local files", async () => {
    const doc = await open();
    expect(fs.readFileSync(doc.localPath, "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(doc.dir, "model.mdpa.parts.json"), "utf8")).toBe("{\"parts\":[]}");
    expect(cache.entry(doc.key)?.provider).toBe("ssh");
  });

  it("writes an edit back to the remote host", async () => {
    const doc = await open();
    fs.writeFileSync(doc.localPath, "edited locally");
    await settle();
    await sync.flushPending();
    expect(fs.readFileSync(path.join(remote, "model.mdpa"), "utf8")).toBe("edited locally");
    expect(fs.readdirSync(remote).filter((n) => n.includes("kkss-tmp"))).toEqual([]);
  });

  it("keeps a remote edit made meanwhile and uploads the local one as a conflict copy", async () => {
    const doc = await open();
    // The file changes on the host after we staged it (size differs → new revision).
    fs.writeFileSync(path.join(remote, "model.mdpa"), "someone else was here");
    fs.writeFileSync(doc.localPath, "my local edit");
    await settle();
    await sync.flushPending();
    expect(fs.readFileSync(path.join(remote, "model.mdpa"), "utf8")).toBe("someone else was here");
    const copies = fs.readdirSync(remote).filter((n) => n.includes("(conflict"));
    expect(copies).toHaveLength(1);
    expect(copies[0].endsWith(".mdpa")).toBe(true);
    expect(fs.readFileSync(path.join(remote, copies[0]), "utf8")).toBe("my local edit");
    expect(fs.readFileSync(doc.localPath, "utf8")).toBe("my local edit");
  });
});
