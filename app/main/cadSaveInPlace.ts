/**
 * Interactive "bake into the source file" for a CAD tab — the KKSS port of
 * cad/src/provider.ts's `bakeTailToSource` / `bakeMeshToSource` (roadmap
 * "Interactive bake").
 *
 * Electron-free with every side effect injected, for the same reason
 * `cadOpOutcomes.ts` and `documentReplacement.ts` are: `CadHost` imports
 * Electron and cannot run under vitest, and the part of this flow worth testing
 * is exactly its ORDERING — source write first, watermark second, and a defined
 * recovery for each way the pair can disagree afterwards. `cadHost.ts` wires the
 * real kernel, filesystem and prompts into {@link SaveInPlaceDeps}.
 *
 * Two deliberate departures from the provider, both forced by KKSS's shape:
 *
 *  - **Mesh bytes come from the compute worker's `bakeMeshEdits`, not the
 *    webview's `exportMesh` round trip.** That is what `cad__save_model` uses,
 *    it needs no WebGL scene, and it keeps mesh-edit replay in the worker (the
 *    invariant `cadMeshInput.ts` records). The viewer and the worker run the
 *    same `applyEditsMesh`, so the output is the same model.
 *  - **There is no source watcher to suppress.** The provider sets
 *    `expectOwnSourceSave` around its rename; KKSS has no watcher on the source,
 *    so a reload after the write is simply `loadModel`.
 *
 * Invariants kept from the provider (each one guards a silent-wrong-geometry
 * failure, not a nicety):
 *
 *  - The watermark advances only after the source is fully written, and a
 *    failed advance rolls the source back to its pre-save bytes — otherwise the
 *    next open replays the same tail over geometry that already contains it.
 *  - The first save of a session copies a one-deep `<file>.bak`.
 *  - The source is replaced through a temp sibling + rename, never written in
 *    place, so a crash mid-write cannot truncate it.
 *  - Every save runs inside the recoverable transaction (`saveRecovery.ts`,
 *    cad 3.26.0) — mesh AND B-rep alike — so a process death between the
 *    rename and the watermark is repaired on the next open instead of
 *    double-applying. The journal also refreshes the one-deep `.bak` on the
 *    session's first save, replacing the old inline copy.
 */import * as path from "node:path";
import type { EditOp, OpOutcome } from "../../cad/src/editOps";
import type { ParamVariable } from "../../cad/src/editVariables";
import { replayTail } from "../../cad/src/editsSidecar";
import { EXPORT_EXTENSION } from "../../cad/src/exportTargets";
import type { CadFormat } from "../../cad/src/fileRouter";
import { displayUnitFromUnitName, type DisplayUnit } from "../../cad/src/lengthUnits";
import { detectIgesLengthUnit } from "../../cad/src/igesUnits";
import { detectStepLengthUnit } from "../../cad/src/stepUnits";
import { beginSave, endSave, savePaths } from "../../cad/src/saveRecovery";
import type { Annotation, Layer, Part } from "../../cad/src/protocol";

export type BrepSaveFormat = Extract<CadFormat, "step" | "iges" | "brep">;
export type MeshSaveFormat = Extract<CadFormat, "stl" | "obj" | "ply">;

/** The filesystem calls a save makes, so a test can fail any one of them. */
export interface SaveFs {
  readFile(p: string): Promise<Uint8Array>;
  writeFile(p: string, bytes: Uint8Array): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string): Promise<void>;
}

export interface SaveInPlaceDeps {
  fs: SaveFs;
  /** Modal Save in place / Cancel. Resolves false on cancel. */
  confirm(message: string): Promise<boolean>;
  /**
   * Advances the edit history's save marker to `watermark` and persists it.
   * The host clears its pending autosave timer FIRST (a stale-watermark write
   * must not land after this one) and updates its in-memory watermark. If the
   * write throws, the host's previous watermark must still be in effect — this
   * module then rolls the source back, so the pair agrees again.
   */
  commitWatermark(watermark: number): Promise<void>;
}

export interface BrepSaveInput {
  docPath: string;
  format: BrepSaveFormat;
  /** The full edit history (baked prefix + unbaked tail). */
  edits: EditOp[];
  bakedThrough: number;
  parts: Part[];
  annotations: Annotation[];
  layers: Layer[];
  /** True until this session has made its `.bak` — the first save asks. */
  firstSaveOfSession: boolean;
}

export interface BrepSaveDeps extends SaveInPlaceDeps {
  /** Reads the source and, for a `.scad`/`.csg` base, converts it. */
  readSource(): Promise<{ bytes: Uint8Array; format: CadFormat }>;
  /** `cadCompute.exportBRep` over the unbaked tail, at the file's own unit. */
  exportBRep(
    src: { bytes: Uint8Array; format: CadFormat },
    tail: EditOp[],
    unit: DisplayUnit,
    parts: Part[]
  ): Promise<Uint8Array>;
  /**
   * Two-byte save-time rebind: the pre-save document (`oldBytes` + `oldOps`)
   * against the freshly baked bytes with an empty tail. Entity ids are
   * renumbered by the re-emit, so Parts/annotations/layers must follow or their
   * highlights land on the wrong faces.
   *
   * `oldOps` is the unbaked TAIL, never the full history: `oldBytes` already
   * contains the baked prefix, so replaying the whole list over it would apply
   * that prefix twice on every save after the first. (cad's own `save_model`
   * and provider pass the full list; they are right only while the watermark is
   * still 0, which is why this is not copied from them.)
   */
  rebindAcrossSave(
    oldBytes: Uint8Array,
    oldFormat: CadFormat,
    oldOps: EditOp[],
    newBytes: Uint8Array,
    parts: Part[],
    annotations: Annotation[],
    layers: Layer[]
  ): Promise<{ parts: Part[]; annotations: Annotation[]; layers: Layer[] }>;
}

export interface Rebound {
  parts?: Part[];
  annotations?: Annotation[];
  layers?: Layer[];
}

export type SaveOutcome =
  | { status: "cancelled" }
  | { status: "failed"; message: string }
  | {
      status: "saved";
      /** Ops baked by this save (the tail length). */
      baked: number;
      /** Set the moment this save made the `.bak`. */
      madeBackup: boolean;
      /** Rebound ids, when the rebind produced different arrays. */
      rebound?: Rebound;
      /** Non-fatal notes (a rebind failure, skipped mesh ops). */
      warnings: string[];
    };

/**
 * The file's own declared unit (STEP/IGES header scan), so an INCH-declared
 * file stays inch-declared after a re-emit. Everything else is millimetres.
 */
export function detectSourceDisplayUnit(bytes: Uint8Array, format: CadFormat): DisplayUnit {
  if (format !== "step" && format !== "iges") return "mm";
  const text = Buffer.from(bytes).toString("latin1");
  const declared = format === "step" ? detectStepLengthUnit(text) : detectIgesLengthUnit(text);
  return displayUnitFromUnitName(declared) ?? "mm";
}

/** `<base>.save-tmp.<ext>` — the sibling a B-rep bake is written to first. */
export function brepTempName(fileName: string, format: BrepSaveFormat): string {
  return `${fileName.replace(/\.[^.]+$/, "")}.save-tmp.${EXPORT_EXTENSION[format]}`;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function brepConfirmText(tail: number, fileName: string): string {
  return (
    `Save ${tail} edit op(s) into ${fileName} itself? The file is re-emitted, not patched: ` +
    `entity numbering and authoring metadata are not preserved, and per-part colour is not carried over. ` +
    `Assembly structure and part names survive. This cannot be undone past the save point.`
  );
}

export function meshConfirmText(tail: number, fileName: string): string {
  return (
    `Save ${tail} edit op(s) into ${fileName} itself? The file is re-emitted from the edited model, not patched: ` +
    `facet structure and authoring metadata are not preserved. This cannot be undone past the save point.`
  );
}

/** Bakes the unbaked tail of a STEP/IGES/BREP source into the file itself. */
export async function saveBrepInPlace(input: BrepSaveInput, deps: BrepSaveDeps): Promise<SaveOutcome> {
  const { docPath, format, edits, bakedThrough } = input;
  const fileName = path.basename(docPath);
  if (edits.length < bakedThrough) {
    return {
      status: "failed",
      message: "The op list changed below the save point — close and reopen the file to work from the saved state.",
    };
  }
  const tail = replayTail(edits, bakedThrough);
  try {
    const src = await deps.readSource();
    // Save at the file's own declared unit: an INCH STEP stays INCH-declared,
    // geometrically identical on reopen.
    const unit = detectSourceDisplayUnit(src.bytes, format);
    if (input.firstSaveOfSession && !(await deps.confirm(brepConfirmText(tail.length, fileName)))) {
      return { status: "cancelled" };
    }
    const baked = await deps.exportBRep(src, tail, unit, input.parts);

    // Open the recoverable transaction BEFORE touching the source (cad 3.26.0
    // provider.ts parity): both hashes are computable right now from bytes
    // already in hand, and `beginSave` also refreshes the one-deep `.bak` on
    // the session's first save. A crash at every point after this call is
    // repairable on the next open; a crash before it changed nothing at all.
    const dir = path.dirname(docPath);
    const sibling = (name: string): string => path.join(dir, name);
    const txnPaths = savePaths(fileName, EXPORT_EXTENSION[format]);
    const journalDeps = {
      writeBytes: (name: string, bytes: Uint8Array) => deps.fs.writeFile(sibling(name), bytes),
      readBytesOrNull: async (name: string) => {
        try {
          return await deps.fs.readFile(sibling(name));
        } catch {
          return null;
        }
      },
      deleteFile: (name: string) => deps.fs.rm(sibling(name)),
    };
    const journal = await beginSave(
      {
        paths: txnPaths,
        fileName,
        format,
        bakedThrough: edits.length,
        preSaveBytes: src.bytes,
        bakedBytes: baked,
        writeBackup: input.firstSaveOfSession,
      },
      journalDeps
    );
    let madeBackup = false;
    if (input.firstSaveOfSession) madeBackup = true;
    const tmp = path.join(path.dirname(docPath), txnPaths.temp);
    try {
      await deps.fs.writeFile(tmp, baked);
      await deps.fs.rename(tmp, docPath);
    } catch (err) {
      await deps.fs.rm(tmp).catch(() => undefined);
      // The source never moved, so the journal describes a save that did not
      // happen: close it rather than leaving a marker for a later open.
      await endSave(txnPaths, journal, journalDeps).catch(() => undefined);
      throw err;
    }

    // The source is rewritten; the watermark has NOT landed. If it cannot, the
    // pair disagrees (baked file, stale sidecar) and the next open would
    // double-apply the tail — so put the pre-save bytes back and say so.
    try {
      await deps.commitWatermark(edits.length);
    } catch (wmErr) {
      await deps.fs.writeFile(docPath, src.bytes).catch(() => undefined);
      // The rollback put the source back to its pre-save bytes, so the
      // journal's pre-save hash is true again and the next open's `discard`
      // is the right resolution. Closing it here is equivalent and keeps the
      // pair settled immediately.
      await endSave(txnPaths, journal, journalDeps).catch(() => undefined);
      return {
        status: "failed",
        message:
          `Save in place failed: the watermark write failed (${message(wmErr)}) — the source file was ` +
          `restored to its pre-save bytes; close any dirty sidecar tab and save again.`,
      };
    }
    // The pair agrees: source baked, watermark advanced. Closing the
    // transaction is a compare-before-delete, so a concurrent editor's newer
    // marker is never removed by this save.
    await endSave(txnPaths, journal, journalDeps).catch(() => undefined);

    const warnings: string[] = [];
    let rebound: Rebound | undefined;
    try {
      const result = await deps.rebindAcrossSave(
        src.bytes,
        src.format,
        tail,
        baked,
        input.parts,
        input.annotations,
        input.layers
      );
      rebound = {
        ...(JSON.stringify(result.parts) !== JSON.stringify(input.parts) ? { parts: result.parts } : {}),
        ...(JSON.stringify(result.annotations) !== JSON.stringify(input.annotations)
          ? { annotations: result.annotations }
          : {}),
        ...(JSON.stringify(result.layers) !== JSON.stringify(input.layers) ? { layers: result.layers } : {}),
      };
    } catch (err) {
      // The save itself stands. Say loudly that highlights were assigned
      // against the pre-save geometry rather than claiming they were verified.
      warnings.push(
        `Could not rebind entity ids across the save: ${message(err)}. ` +
          `Part/annotation/layer highlights were assigned against the pre-save geometry — verify them.`
      );
    }
    return { status: "saved", baked: tail.length, madeBackup, rebound, warnings };
  } catch (err) {
    return { status: "failed", message: `Save in place failed: ${message(err)}` };
  }
}

export interface MeshSaveInput {
  docPath: string;
  format: MeshSaveFormat;
  edits: EditOp[];
  variables: ParamVariable[];
  bakedThrough: number;
  firstSaveOfSession: boolean;
}

export interface MeshSaveDeps extends SaveInPlaceDeps {
  /** `cadCompute.bakeMeshEdits(bytes, format, tail, format)`. */
  bake(
    bytes: Uint8Array,
    format: MeshSaveFormat,
    tail: EditOp[]
  ): Promise<{ bytes: Uint8Array; outcomes: OpOutcome[]; messages: string[] }>;
}

/** Bakes the unbaked tail of an STL/OBJ/PLY source into the file itself. */
export async function saveMeshInPlace(input: MeshSaveInput, deps: MeshSaveDeps): Promise<SaveOutcome> {
  const { docPath, format, edits, bakedThrough } = input;
  const fileName = path.basename(docPath);
  if (edits.length < bakedThrough) {
    return {
      status: "failed",
      message: "The op list changed below the save point — close and reopen the file to work from the saved state.",
    };
  }
  const tail = replayTail(edits, bakedThrough);
  const dir = path.dirname(docPath);
  const sibling = (name: string): string => path.join(dir, name);
  try {
    if (input.firstSaveOfSession && !(await deps.confirm(meshConfirmText(tail.length, fileName)))) {
      return { status: "cancelled" };
    }
    const preSaveBytes = await deps.fs.readFile(docPath);
    const result = await deps.bake(preSaveBytes, format, tail);
    const warnings: string[] = [];
    const skipped = result.outcomes.filter((o) => !o.applied);
    if (skipped.length) {
      warnings.push(
        `${skipped.length} of ${tail.length} pending mesh edit op(s) did not apply and are not in the saved file: ` +
          skipped.map((o) => `#${o.index + 1} (${o.kind})${o.diagnostic ? ` — ${o.diagnostic}` : ""}`).join("; ")
      );
    }
    warnings.push(...result.messages);

    // Open the recoverable transaction BEFORE touching the source: a process
    // death at any point after this is repaired on the next open (the journal
    // carries both hashes), and a death before it changed nothing at all.
    const paths = savePaths(fileName, EXPORT_EXTENSION[format]);
    const journalDeps = {
      writeBytes: (name: string, bytes: Uint8Array) => deps.fs.writeFile(sibling(name), bytes),
      readBytesOrNull: async (name: string) => {
        try {
          return await deps.fs.readFile(sibling(name));
        } catch {
          return null;
        }
      },
      deleteFile: (name: string) => deps.fs.rm(sibling(name)),
    };
    const journal = await beginSave(
      {
        paths,
        fileName,
        format,
        bakedThrough: edits.length,
        preSaveBytes,
        bakedBytes: result.bytes,
        writeBackup: input.firstSaveOfSession,
      },
      journalDeps
    );
    try {
      await deps.fs.writeFile(sibling(paths.temp), result.bytes);
      await deps.fs.rename(sibling(paths.temp), docPath);
    } catch (err) {
      await deps.fs.rm(sibling(paths.temp)).catch(() => undefined);
      // The source never moved, so the marker describes a save that did not
      // happen: close it rather than leave a later open to reason about it.
      await endSave(paths, journal, journalDeps).catch(() => undefined);
      throw err;
    }
    try {
      await deps.commitWatermark(edits.length);
    } catch (wmErr) {
      await deps.fs.writeFile(docPath, preSaveBytes).catch(() => undefined);
      // The rollback made the journal's pre-save hash true again; closing it
      // here is equivalent to what the next open's `discard` would do.
      await endSave(paths, journal, journalDeps).catch(() => undefined);
      return {
        status: "failed",
        message:
          `Save in place failed: the watermark write failed (${message(wmErr)}) — the source file was ` +
          `restored to its pre-save bytes; close any dirty sidecar tab and save again.`,
      };
    }
    await endSave(paths, journal, journalDeps).catch(() => undefined);
    return { status: "saved", baked: tail.length, madeBackup: input.firstSaveOfSession, warnings };
  } catch (err) {
    return { status: "failed", message: `Save in place failed: ${message(err)}` };
  }
}
