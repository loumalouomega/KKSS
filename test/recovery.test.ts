import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecoveryService } from "../app/main/services/recovery";
import { RECOVERY_EDITOR_MAX_BYTES, sessionDirName } from "../app/main/services/recoveryCore";

let root: string;
let work: string;
const DEAD = (): null => null;
const writeRecipe = (text = "{}") => async (dest: string) => { await fs.promises.writeFile(dest, text); };

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-recovery-"));
  root = path.join(base, "recovery");
  work = path.join(base, "work");
  fs.mkdirSync(work);
});
afterEach(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

/** A previous run that checkpointed and then died. */
async function crashedSession(pid: number, fn: (s: RecoveryService, source: string) => Promise<void>): Promise<string> {
  const source = path.join(work, "a.mdpa");
  fs.writeFileSync(source, "model");
  const dead = new RecoveryService(root, { pid, liveStart: () => 1000 });
  await fn(dead, source); // never disposed: the process "crashed"
  return source;
}

describe("RecoveryService", () => {
  it("lists a dead session's checkpoints, with the source stamp and task", async () => {
    const source = await crashedSession(4001, async (s, src) => {
      await s.checkpointMesh("mesh-x", src, writeRecipe('{"ops":1}'), "kratosRun");
      await s.checkpointEditor("editor", path.join(work, "n.py"), "print(1)");
    });
    const live = new RecoveryService(root, { pid: 4002, liveStart: pid => (pid === 4001 ? null : 1000) });
    const listed = await live.list();
    expect(listed.map(l => l.entry.kind).sort()).toEqual(["editor", "mesh"]);
    const mesh = listed.find(l => l.entry.kind === "mesh")!;
    expect(mesh.entry).toMatchObject({ originalPath: source, task: "kratosRun", sourceSize: 5 });
    expect(fs.readFileSync(live.recipeFileOf(mesh)!, "utf8")).toBe('{"ops":1}');
  });

  it("never lists a live session, including its own", async () => {
    const own = new RecoveryService(root, { pid: 5001, liveStart: () => 1000 });
    await own.checkpointEditor("editor", null, "x");
    const other = new RecoveryService(root, { pid: 5002, liveStart: () => 1000 });
    expect(await other.list()).toEqual([]); // 5001 reads as alive (same start time)
    expect(await own.list()).toEqual([]);
  });

  it("treats a reused pid as a dead session", async () => {
    await crashedSession(6001, async (s) => { await s.checkpointEditor("editor", null, "lost work"); });
    const later = new RecoveryService(root, { pid: 6002, liveStart: () => 999999 }); // 6001 now someone else
    expect((await later.list()).map(l => l.entry.kind)).toEqual(["editor"]);
  });

  it("clear() drops a resolved checkpoint and a clean dispose removes the folder", async () => {
    const s = new RecoveryService(root, { pid: 7001, liveStart: () => 1000 });
    await s.checkpointMesh("m", path.join(work, "a.mdpa"), writeRecipe());
    await s.clear("m");
    expect(fs.readdirSync(s.sessionDirectory).filter(f => f !== "session.json")).toEqual([]);
    await s.checkpointEditor("editor", null, "x");
    s.dispose();
    expect(fs.existsSync(s.sessionDirectory)).toBe(false);
  });

  it("a refused recipe leaves the previous checkpoint standing", async () => {
    const src = await crashedSession(8001, async (s, a) => {
      await s.checkpointMesh("m", a, writeRecipe('{"v":1}'));
      await expect(s.checkpointMesh("m", a, async () => { throw new Error("not loaded yet"); })).rejects.toThrow();
    });
    const live = new RecoveryService(root, { pid: 8002, liveStart: DEAD });
    const [only] = await live.list();
    expect(only.entry.originalPath).toBe(src);
    expect(fs.readFileSync(live.recipeFileOf(only)!, "utf8")).toBe('{"v":1}');
  });

  it("serialises overlapping checkpoints to one entry", async () => {
    const s = new RecoveryService(root, { pid: 9001, liveStart: () => 1000 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.checkpointEditor("editor", null, `v${i}`)));
    const entry = JSON.parse(fs.readFileSync(path.join(s.sessionDirectory, "editor.json"), "utf8"));
    expect(entry.content).toMatch(/^v\d+$/);
    expect(fs.readdirSync(s.sessionDirectory).some(f => f.endsWith(".tmp"))).toBe(false);
  });

  it("refuses an oversized editor buffer", async () => {
    const s = new RecoveryService(root, { pid: 9101, liveStart: () => 1000 });
    expect(await s.checkpointEditor("editor", null, "x".repeat(RECOVERY_EDITOR_MAX_BYTES + 1))).toBe(false);
  });

  it("discard() removes the entry and then the emptied session folder", async () => {
    await crashedSession(9201, async (s, a) => { await s.checkpointMesh("m", a, writeRecipe()); });
    const live = new RecoveryService(root, { pid: 9202, liveStart: DEAD });
    const [item] = await live.list();
    await live.discard(item);
    expect(fs.existsSync(item.directory)).toBe(false);
    expect(await live.list()).toEqual([]);
  });

  it("offers the legacy flat files the quit path wrote, and skips damaged ones", async () => {
    fs.mkdirSync(root, { recursive: true });
    const recipe = path.join(root, "mesh-1-ab.json");
    fs.writeFileSync(recipe, "{}");
    fs.writeFileSync(recipe + ".source.json", JSON.stringify({ originalPath: path.join(work, "a.mdpa"), backup: recipe }));
    fs.writeFileSync(path.join(root, "editor-2.json"), JSON.stringify({ originalPath: null, content: "buf" }));
    fs.writeFileSync(path.join(root, "editor-3.json"), "{not json");
    fs.writeFileSync(path.join(root, "mesh-9-zz.json.source.json"), JSON.stringify({ originalPath: "/x" })); // recipe missing
    const live = new RecoveryService(root, { pid: 9301, liveStart: DEAD });
    const listed = await live.list();
    expect(listed.map(l => l.entry.id).sort()).toEqual(["editor-2", "mesh-1-ab"]);
    const meshItem = listed.find(l => l.entry.kind === "mesh")!;
    await live.discard(meshItem);
    expect(fs.existsSync(recipe)).toBe(false);
    expect(fs.existsSync(recipe + ".source.json")).toBe(false);
    expect(fs.existsSync(path.join(root, "editor-2.json"))).toBe(true);
  });

  it("skips a damaged entry inside a dead session without deleting the folder", async () => {
    const dir = path.join(root, sessionDirName({ pid: 9401, startSeconds: 1000 }));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "{");
    const live = new RecoveryService(root, { pid: 9402, liveStart: DEAD });
    expect(await live.list()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "bad.json"))).toBe(true);
  });
});
