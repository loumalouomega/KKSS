/**
 * JsonStore — the Electron-free half of services/stateStore.ts. Everything here
 * is about the two properties the previous 35-line store lacked: writes are
 * atomic (a reader never sees a torn file) and serialized (concurrent updates
 * cannot interleave and lose each other).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonStore } from "../app/main/services/jsonStore";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-state-"));
  file = path.join(dir, "state.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
const strays = () => fs.readdirSync(dir).filter((n) => n !== "state.json");

describe("JsonStore", () => {
  it("round-trips a value through disk", async () => {
    const store = new JsonStore(file);
    await store.update("uiZoom", 1.25);
    expect(store.get("uiZoom")).toBe(1.25);
    expect(read()).toEqual({ uiZoom: 1.25 });
    // A fresh instance reads what the first one wrote.
    expect(new JsonStore(file).get("uiZoom")).toBe(1.25);
  });

  it("returns the default only for a missing key", async () => {
    const store = new JsonStore(file);
    expect(store.get("nope", "fallback")).toBe("fallback");
    await store.update("present", false);
    // `false` is a real value, not an absent one.
    expect(store.get("present", true)).toBe(false);
  });

  it("deletes a key when the value is undefined", async () => {
    const store = new JsonStore(file);
    await store.update("terminalShell", "/bin/fish");
    await store.update("terminalShell", undefined);
    expect(store.get("terminalShell")).toBeUndefined();
    expect(read()).toEqual({});
  });

  it("lands every value when updates are issued concurrently", async () => {
    const store = new JsonStore(file);
    // The real pattern: many fire-and-forget `void update()` calls in a row
    // (Settings menu clicks, the zoom picker, a secret write).
    const keys = Array.from({ length: 25 }, (_, i) => `key${i}`);
    await Promise.all(keys.map((k, i) => store.update(k, i)));
    const onDisk = read();
    for (const [i, k] of keys.entries()) expect(onDisk[k]).toBe(i);
    expect(strays()).toEqual([]);
  });

  it("never leaves the file torn or unparseable mid-write", async () => {
    const store = new JsonStore(file);
    await store.update("seed", "x".repeat(50_000));
    // Poll the file while a burst of writes is in flight; every observation
    // must be complete, valid JSON (this is what temp-file + rename buys).
    let observations = 0;
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        expect(() => read()).not.toThrow();
        observations++;
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => store.update(`big${i}`, "y".repeat(20_000)))
    );
    stop = true;
    await watcher;
    expect(observations).toBeGreaterThan(0);
    expect(Object.keys(read())).toHaveLength(41);
  });

  it("applies same-key writes in call order", async () => {
    const store = new JsonStore(file);
    const writes = [store.update("k", 1), store.update("k", 2), store.update("k", 3)];
    await Promise.all(writes);
    expect(store.get("k")).toBe(3);
    expect(read().k).toBe(3);
  });

  it("leaves no temp file behind", async () => {
    const store = new JsonStore(file);
    await store.update("a", 1);
    await store.flush();
    expect(strays()).toEqual([]);
  });

  it("reads a missing, corrupt or non-object file as empty", async () => {
    expect(new JsonStore(path.join(dir, "absent.json")).get("any")).toBeUndefined();

    const corrupt = path.join(dir, "corrupt.json");
    fs.writeFileSync(corrupt, '{"truncated": ');
    const recovered = new JsonStore(corrupt);
    expect(recovered.get("truncated")).toBeUndefined();
    // ...and it recovers by writing a valid file over the damaged one.
    await recovered.update("fresh", true);
    expect(JSON.parse(fs.readFileSync(corrupt, "utf8"))).toEqual({ fresh: true });

    const scalar = path.join(dir, "scalar.json");
    fs.writeFileSync(scalar, "42");
    expect(new JsonStore(scalar).get("any")).toBeUndefined();
  });

  it("flushSync writes the pending value without awaiting", async () => {
    const store = new JsonStore(file);
    // The will-quit shape: fire-and-forget update, then quit immediately.
    void store.update("uiZoom", 0.9);
    store.flushSync();
    expect(read()).toEqual({ uiZoom: 0.9 });
  });

  it("does not let an in-flight async write land after flushSync", async () => {
    const store = new JsonStore(file);
    const inFlight = store.update("a", 1);
    store.flushSync();
    const afterSync = read();
    // The async write can only resume after flushSync() returned, and it must
    // bail rather than rename a stale snapshot over the final state.
    await inFlight.catch(() => undefined);
    expect(read()).toEqual(afterSync);
    expect(strays()).toEqual([]);
  });

  it("flushSync is a no-op when nothing is pending", () => {
    const store = new JsonStore(file);
    store.get("anything");
    store.flushSync();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("creates the directory on first write", async () => {
    const nested = path.join(dir, "deep", "userData", "state.json");
    await new JsonStore(nested).update("k", "v");
    expect(JSON.parse(fs.readFileSync(nested, "utf8"))).toEqual({ k: "v" });
  });

  it("keeps serving writes after one fails", async () => {
    // A directory where the file should be: open() fails, the chain must not
    // stay poisoned for later writes.
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    const store = new JsonStore(blocked);
    await expect(store.update("k", 1)).rejects.toThrow();
    fs.rmdirSync(blocked);
    await expect(store.update("k", 2)).resolves.toBeUndefined();
    expect(JSON.parse(fs.readFileSync(blocked, "utf8"))).toEqual({ k: 2 });
  });
});
