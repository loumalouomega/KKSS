/**
 * Glue guard for the interactive bake (app/main/cadSaveInPlace.ts).
 *
 * `CadHost` cannot run under vitest, so the ORDER of the save — source first,
 * watermark second, with a defined recovery for each way the pair can then
 * disagree — lives in an injected-I/O module and is pinned here against an
 * in-memory filesystem that can be told to fail any single call.
 */
import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import type { EditOp, OpOutcome } from "../cad/src/editOps";
import { parseSaveJournal, saveJournalFileName } from "../cad/src/saveJournal";
import {
  brepTempName,
  detectSourceDisplayUnit,
  saveBrepInPlace,
  saveMeshInPlace,
  type BrepSaveDeps,
  type BrepSaveInput,
  type MeshSaveDeps,
  type MeshSaveInput,
  type SaveFs,
} from "../app/main/cadSaveInPlace";

const DIR = "/work";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string | undefined => (b ? new TextDecoder().decode(b) : undefined);
const op = (name: string): EditOp => ({ op: "translate", targets: [name], vector: [1, 0, 0] }) as unknown as EditOp;

type FsCall = "readFile" | "writeFile" | "copyFile" | "rename" | "rm";

/** In-memory fs; `failOn` makes a chosen call throw (once matched, every time). */
function memFs(files: Record<string, string>, failOn?: (call: FsCall, p: string) => boolean) {
  const store = new Map<string, Uint8Array>(Object.entries(files).map(([k, v]) => [k, enc(v)]));
  const log: string[] = [];
  const guard = (call: FsCall, p: string) => {
    log.push(`${call} ${path.basename(p)}`);
    if (failOn?.(call, p)) throw new Error(`injected ${call} failure on ${path.basename(p)}`);
  };
  const fs: SaveFs = {
    async readFile(p) {
      guard("readFile", p);
      const v = store.get(p);
      if (!v) throw new Error(`ENOENT ${p}`);
      return v;
    },
    async writeFile(p, bytes) {
      guard("writeFile", p);
      store.set(p, bytes);
    },
    async copyFile(from, to) {
      guard("copyFile", to);
      const v = store.get(from);
      if (!v) throw new Error(`ENOENT ${from}`);
      store.set(to, v);
    },
    async rename(from, to) {
      guard("rename", to);
      const v = store.get(from);
      if (!v) throw new Error(`ENOENT ${from}`);
      store.set(to, v);
      store.delete(from);
    },
    async rm(p) {
      guard("rm", p);
      store.delete(p);
    },
  };
  return { fs, store, log, text: (p: string) => dec(store.get(p)) };
}

describe("detectSourceDisplayUnit", () => {
  it("reads the declared unit of a STEP file and defaults everything else to mm", () => {
    const inch = Buffer.from(
      "#10=(CONVERSION_BASED_UNIT('INCH',#11) LENGTH_UNIT() NAMED_UNIT(#12));\n" +
        "#20=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#10)) REPRESENTATION_CONTEXT('','3D'));"
    );
    expect(detectSourceDisplayUnit(inch, "step")).toBe("in");
    expect(detectSourceDisplayUnit(enc("anything"), "step")).toBe("mm");
    expect(detectSourceDisplayUnit(enc("anything"), "brep")).toBe("mm");
  });
});

describe("saveBrepInPlace", () => {
  const doc = `${DIR}/part.step`;
  const baseInput = (over: Partial<BrepSaveInput> = {}): BrepSaveInput => ({
    docPath: doc,
    format: "step",
    edits: [op("a"), op("b"), op("c")],
    bakedThrough: 1,
    parts: [],
    annotations: [],
    layers: [],
    firstSaveOfSession: true,
    ...over,
  });
  const makeDeps = (fsx: ReturnType<typeof memFs>, over: Partial<BrepSaveDeps> = {}) => {
    const calls: string[] = [];
    const deps: BrepSaveDeps = {
      fs: fsx.fs,
      confirm: vi.fn(async () => true),
      commitWatermark: vi.fn(async () => {
        calls.push("commit");
      }),
      readSource: vi.fn(async () => ({ bytes: enc("ORIGINAL"), format: "step" as const })),
      exportBRep: vi.fn(async () => enc("BAKED")),
      rebindAcrossSave: vi.fn(async (_o, _f, _ops, _n, parts, annotations, layers) => ({ parts, annotations, layers })),
      ...over,
    };
    return { deps, calls };
  };

  it("confirms, backs up, replaces the source via a temp sibling, then advances the watermark", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const { deps } = makeDeps(f);
    const out = await saveBrepInPlace(baseInput(), deps);

    expect(out).toMatchObject({ status: "saved", baked: 2, madeBackup: true });
    expect(f.text(doc)).toBe("BAKED");
    expect(f.text(`${doc}.bak`)).toBe("ORIGINAL");
    expect(f.store.has(path.join(DIR, brepTempName("part.step", "step")))).toBe(false);
    // Only the unbaked tail is baked, and the watermark is the FULL history length.
    expect((deps.exportBRep as ReturnType<typeof vi.fn>).mock.calls[0][1]).toHaveLength(2);
    expect(deps.commitWatermark).toHaveBeenCalledWith(3);
    // Source write strictly before the watermark: the rename is logged first.
    expect(f.log.indexOf("rename part.step")).toBeGreaterThan(-1);
  });

  it("does not touch the filesystem when the user cancels the confirmation", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const { deps } = makeDeps(f, { confirm: vi.fn(async () => false) });
    const out = await saveBrepInPlace(baseInput(), deps);

    expect(out).toEqual({ status: "cancelled" });
    expect(f.log).toEqual([]);
    expect(deps.exportBRep).not.toHaveBeenCalled();
    expect(deps.commitWatermark).not.toHaveBeenCalled();
  });

  it("asks and backs up only on the first save of a session", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const { deps } = makeDeps(f);
    const out = await saveBrepInPlace(baseInput({ firstSaveOfSession: false }), deps);

    expect(out).toMatchObject({ status: "saved", madeBackup: false });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(f.store.has(`${doc}.bak`)).toBe(false);
  });

  it("restores the pre-save bytes when the watermark cannot be written", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const { deps } = makeDeps(f, {
      commitWatermark: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const out = await saveBrepInPlace(baseInput(), deps);

    expect(out.status).toBe("failed");
    expect((out as { message: string }).message).toMatch(/watermark write failed \(disk full\).*restored to its pre-save bytes/);
    // The pair agrees again: baked bytes are gone, the original is back.
    expect(f.text(doc)).toBe("ORIGINAL");
    expect(deps.rebindAcrossSave).not.toHaveBeenCalled();
  });

  it("leaves the source untouched and removes the temp file when the write fails", async () => {
    const f = memFs({ [doc]: "ORIGINAL" }, (call, p) => call === "rename" && p === doc);
    const { deps } = makeDeps(f);
    const out = await saveBrepInPlace(baseInput(), deps);

    expect(out.status).toBe("failed");
    expect(f.text(doc)).toBe("ORIGINAL");
    expect(f.store.has(path.join(DIR, brepTempName("part.step", "step")))).toBe(false);
    expect(deps.commitWatermark).not.toHaveBeenCalled();
  });

  it("refuses a history shorter than the save point without any I/O", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const { deps } = makeDeps(f);
    const out = await saveBrepInPlace(baseInput({ edits: [op("a")], bakedThrough: 3 }), deps);

    expect(out.status).toBe("failed");
    expect((out as { message: string }).message).toMatch(/below the save point/);
    expect(deps.readSource).not.toHaveBeenCalled();
    expect(f.log).toEqual([]);
  });

  it("reports only the arrays the rebind actually changed", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const before = [{ id: "p1", name: "P", color: "#fff", volumes: ["solid-0"], surfaces: ["face-1"], lines: [], points: [] }];
    const after = [{ ...before[0], surfaces: ["face-9"] }];
    const { deps } = makeDeps(f, {
      rebindAcrossSave: vi.fn(async (_o, _f, _ops, _n, _p, annotations, layers) => ({ parts: after as never, annotations, layers })),
    });
    const out = await saveBrepInPlace(baseInput({ parts: before as never }), deps);

    expect(out).toMatchObject({ status: "saved" });
    const rebound = (out as { rebound?: { parts?: unknown; annotations?: unknown } }).rebound;
    expect(rebound?.parts).toEqual(after);
    expect(rebound?.annotations).toBeUndefined();
  });

  it("rebinds against the unbaked tail only, never the already-baked prefix", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const { deps } = makeDeps(f);
    await saveBrepInPlace(baseInput({ edits: [op("a"), op("b"), op("c")], bakedThrough: 2 }), deps);

    const call = (deps.rebindAcrossSave as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(dec(call[0])).toBe("ORIGINAL"); // pre-save bytes
    expect(call[2]).toHaveLength(1); // only op "c": the first two are inside `ORIGINAL`
    expect(dec(call[3])).toBe("BAKED"); // the freshly written file
  });

  it("keeps the save when the rebind throws, and says the highlights are unverified", async () => {
    const f = memFs({ [doc]: "ORIGINAL" });
    const { deps } = makeDeps(f, {
      rebindAcrossSave: vi.fn(async () => {
        throw new Error("kernel reset");
      }),
    });
    const out = await saveBrepInPlace(baseInput(), deps);

    expect(out.status).toBe("saved");
    expect(f.text(doc)).toBe("BAKED");
    expect((out as { warnings: string[] }).warnings.join(" ")).toMatch(/Could not rebind entity ids.*verify them/);
  });
});

describe("saveMeshInPlace", () => {
  const doc = `${DIR}/cube.stl`;
  const journal = path.join(DIR, saveJournalFileName("cube.stl"));
  const baseInput = (over: Partial<MeshSaveInput> = {}): MeshSaveInput => ({
    docPath: doc,
    format: "stl",
    edits: [op("a"), op("b")],
    variables: [],
    bakedThrough: 0,
    firstSaveOfSession: true,
    ...over,
  });
  const makeDeps = (fsx: ReturnType<typeof memFs>, over: Partial<MeshSaveDeps> = {}) => {
    const deps: MeshSaveDeps = {
      fs: fsx.fs,
      confirm: vi.fn(async () => true),
      commitWatermark: vi.fn(async () => undefined),
      bake: vi.fn(async () => ({ bytes: enc("BAKED-STL"), outcomes: [], messages: [] })),
      ...over,
    };
    return deps;
  };

  it("replaces the source inside a journalled transaction and closes it afterwards", async () => {
    const f = memFs({ [doc]: "RAW-STL" });
    let journalDuringCommit: string | undefined;
    const deps = makeDeps(f, {
      commitWatermark: vi.fn(async () => {
        journalDuringCommit = f.text(journal);
      }),
    });
    const out = await saveMeshInPlace(baseInput(), deps);

    expect(out).toMatchObject({ status: "saved", baked: 2, madeBackup: true });
    expect(f.text(doc)).toBe("BAKED-STL");
    // The marker existed while the source and watermark disagreed, and is gone now.
    expect(parseSaveJournal(journalDuringCommit ?? "")?.bakedThrough).toBe(2);
    expect(f.store.has(journal)).toBe(false);
    // The pre-save bytes are in the one-deep backup.
    expect(f.text(`${doc}.bak`)).toBe("RAW-STL");
    expect(deps.commitWatermark).toHaveBeenCalledWith(2);
  });

  it("rolls the source back and closes the journal when the watermark cannot be written", async () => {
    const f = memFs({ [doc]: "RAW-STL" });
    const deps = makeDeps(f, {
      commitWatermark: vi.fn(async () => {
        throw new Error("read-only sidecar");
      }),
    });
    const out = await saveMeshInPlace(baseInput(), deps);

    expect(out.status).toBe("failed");
    expect((out as { message: string }).message).toMatch(/restored to its pre-save bytes/);
    expect(f.text(doc)).toBe("RAW-STL");
    expect(f.store.has(journal)).toBe(false);
  });

  it("closes the journal when the source never moved", async () => {
    const f = memFs({ [doc]: "RAW-STL" }, (call, p) => call === "rename" && p === doc);
    const deps = makeDeps(f);
    const out = await saveMeshInPlace(baseInput(), deps);

    expect(out.status).toBe("failed");
    expect(f.text(doc)).toBe("RAW-STL");
    expect(f.store.has(journal)).toBe(false);
    expect(deps.commitWatermark).not.toHaveBeenCalled();
  });

  it("bakes only the unbaked tail and does not ask again after the first save", async () => {
    const f = memFs({ [doc]: "RAW-STL" });
    const deps = makeDeps(f);
    const out = await saveMeshInPlace(baseInput({ edits: [op("a"), op("b"), op("c")], bakedThrough: 2, firstSaveOfSession: false }), deps);

    expect(out).toMatchObject({ status: "saved", baked: 1, madeBackup: false });
    expect((deps.bake as ReturnType<typeof vi.fn>).mock.calls[0][2]).toHaveLength(1);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(f.store.has(`${doc}.bak`)).toBe(false);
  });

  it("warns, by index and reason, about edits the bake skipped", async () => {
    const f = memFs({ [doc]: "RAW-STL" });
    const deps = makeDeps(f, {
      bake: vi.fn(async () => ({
        bytes: enc("BAKED-STL"),
        outcomes: [
          { index: 0, kind: "translate", applied: true },
          { index: 1, kind: "addHole", applied: false, diagnostic: "target did not resolve" },
        ] as OpOutcome[],
        messages: [],
      })),
    });
    const out = await saveMeshInPlace(baseInput(), deps);

    expect(out.status).toBe("saved");
    expect((out as { warnings: string[] }).warnings.join(" ")).toMatch(/1 of 2.*#2 \(addHole\) — target did not resolve/);
  });

  it("does nothing when cancelled", async () => {
    const f = memFs({ [doc]: "RAW-STL" });
    const deps = makeDeps(f, { confirm: vi.fn(async () => false) });
    const out = await saveMeshInPlace(baseInput(), deps);

    expect(out).toEqual({ status: "cancelled" });
    expect(f.log).toEqual([]);
    expect(deps.bake).not.toHaveBeenCalled();
  });
});
