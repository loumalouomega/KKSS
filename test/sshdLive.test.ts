/**
 * Live acceptance against a REAL sshd (roadmap: remote guided workflows).
 *
 * Opt-in: set KKSS_SSHD_HOST to an ssh alias or user@host that accepts
 * key-based, non-interactive login from this machine AND whose filesystem is
 * this machine's (a loopback sshd), so the test can inspect "remote" state
 * directly. Skipped otherwise, so `npm test` is unchanged.
 *
 * Runs the same code paths the app uses (`spawnSsh`, `SshProvider`,
 * `StagingCache`/`CloudSync`, `RemoteRunner`) with no `sh` stand-in.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));

const HOST = process.env.KKSS_SSHD_HOST;
const live = HOST ? describe : describe.skip;

const { SshProvider, spawnSsh } = await import("../app/main/services/cloud/providers/ssh");
const { CloudSync } = await import("../app/main/services/cloud/cloudSync");
const { StagingCache } = await import("../app/main/services/cloud/stagingCache");
const { RemoteRunner } = await import("../app/main/services/workflows/remoteRunner");
const { createFileSystemWatcher } = await import("../app/main/services/watcher");
const { sshArgs } = await import("../app/main/services/cloud/providerCore/sshCore");
import type { Task } from "../app/main/services/workflows/contracts";

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const wait = async (f: () => Promise<boolean>, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await f()) return;
    await settle(100);
  }
  throw new Error("timeout");
};

let remote: string;
let cacheRoot: string;
beforeEach(() => {
  remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-live-remote-")));
  cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-live-cache-"));
});
afterEach(async () => {
  await settle(500); // let in-flight manifest writes land before the cache goes
  fs.rmSync(remote, { recursive: true, force: true });
  fs.rmSync(cacheRoot, { recursive: true, force: true });
});

live("real sshd: remote documents", () => {
  it("opens, writes back an edit, and keeps a concurrent remote edit as a conflict copy", async () => {
    const cache = new StagingCache(cacheRoot);
    const provider = new SshProvider(spawnSsh);
    const sync = new CloudSync({
      provider: (id) => (id === "ssh" ? provider : undefined),
      entry: (key) => cache.entry(key),
      saveEntry: (key, entry) => cache.saveEntry(key, entry),
      watch: (dir, onChange, depth) => {
        const watcher = createFileSystemWatcher(dir, "*", { depth });
        const rel = (p: string) => path.relative(dir, p).split(path.sep).join("/");
        const subs = [watcher.onDidChange((p) => onChange(rel(p))), watcher.onDidCreate((p) => onChange(rel(p)))];
        return { dispose: () => { for (const s of subs) s.dispose(); watcher.dispose(); } };
      },
      toast: () => undefined,
      debounceMs: 40,
    });
    try {
      fs.writeFileSync(path.join(remote, "model.mdpa"), "original");
      fs.writeFileSync(path.join(remote, "model.mdpa.parts.json"), "{\"parts\":[]}");
      const ref = { provider: "ssh" as const, accountId: HOST!, itemId: `${HOST}:${remote}/model.mdpa`, name: "model.mdpa", parentId: `${HOST}:${remote}` };
      const doc = await cache.stage(provider, ref);
      sync.track(doc);
      await settle();
      expect(fs.readFileSync(doc.localPath, "utf8")).toBe("original");
      expect(fs.readFileSync(path.join(doc.dir, "model.mdpa.parts.json"), "utf8")).toBe("{\"parts\":[]}");

      fs.writeFileSync(doc.localPath, "edited locally");
      await settle();
      await sync.flushPending();
      expect(fs.readFileSync(path.join(remote, "model.mdpa"), "utf8")).toBe("edited locally");

      fs.writeFileSync(path.join(remote, "model.mdpa"), "someone else was here, longer");
      fs.writeFileSync(doc.localPath, "my second edit");
      await settle();
      await sync.flushPending();
      expect(fs.readFileSync(path.join(remote, "model.mdpa"), "utf8")).toBe("someone else was here, longer");
      const copies = fs.readdirSync(remote).filter((n) => n.includes("(conflict"));
      expect(copies).toHaveLength(1);
      expect(fs.readFileSync(path.join(remote, copies[0]), "utf8")).toBe("my second edit");
      expect(fs.readdirSync(remote).filter((n) => n.includes("kkss-tmp"))).toEqual([]);
    } finally {
      sync.dispose();
    }
  });
});

live("real sshd: remote shell", () => {
  it("runs the interactive-shell invocation (ssh -t) and returns its output", () => {
    const [, , , , host] = sshArgs(HOST!, "x");
    const run = spawnSync("ssh", ["-tt", "-o", "BatchMode=yes", host, "echo kkss-marker-$((20+22))"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("kkss-marker-42");
  });
});

live("real sshd: guided solve runner", () => {
  const task = { id: "t1", studyId: "s1", runId: "r1", kind: "solve" } as unknown as Task;
  let input: string;
  let local: string;
  const mk = (argv: string[]) =>
    new RemoteRunner(HOST!, spawnSsh, () => ({ inputDir: input, remoteDir: path.join(remote, "run"), argv, localDir: local, root: local }), (ms) => new Promise((r) => setTimeout(r, ms)));
  beforeEach(() => {
    local = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-live-local-"));
    input = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-live-input-"));
    fs.writeFileSync(path.join(input, "a.txt"), "x");
  });
  afterEach(() => {
    fs.rmSync(local, { recursive: true, force: true });
    fs.rmSync(input, { recursive: true, force: true });
  });

  it("uploads inputs, runs detached, and downloads checksum-verified outputs without claiming convergence", async () => {
    const r = mk(["sh", "-c", "mkdir vtk_output && cat a.txt > vtk_output/a.vtk"]);
    expect((await r.dispatch(task, {} as never)).state).toBe("running");
    await wait(async () => (await r.lookup(task, {} as never))?.state === "succeeded");
    const receipt = (await r.lookup(task, {} as never))!;
    expect(receipt.message).toMatch(/convergence is not established/);
    expect(receipt.artifacts.map((a) => a.reference.path).sort()).toEqual(["stdout.log", "vtk_output/a.vtk"]);
    expect(fs.readFileSync(path.join(local, "vtk_output/a.vtk"), "utf8")).toBe("x");
    expect(fs.existsSync(path.join(local, "a.txt"))).toBe(false);
  });

  it("cancels the running process group", async () => {
    const r = mk(["sleep", "47"]);
    await r.dispatch(task, {} as never);
    await wait(async () => (await r.lookup(task, {} as never))?.state === "running");
    expect((await r.cancel(task, {} as never)).state).toBe("cancelled");
    await wait(async () => {
      const ps = spawn("pgrep", ["-f", "sleep 4[7]"]);
      return await new Promise<boolean>((res) => ps.on("close", (code) => res(code !== 0)));
    }, 50);
    expect((await r.lookup(task, {} as never))?.state).toBe("cancelled");
  }, 20_000);
});
