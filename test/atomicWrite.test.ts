/**
 * services/atomicWrite.ts — the durability primitive shared by JsonStore and
 * cadHost's sidecar writers. Everything here is about the two properties a
 * bare fs.writeFile lacks: a reader never sees a torn file, and two writes to
 * one path cannot collide on the shared temp name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  renameWithRetry,
  tempPathFor,
  writeFileAtomic,
  writeFileAtomicSync,
} from "../app/main/services/atomicWrite";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-atomic-"));
  file = path.join(dir, "model.stp.parts.json");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = () => fs.readFileSync(file, "utf8");
const strays = () => fs.readdirSync(dir).filter((n) => n !== path.basename(file));

describe("writeFileAtomic", () => {
  it("round-trips text and bytes, leaving no temp file behind", async () => {
    await writeFileAtomic(file, '{"parts":[]}');
    expect(read()).toBe('{"parts":[]}');
    expect(strays()).toEqual([]);

    await writeFileAtomic(file, new Uint8Array([0x7b, 0x7d]));
    expect(read()).toBe("{}");
    expect(strays()).toEqual([]);
  });

  it("creates the directory on first write", async () => {
    const nested = path.join(dir, "deep", "cloud-cache", "a.geo");
    await writeFileAtomic(nested, "// gmsh");
    expect(fs.readFileSync(nested, "utf8")).toBe("// gmsh");
  });

  it("serializes concurrent writes to one path — the last call wins", async () => {
    // Without the per-path chain these all share `${file}.${pid}.tmp`, so every
    // rename but the first would fail with ENOENT. This is the real shape:
    // flushSidecars() cannot cancel a debounce timer that has already fired.
    const writes = Array.from({ length: 20 }, (_, i) => writeFileAtomic(file, `v${i}`));
    await expect(Promise.all(writes)).resolves.toBeDefined();
    expect(read()).toBe("v19");
    expect(strays()).toEqual([]);
  });

  it("keeps writes to different paths independent", async () => {
    const other = path.join(dir, "cad-preview-macros.json");
    await Promise.all([writeFileAtomic(file, "one"), writeFileAtomic(other, "two")]);
    expect(read()).toBe("one");
    expect(fs.readFileSync(other, "utf8")).toBe("two");
  });

  it("aborts without renaming when beforeRename vetoes, and still cleans up", async () => {
    await writeFileAtomic(file, "original");
    await expect(
      writeFileAtomic(file, "stale snapshot", { beforeRename: () => false })
    ).resolves.toBeUndefined();
    // The veto resolves normally — it is not an error, it is JsonStore's
    // flushSync() having already written a newer state.
    expect(read()).toBe("original");
    expect(strays()).toEqual([]);
  });

  it("removes the temp file and rejects when the write cannot land", async () => {
    // A directory where the file should be: open() succeeds on the temp, the
    // rename does not.
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    await expect(writeFileAtomic(blocked, "{}")).rejects.toThrow();
    expect(fs.existsSync(tempPathFor(path.resolve(blocked)))).toBe(false);
  });

  it("does not let one failure poison the queue for the next write", async () => {
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    await expect(writeFileAtomic(blocked, "{}")).rejects.toThrow();
    fs.rmdirSync(blocked);
    await expect(writeFileAtomic(blocked, '{"k":2}')).resolves.toBeUndefined();
    expect(fs.readFileSync(blocked, "utf8")).toBe('{"k":2}');
  });

  it("never exposes a torn file to a concurrent reader", async () => {
    await writeFileAtomic(file, JSON.stringify({ seed: "x".repeat(50_000) }));
    let observations = 0;
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        expect(() => JSON.parse(read())).not.toThrow();
        observations++;
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        writeFileAtomic(file, JSON.stringify({ n: i, pad: "y".repeat(20_000) }))
      )
    );
    stop = true;
    await watcher;
    expect(observations).toBeGreaterThan(0);
    expect(JSON.parse(read()).n).toBe(29);
  });
});

describe("renameWithRetry", () => {
  it("retries a transient Windows-shaped failure and then succeeds", async () => {
    const tmp = path.join(dir, "tmp");
    fs.writeFileSync(tmp, "payload");
    const real = fs.promises.rename;
    let calls = 0;
    vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
      if (++calls <= 2) {
        const err = new Error("EPERM") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      return real(from, to);
    });
    await renameWithRetry(tmp, file);
    expect(calls).toBe(3);
    expect(read()).toBe("payload");
  });

  it("rethrows immediately for a non-transient failure", async () => {
    const tmp = path.join(dir, "tmp");
    fs.writeFileSync(tmp, "payload");
    let calls = 0;
    vi.spyOn(fs.promises, "rename").mockImplementation(async () => {
      calls++;
      const err = new Error("EXDEV") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      throw err;
    });
    await expect(renameWithRetry(tmp, file)).rejects.toThrow("EXDEV");
    expect(calls).toBe(1);
  });
});

describe("writeFileAtomicSync", () => {
  it("does not share a temp name with an in-flight async write", async () => {
    // The quit-path race: flushSync() bypasses the per-path chain, so a shared
    // temp name would let an async write that is mid-`open()` end up holding a
    // handle to the renamed *target* and clobber it with a stale snapshot —
    // losing every setting and both encrypted secrets in state.json.
    const slow = writeFileAtomic(file, "async value");
    writeFileAtomicSync(file, "final value");
    await slow;
    // Whichever landed last, the file is one of the two whole values and never
    // a mixture, and nothing is left behind.
    expect(["async value", "final value"]).toContain(read());
    expect(strays()).toEqual([]);
  });

  it("writes through a temp file and creates missing directories", () => {
    const nested = path.join(dir, "deep", "state.json");
    writeFileAtomicSync(nested, '{"uiZoom":0.9}');
    expect(fs.readFileSync(nested, "utf8")).toBe('{"uiZoom":0.9}');
    expect(fs.readdirSync(path.dirname(nested))).toEqual(["state.json"]);
  });

  it("cleans up the temp file and rethrows when the rename fails", () => {
    const blocked = path.join(dir, "blocked.json");
    fs.mkdirSync(blocked);
    expect(() => writeFileAtomicSync(blocked, "{}")).toThrow();
    expect(fs.existsSync(tempPathFor(path.resolve(blocked)))).toBe(false);
  });
});
