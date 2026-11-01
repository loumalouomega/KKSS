import { describe, expect, it } from "vitest";
import {
  RECOVERY_ENTRY_CAP, RECOVERY_VERSION, capEntries, classifyRestore, isOrphanSession, parseEntry,
  parseLegacyEditor, parseLegacyMesh, parseSessionDirName, sessionDirName, type RecoveryEntry,
} from "../app/main/services/recoveryCore";

const mesh = (over: Record<string, unknown> = {}) => ({
  version: RECOVERY_VERSION, id: "mesh-a1", kind: "mesh", originalPath: "/p/a.mdpa", recipeFile: "mesh-a1.ops.json",
  sourceMtimeMs: 1000, sourceSize: 50, savedAt: 5, ...over,
});

describe("session folders", () => {
  it("round-trips a name and rejects anything else", () => {
    expect(parseSessionDirName(sessionDirName({ pid: 42, startSeconds: 1700000000 }))).toEqual({ pid: 42, startSeconds: 1700000000 });
    for (const bad of ["", "42", "mesh-1.json", "0-5", "42-0", "../42-1", "42-1-2"]) expect(parseSessionDirName(bad)).toBeNull();
  });

  it("orphans a dead pid, and a reused pid with a different start time", () => {
    const stamp = { pid: 7, startSeconds: 1000 };
    expect(isOrphanSession(stamp, () => null)).toBe(true);
    expect(isOrphanSession(stamp, () => 5000)).toBe(true); // pid reused later
    expect(isOrphanSession(stamp, () => 1001)).toBe(false); // same process, clock slack
    expect(isOrphanSession(stamp, () => 1000)).toBe(false);
  });

  it("keeps a live pid whose start time cannot be read", () => {
    expect(isOrphanSession({ pid: 7, startSeconds: 1000 }, () => "unknown")).toBe(false);
  });
});

describe("parseEntry", () => {
  it("accepts a valid mesh and editor entry", () => {
    expect(parseEntry(mesh())?.kind).toBe("mesh");
    const editor = parseEntry({ version: RECOVERY_VERSION, id: "editor", kind: "editor", originalPath: null, content: "x", savedAt: 1, task: "kratosRun" });
    expect(editor).toMatchObject({ kind: "editor", originalPath: null, content: "x", task: "kratosRun" });
  });

  it("degrades damaged, foreign-version and hostile entries to null", () => {
    expect(parseEntry(null)).toBeNull();
    expect(parseEntry(mesh({ version: 99 }))).toBeNull();
    expect(parseEntry(mesh({ kind: "other" }))).toBeNull();
    expect(parseEntry(mesh({ id: "../x" }))).toBeNull();
    expect(parseEntry(mesh({ recipeFile: "../../etc/passwd" }))).toBeNull();
    expect(parseEntry(mesh({ recipeFile: "a/b.json" }))).toBeNull();
    expect(parseEntry(mesh({ originalPath: "" }))).toBeNull();
    expect(parseEntry({ version: RECOVERY_VERSION, id: "e", kind: "editor", content: 5 })).toBeNull();
  });

  it("drops non-finite stamps instead of trusting them", () => {
    expect(parseEntry(mesh({ sourceMtimeMs: "x", sourceSize: NaN }))).toMatchObject({ sourceMtimeMs: null, sourceSize: null });
  });
});

describe("legacy flat files from the quit path", () => {
  it("reads an editor buffer", () => {
    const entry = parseLegacyEditor("editor-123.json", { originalPath: "/p/a.py", content: "print()" }, 9);
    expect(entry).toMatchObject({ kind: "editor", id: "editor-123", originalPath: "/p/a.py", content: "print()", savedAt: 9 });
    expect(parseLegacyEditor("editor-1.json", { content: 1 }, 0)).toBeNull();
  });

  it("reads a mesh source note and names its recipe", () => {
    const entry = parseLegacyMesh("mesh-1-ab.json.source.json", { originalPath: "/p/a.mdpa", backup: "/x/mesh-1-ab.json" }, 3);
    expect(entry).toMatchObject({ kind: "mesh", originalPath: "/p/a.mdpa", recipeFile: "mesh-1-ab.json" });
    // A hostile `backup` field is ignored: the recipe name comes from the note's own file name.
    expect((entry as { recipeFile: string }).recipeFile).not.toContain("/");
    expect(parseLegacyMesh("mesh-1.json.source.json", { backup: "x" }, 0)).toBeNull();
  });
});

describe("classifyRestore", () => {
  const entry = parseEntry(mesh()) as RecoveryEntry;
  it("restores over an unchanged source", () => expect(classifyRestore(entry, { mtimeMs: 1000, size: 50 })).toBe("restorable"));
  it("reports a changed source rather than replaying blindly", () => {
    expect(classifyRestore(entry, { mtimeMs: 2000, size: 50 })).toBe("sourceChanged");
    expect(classifyRestore(entry, { mtimeMs: 1000, size: 51 })).toBe("sourceChanged");
  });
  it("reports a missing source", () => expect(classifyRestore(entry, null)).toBe("sourceMissing"));
  it("accepts an existing source when the entry carries no stamp (legacy)", () => {
    const legacy = parseLegacyMesh("mesh-1.json.source.json", { originalPath: "/p/a.mdpa" }, 0) as RecoveryEntry;
    expect(classifyRestore(legacy, { mtimeMs: 5, size: 5 })).toBe("restorable");
  });
  it("lets an untitled buffer restore with no source", () => {
    const untitled = parseEntry({ version: RECOVERY_VERSION, id: "e", kind: "editor", originalPath: null, content: "" }) as RecoveryEntry;
    expect(classifyRestore(untitled, null)).toBe("restorable");
  });
});

describe("capEntries", () => {
  it("keeps the newest and reports the rest", () => {
    const listed = Array.from({ length: RECOVERY_ENTRY_CAP + 3 }, (_, i) => ({ entry: parseEntry(mesh({ id: `m${i}`, savedAt: i })) as RecoveryEntry }));
    const { kept, dropped } = capEntries(listed);
    expect(kept).toHaveLength(RECOVERY_ENTRY_CAP);
    expect(dropped.map(d => d.entry.savedAt)).toEqual([2, 1, 0]);
    expect(kept[0].entry.savedAt).toBe(RECOVERY_ENTRY_CAP + 2);
  });
});
