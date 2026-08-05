/**
 * CAD mode host adapter — a 1:1 port of cad/src/provider.ts's
 * resolveCustomEditor message loop onto Electron primitives.
 *
 * Substitutions relative to the extension (everything else is unchanged and
 * imported straight from the submodule):
 *   webview.postMessage            → WebContentsView.webContents.send
 *   onDidReceiveMessage            → ipcMain.on("cad:toHost")
 *   vscode.workspace.fs            → node:fs/promises (the three *Store.ts
 *                                    files re-implemented over the vscode-free
 *                                    *Sidecar parse/serialize modules)
 *   webview.asWebviewUri           → toKkssUrl (kkss-file:// scheme)
 *   OCCT/Gmsh service calls        → cadCompute worker RPC (same signatures,
 *                                    extensionPath = out/cad-runtime)
 *   showOpenDialog/showSaveDialog  → services/dialogs
 *   showQuickPick                  → services/quickPick modal window
 *   vscode.openWith                → hooks.onOpenRequest (router)
 */
import { ipcMain, WebContentsView } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { routeFile, type CadFormat, type FileRoute } from "../../cad/src/fileRouter";
import {
  encodeBuffer,
  type HostToWebview,
  type WebviewToHost,
  type Part,
} from "../../cad/src/protocol";
import {
  exportTargetsFor,
  EXPORT_EXTENSION,
  EXPORT_LABEL,
  UNIT_CONVERTIBLE_FORMATS,
} from "../../cad/src/exportTargets";
import { parsePartsJson, serializePartsJson } from "../../cad/src/partsSidecar";
import { parseEditsJson, serializeEditsJson, type ParsedEdits } from "../../cad/src/editsSidecar";
import { parseMeshJson, serializeMeshJson, generateGeoScript } from "../../cad/src/meshOptionsSidecar";
import { parseAnnotationsJson, serializeAnnotationsJson } from "../../cad/src/annotationsSidecar";
import { parseViewStateJson, serializeViewStateJson } from "../../cad/src/viewStateSidecar";
import { buildPreprocessZip, readPreprocessZip } from "../../cad/src/preprocessArchive";
import {
  normalizeTessellationQuality,
  tessellationParamsFor,
  DEFAULT_TESSELLATION_QUALITY,
  type TessellationQuality,
} from "../../cad/src/tessellationQuality";
import {
  DEFAULT_MESH_OPTIONS,
  applyStlPartSizeOverride,
  scaleMeshOptionsForUnit,
  scalePartsMeshSizeForUnit,
  type MeshOptions,
} from "../../cad/src/meshOptions";
import { meshExportFormat } from "../../cad/src/meshExportFormats";
import { DISPLAY_UNITS, UNIT_LABELS, unitScaleFactor, type DisplayUnit } from "../../cad/src/lengthUnits";
import { detectStepLengthUnit } from "../../cad/src/stepUnits";
import { detectIgesLengthUnit } from "../../cad/src/igesUnits";
import { scaleStlBytes } from "../../cad/src/stlParser";
import { normalizeViewerDefaults } from "../../cad/src/viewerDefaults";
import type { EditOp } from "../../cad/src/editOps";
import type { ParamVariable } from "../../cad/src/editVariables";
import type { Annotation, ViewState } from "../../cad/src/protocol";
import type { MeshGenerationInput } from "../../cad/src/gmshService";
import { cadCompute } from "./cadComputeClient";
import { toKkssUrl, allowRoot } from "./protocol";
import { showOpenDialog, showSaveDialog } from "./services/dialogs";
import { showQuickPick } from "./services/quickPick";
import { stateStore } from "./services/stateStore";

/**
 * stateStore keys backing the viewer defaults the extension gets from its
 * `cadPreview.*` settings — see `sendViewerDefaults`. Exported so the Settings
 * menu writes the same names.
 */
export const CAD_DEFAULT_KEYS = {
  background: "cadBackground",
  meshSizePreset: "cadDefaultMeshSizePreset",
  showGridAndAxes: "cadShowGridAndAxesOnOpen",
  upAxis: "cadUpAxis",
  /** cadPreview.tessellationQuality — read fresh on every B-rep load. */
  tessellationQuality: "cadTessellationQuality",
} as const;

/** Debounce window for autosaving the parts/edits/mesh-options sidecars (provider.ts). */
const PARTS_SAVE_DEBOUNCE_MS = 500;

const BREP_FORMATS: ReadonlySet<CadFormat> = new Set(["step", "iges", "brep"]);
const CAD_OPEN_FILTER = {
  name: "CAD / Mesh",
  // Mirrors provider.openFileDialog's own filter — the second row is the
  // meshio++ route (cad 1.2.x). Note the router still prefers post mode for
  // those (app/main/router.ts); this dialog is the CAD-mode importer.
  extensions: [
    "stl", "obj", "ply", "gltf", "glb", "step", "stp", "iges", "igs", "brep",
    "vtk", "vtu", "med", "cgns", "exo", "e", "xdmf", "mdpa",
  ],
};

interface PendingExport {
  resolve: (result: { data: string; binary: boolean }) => void;
  reject: (err: Error) => void;
}

// ---- The three cad *Store.ts files, re-implemented on node:fs --------------

const readParts = async (modelPath: string): Promise<Part[]> => {
  try {
    return parsePartsJson(await fs.readFile(`${modelPath}.parts.json`, "utf8"));
  } catch {
    return [];
  }
};
const writeParts = (modelPath: string, parts: Part[]): Promise<void> =>
  fs.writeFile(`${modelPath}.parts.json`, serializePartsJson(path.basename(modelPath), parts), "utf8");

const readEdits = async (modelPath: string): Promise<ParsedEdits> => {
  try {
    return parseEditsJson(await fs.readFile(`${modelPath}.edits.json`, "utf8"));
  } catch {
    return { ops: [], variables: [] };
  }
};
const writeEdits = (modelPath: string, ops: EditOp[], variables: ParamVariable[]): Promise<void> =>
  fs.writeFile(`${modelPath}.edits.json`, serializeEditsJson(path.basename(modelPath), ops, variables), "utf8");

const readAnnotations = async (modelPath: string): Promise<Annotation[]> => {
  try {
    return parseAnnotationsJson(await fs.readFile(`${modelPath}.annotations.json`, "utf8"));
  } catch {
    return [];
  }
};
const writeAnnotations = (modelPath: string, annotations: Annotation[]): Promise<void> =>
  fs.writeFile(
    `${modelPath}.annotations.json`,
    serializeAnnotationsJson(path.basename(modelPath), annotations),
    "utf8"
  );

const readViewState = async (modelPath: string): Promise<ViewState | null> => {
  try {
    return parseViewStateJson(await fs.readFile(`${modelPath}.view.json`, "utf8"));
  } catch {
    return null;
  }
};
const writeViewState = (modelPath: string, view: ViewState): Promise<void> =>
  fs.writeFile(`${modelPath}.view.json`, serializeViewStateJson(path.basename(modelPath), view), "utf8");

const readMeshOptions = async (modelPath: string): Promise<MeshOptions> => {
  try {
    return parseMeshJson(await fs.readFile(`${modelPath}.mesh.json`, "utf8"));
  } catch {
    return DEFAULT_MESH_OPTIONS;
  }
};
const writeMeshOptions = (modelPath: string, options: MeshOptions): Promise<void> =>
  fs.writeFile(`${modelPath}.mesh.json`, serializeMeshJson(path.basename(modelPath), options), "utf8");
const writeGeoScript = (modelPath: string, options: MeshOptions): Promise<void> =>
  fs.writeFile(`${modelPath}.geo`, generateGeoScript(path.basename(modelPath), options), "utf8");

// -----------------------------------------------------------------------------

export interface CadHostHooks {
  /** Open a file chosen outside this host (router decides the mode). */
  onOpenRequest(fsPath: string): void;
  /** Current file changed (shell title). */
  onTitle(fileName: string | null): void;
  /** A mesh file was exported to disk (post mode may want to open it). */
  onMeshExported(fsPath: string): void;
}

export class CadHost {
  private doc: { path: string; route: FileRoute | undefined } | undefined;
  private readonly pending = new Map<string, PendingExport>();
  private partsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private editsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private meshSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private annotationsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private currentEdits: EditOp[] = [];
  private currentVariables: ParamVariable[] = [];
  private currentParts: Part[] = [];
  private currentAnnotations: Annotation[] = [];
  private currentViewState: ViewState | undefined;
  private currentMeshOptions: MeshOptions | undefined;
  /** Guards stale async completions after the document changes. */
  private epoch = 0;

  constructor(
    private readonly view: WebContentsView,
    /** out/cad-runtime — the dist/-shaped WASM home the cad services expect. */
    private readonly runtimePath: string,
    private readonly hooks: CadHostHooks,
    /** Stable per-tab id — keys this session's slot in the worker's B-rep cache. */
    private readonly sessionId: string
  ) {
    ipcMain.on("cad:toHost", (event, msg: WebviewToHost) => {
      if (event.sender !== view.webContents) return;
      void this.onMessage(msg);
    });
  }

  get currentFile(): string | undefined {
    return this.doc?.path;
  }

  private post = (msg: HostToWebview): void => {
    if (process.env.KKSS_E2E) console.log(`[cad] host → webview: ${msg.type}`);
    this.view.webContents.send("cad:toWebview", msg);
  };

  /** Opens `fsPath` in this mode's view (replaces any current document). */
  openPath(fsPath: string): void {
    this.disposeSession();
    this.doc = { path: fsPath, route: routeFile(fsPath) };
    allowRoot(path.dirname(fsPath));
    this.hooks.onTitle(path.basename(fsPath));
    // Fresh page → bundle boots → posts "ready" → session start (same
    // handshake order as resolveCustomEditor).
    this.view.webContents.reload();
  }

  /** File ▸ Open (cad-preview.open / webview "openFile" message). */
  async openFileDialog(): Promise<void> {
    const picked = await showOpenDialog({
      openLabel: "Open in CAD Preview",
      filters: [CAD_OPEN_FILTER],
    });
    if (picked) this.hooks.onOpenRequest(picked);
  }

  /** File ▸ Save — immediately flushes all sidecars (provider flushSidecars). */
  async flushSidecars(): Promise<void> {
    if (!this.doc) return;
    if (this.partsSaveTimer) clearTimeout(this.partsSaveTimer);
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
    if (this.annotationsSaveTimer) clearTimeout(this.annotationsSaveTimer);
    if (this.viewSaveTimer) clearTimeout(this.viewSaveTimer);
    try {
      await Promise.all([
        writeParts(this.doc.path, this.currentParts),
        writeEdits(this.doc.path, this.currentEdits, this.currentVariables),
        writeAnnotations(this.doc.path, this.currentAnnotations),
        ...(this.currentViewState ? [writeViewState(this.doc.path, this.currentViewState)] : []),
        ...(this.currentMeshOptions
          ? [
              writeMeshOptions(this.doc.path, this.currentMeshOptions),
              writeGeoScript(this.doc.path, this.currentMeshOptions),
            ]
          : []),
      ]);
      this.post({ type: "status", text: "Saved" });
    } catch (err) {
      this.post({ type: "error", message: `Save failed: ${(err as Error).message}` });
    }
  }

  /** File ▸ Save As / Export (quick-pick + save dialog). */
  export(): void {
    if (this.doc?.route) void this.handleExport(this.doc.path, this.doc.route);
  }

  /** File ▸ Screenshot (cad-preview.screenshot / the View ▾ menu's item). */
  screenshot(): void {
    if (this.doc) void this.handleScreenshot(this.doc.path);
  }

  /** File ▸ Save Preprocess… (cad-preview.savePreprocess). */
  savePreprocess(): void {
    if (this.doc) void this.flushSidecars().then(() => this.handleSavePreprocess(this.doc!.path));
  }

  /** File ▸ Load Preprocess… (cad-preview.loadPreprocess) — needs no open document. */
  loadPreprocess(): void {
    void this.loadPreprocessDialog();
  }

  /** Tab closed — tear down this session's state (timers, pending work, the
   *  worker's cached B-rep entry). The WebContentsView itself is disposed by
   *  the caller (windows.ts's closeTab). */
  dispose(): void {
    this.disposeSession();
  }

  private disposeSession(): void {
    this.epoch++;
    if (this.partsSaveTimer) clearTimeout(this.partsSaveTimer);
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
    if (this.annotationsSaveTimer) clearTimeout(this.annotationsSaveTimer);
    if (this.viewSaveTimer) clearTimeout(this.viewSaveTimer);
    this.partsSaveTimer = this.editsSaveTimer = this.meshSaveTimer = undefined;
    this.annotationsSaveTimer = this.viewSaveTimer = undefined;
    for (const p of this.pending.values()) p.reject(new Error("Document closed"));
    this.pending.clear();
    this.currentEdits = [];
    this.currentVariables = [];
    this.currentParts = [];
    this.currentAnnotations = [];
    this.currentViewState = undefined;
    this.currentMeshOptions = undefined;
    // The provider frees its per-document BRepCacheEntry in onDidDispose; here
    // the entry lives in the worker, so ask it to. Fire-and-forget: a failure
    // only costs the next load a fresh parse.
    void cadCompute.releaseBRepCache(this.sessionId).catch(() => {});
  }

  /**
   * (Re)tessellates a B-rep source with the current edits, (re)loads a mesh, or
   * (re)converts a meshio-only source.
   */
  private loadModel(): void {
    if (!this.doc?.route) return;
    if (this.doc.route.strategy === "three") {
      this.post({ type: "loadUrl", url: toKkssUrl(this.doc.path), format: this.doc.route.format });
    } else if (this.doc.route.strategy === "meshio") {
      // handleMeshio owns the parts round trip for this route (it may
      // auto-create Parts from region data) — keep currentParts in sync so an
      // immediate Save doesn't flush a stale [] over what was just written.
      void this.handleMeshio(this.doc.path, this.doc.route.format).then((parts) => {
        this.currentParts = parts;
      });
    } else {
      void this.handleBRep(
        this.doc.path,
        this.doc.route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        this.currentEdits
      );
    }
  }

  /**
   * Best-effort entity-id rebinding after ANY op-stack change (provider
   * rebindPartsOnChange). Persists the parts sidecar immediately — not
   * debounced, this is host-initiated and correctness-critical — and posts a
   * fresh "parts" message, which the webview's PartsModel.load() consumes
   * silently, exactly like the initial `ready` hydration does.
   */
  private async rebindPartsOnChange(previousOps: EditOp[], newOps: EditOp[]): Promise<void> {
    const doc = this.doc;
    if (!doc?.route || doc.route.strategy !== "occt") return;
    if (this.currentParts.length === 0) return;
    if (JSON.stringify(previousOps) === JSON.stringify(newOps)) return;
    const epoch = this.epoch;
    try {
      const bytes = await fs.readFile(doc.path);
      const result = await cadCompute.rebindPartsAcrossOps(
        this.runtimePath,
        bytes,
        doc.route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        previousOps,
        newOps,
        this.currentParts
      );
      if (epoch !== this.epoch) return; // document changed while replaying
      // The provider detects "nothing to do" by reference identity on the
      // returned array; structured clone across the worker RPC always yields a
      // fresh one, so gate on the stats instead — which also skips the
      // provider's own harmless-but-pointless write when every id mapped to
      // itself.
      if (result.stats.rebound === 0 && result.stats.dropped === 0) return;
      this.currentParts = result.parts;
      await writeParts(doc.path, this.currentParts);
      this.post({ type: "parts", parts: this.currentParts });
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.post({ type: "error", message: `Could not rebind part entity ids: ${(err as Error).message}` });
    }
  }

  // Port of provider.ts onDidReceiveMessage, branch for branch.
  private async onMessage(msg: WebviewToHost): Promise<void> {
    if (msg.type === "ready") {
      if (!this.doc) {
        this.post({ type: "status", text: "No file open — use Open… in the toolbar" });
        return;
      }
      if (!this.doc.route) {
        this.post({ type: "error", message: `Unsupported file type: ${this.doc.path}` });
        return;
      }
      // Load edits before the model so a B-rep source is tessellated already-edited.
      const parsed = await readEdits(this.doc.path);
      this.currentEdits = parsed.ops;
      this.currentVariables = parsed.variables;
      this.loadModel();
      this.post({ type: "edits", ops: this.currentEdits, variables: this.currentVariables });
      // The meshio route's own handleMeshio (in loadModel) owns the parts
      // round trip for that route — calling both would double-post "parts".
      if (this.doc.route.strategy !== "meshio") {
        void this.sendParts().then((parts) => {
          this.currentParts = parts;
        });
      }
      void readAnnotations(this.doc.path).then((annotations) => {
        this.currentAnnotations = annotations;
        this.post({ type: "annotations", annotations });
      });
      void this.sendMeshOptions();
      void readViewState(this.doc.path).then((view) => {
        this.currentViewState = view ?? undefined;
        this.post({ type: "viewState", view });
      });
      this.sendViewerDefaults();
      return;
    }

    if (!this.doc) return;
    const doc = this.doc;

    if (msg.type === "partsChanged") {
      // Debounced autosave; the CAD file itself is never written, only the sidecar.
      this.currentParts = msg.parts;
      if (this.partsSaveTimer) clearTimeout(this.partsSaveTimer);
      this.partsSaveTimer = setTimeout(() => {
        void writeParts(doc.path, msg.parts).then(undefined, (err) =>
          this.post({ type: "error", message: `Could not save parts: ${(err as Error).message}` })
        );
      }, PARTS_SAVE_DEBOUNCE_MS);
      return;
    }

    if (msg.type === "editsChanged") {
      const previousOps = this.currentEdits;
      this.currentEdits = msg.ops;
      this.currentVariables = msg.variables;
      if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
      this.editsSaveTimer = setTimeout(() => {
        void writeEdits(doc.path, this.currentEdits, this.currentVariables).then(undefined, (err) =>
          this.post({ type: "error", message: `Could not save edits: ${(err as Error).message}` })
        );
      }, PARTS_SAVE_DEBOUNCE_MS);
      // B-rep edits are applied in the host, so re-tessellate immediately. Mesh
      // edits are applied in the webview itself, which already updated the view.
      if (doc.route && doc.route.strategy === "occt") {
        this.loadModel();
        void this.rebindPartsOnChange(previousOps, this.currentEdits);
      }
      return;
    }

    if (msg.type === "annotationsChanged") {
      // Pinned measurements — their own sidecar and debounce timer, same
      // pattern as parts/edits/mesh options.
      this.currentAnnotations = msg.annotations;
      if (this.annotationsSaveTimer) clearTimeout(this.annotationsSaveTimer);
      this.annotationsSaveTimer = setTimeout(() => {
        void writeAnnotations(doc.path, this.currentAnnotations).then(undefined, (err) =>
          this.post({ type: "error", message: `Could not save annotations: ${(err as Error).message}` })
        );
      }, PARTS_SAVE_DEBOUNCE_MS);
      return;
    }

    if (msg.type === "viewChanged") {
      // Camera / display mode / ortho / clip plane, persisted per document.
      this.currentViewState = msg.view;
      if (this.viewSaveTimer) clearTimeout(this.viewSaveTimer);
      this.viewSaveTimer = setTimeout(() => {
        void writeViewState(doc.path, msg.view).then(undefined, (err) =>
          this.post({ type: "error", message: `Could not save view state: ${(err as Error).message}` })
        );
      }, PARTS_SAVE_DEBOUNCE_MS);
      return;
    }

    if (msg.type === "meshingChanged") {
      this.currentMeshOptions = msg.options;
      if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
      this.meshSaveTimer = setTimeout(() => {
        void Promise.all([writeMeshOptions(doc.path, msg.options), writeGeoScript(doc.path, msg.options)]).then(
          undefined,
          (err) => this.post({ type: "error", message: `Could not save mesh options: ${(err as Error).message}` })
        );
      }, PARTS_SAVE_DEBOUNCE_MS);
      return;
    }

    if (msg.type === "meshingGenerate") {
      try {
        const input = await this.resolveMeshInput(msg.stl);
        if (!input) {
          this.post({ type: "meshingError", message: "No mesh geometry available: missing STL data." });
          return;
        }
        const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options);
        const startedAt = Date.now();
        const result = await cadCompute.generateMesh(this.runtimePath, input, options, parts);
        this.post({
          type: "meshingResult",
          positions: encodeBuffer(result.positions),
          indices: encodeBuffer(result.indices),
          edges: encodeBuffer(result.edges),
          elementGroups: result.elementGroups,
          nodeCount: result.nodeCount,
          elementCount: result.elementCount,
          elapsedMs: Date.now() - startedAt,
          quality: result.quality,
          worstElements: result.worstElements && {
            indices: encodeBuffer(result.worstElements.indices),
            threshold: result.worstElements.threshold,
            shownCount: result.worstElements.shownCount,
            belowThresholdCount: result.worstElements.belowThresholdCount,
          },
        });
      } catch (err) {
        this.post({ type: "meshingError", message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "meshingExport") {
      try {
        const unit = msg.unit ?? "mm";
        const input = await this.resolveMeshInput(msg.stl, unit);
        if (!input) {
          this.post({ type: "meshingError", message: "No mesh geometry available: missing STL data." });
          return;
        }
        const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options, unit);
        let savedPath: string | undefined;
        if (msg.target === "msh") {
          const result = await cadCompute.generateMesh(this.runtimePath, input, options, parts);
          savedPath = await this.promptSaveAndWrite(doc.path, "msh", "GMSH Mesh", async () =>
            Buffer.from(result.mshText, "utf8")
          );
        } else if (msg.target === "geoUnrolled") {
          const geo = await cadCompute.exportGeoUnrolled(this.runtimePath, input, options, parts);
          savedPath = await this.promptSaveAndWrite(doc.path, "geo_unrolled", "GMSH Unrolled Geometry", async (savePath) => {
            if (!geo.xao) return Buffer.from(geo.text, "utf8");
            // B-rep geometry can't be textually unrolled — write the XAO
            // companion beside the chosen path and point the Merge stub at it
            // (same fix-up as provider.ts).
            const xaoName = `${path.basename(savePath)}.xao`;
            await fs.writeFile(path.join(path.dirname(savePath), xaoName), geo.xao);
            const fixedText = geo.text.replace(/Merge "[^"]*\.xao";/, `Merge "${xaoName}";`);
            return Buffer.from(fixedText, "utf8");
          });
        } else if (msg.target === "mdpaElements" || msg.target === "mdpaGeometries") {
          const format = meshExportFormat(msg.target)!;
          const text = await cadCompute.exportMdpa(
            this.runtimePath,
            input,
            options,
            parts,
            msg.target === "mdpaElements" ? "elements" : "geometries"
          );
          savedPath = await this.promptSaveAndWrite(doc.path, format.extension, format.filterLabel, async () =>
            Buffer.from(text, "utf8")
          );
        } else if (msg.target === "med" || msg.target === "cgns" || msg.target === "xdmf") {
          // meshio++ bridge — Gmsh's own writers can't produce these; re-encode
          // generateMesh's MSH 4.1 text via exportViaMeshio.
          const format = meshExportFormat(msg.target)!;
          const meshed = await cadCompute.generateMesh(this.runtimePath, input, options, parts);
          const { bytes, companion } = await cadCompute.exportViaMeshio(meshed.mshText, msg.target);
          savedPath = await this.promptSaveAndWrite(doc.path, format.extension, format.filterLabel, async (savePath) => {
            if (!companion) return Buffer.from(bytes);
            // xdmf's HDF5 companion — same "write beside the chosen save path
            // and rewrite the embedded reference" pattern as geoUnrolled's .xao.
            const h5Name = `${path.basename(savePath).replace(/\.[^.]+$/, "")}.h5`;
            await fs.writeFile(path.join(path.dirname(savePath), h5Name), companion.bytes);
            const fixedText = Buffer.from(bytes).toString("utf8").split(companion.name).join(h5Name);
            return Buffer.from(fixedText, "utf8");
          });
        } else {
          const format = meshExportFormat(msg.target);
          if (!format) throw new Error(`Unknown mesh export format: ${msg.target}`);
          const text = await cadCompute.exportMeshFormat(this.runtimePath, input, options, parts, msg.target);
          savedPath = await this.promptSaveAndWrite(doc.path, format.extension, format.filterLabel, async () =>
            Buffer.from(text, "utf8")
          );
        }
        // Pre → post sync: a written mesh may be openable in post mode. The
        // router (in index.ts) decides whether this format actually is.
        if (savedPath) this.hooks.onMeshExported(savedPath);
      } catch (err) {
        this.post({ type: "error", message: `Export failed: ${(err as Error).message}` });
      }
      return;
    }

    if (msg.type === "openFile") {
      void this.openFileDialog();
      return;
    }

    if (msg.type === "openPath") {
      // Drag-and-drop onto the 3D view. The router decides the owning mode,
      // exactly as it does for the Open dialog.
      this.hooks.onOpenRequest(msg.path);
      return;
    }

    if (msg.type === "saveSidecars") {
      void this.flushSidecars();
      return;
    }

    if (msg.type === "exportRequest") {
      if (doc.route) void this.handleExport(doc.path, doc.route);
      return;
    }

    if (msg.type === "savePreprocessRequest") {
      void this.flushSidecars().then(() => this.handleSavePreprocess(doc.path));
      return;
    }

    if (msg.type === "loadPreprocessRequest") {
      void this.loadPreprocessDialog();
      return;
    }

    if (msg.type === "log") {
      console.log(`[cad:webview] ${msg.message}`);
      return;
    }

    if (msg.type === "exportResult" || msg.type === "exportError") {
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (msg.type === "exportResult") p.resolve(msg);
      else p.reject(new Error(msg.message));
      return;
    }

    if (msg.type === "screenshotButtonClicked") {
      void this.handleScreenshot(doc.path);
      return;
    }

    if (msg.type === "screenshotResult" || msg.type === "screenshotError") {
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (msg.type === "screenshotResult") p.resolve({ data: msg.data, binary: true });
      else p.reject(new Error(msg.message));
      return;
    }

    if (msg.type === "massPropertiesRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error(
            "Mass properties are computed for B-rep sources on the host; mesh sources compute this client-side."
          );
        }
        const bytes = await fs.readFile(doc.path);
        const properties = await cadCompute.computeMassProperties(
          this.runtimePath,
          bytes,
          doc.route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          this.currentEdits,
          msg.entityId
        );
        this.post({ type: "massPropertiesResult", requestId: msg.requestId, properties });
      } catch (err) {
        this.post({ type: "massPropertiesError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "measureExactRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error(
            "Exact measurement requires a B-rep source; mesh sources have no host-side geometry to re-derive it from."
          );
        }
        const bytes = await fs.readFile(doc.path);
        const result = await cadCompute.measureExact(
          this.runtimePath,
          bytes,
          doc.route.format as Extract<CadFormat, "step" | "iges" | "brep">,
          this.currentEdits,
          msg.kind,
          msg.entityIdA,
          msg.entityIdB
        );
        this.post({ type: "measureExactResult", requestId: msg.requestId, result });
      } catch (err) {
        this.post({ type: "measureExactError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "colorFieldRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "meshio") {
          throw new Error(
            "Colour-by-field is only available for meshio++-imported sources (VTK/MED/CGNS/Exodus/XDMF/MDPA)."
          );
        }
        const bytes = await fs.readFile(doc.path);
        const result = await cadCompute.readMeshioFieldValues(bytes, doc.route.format, msg.field, msg.kind);
        if (!result) {
          throw new Error(`Field "${msg.field}" not found, not a plain scalar, or the boundary isn't pure triangles.`);
        }
        this.post({
          type: "colorFieldResult",
          requestId: msg.requestId,
          values: encodeBuffer(result.values),
          min: result.min,
          max: result.max,
        });
      } catch (err) {
        this.post({ type: "colorFieldError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }
  }

  private async handleBRep(
    modelPath: string,
    format: Extract<CadFormat, "step" | "iges" | "brep">,
    ops: EditOp[]
  ): Promise<void> {
    const epoch = this.epoch;
    try {
      this.post({ type: "status", text: `Loading ${format.toUpperCase()} kernel…` });
      const bytes = await fs.readFile(modelPath);
      this.post({ type: "status", text: `Tessellating ${format.toUpperCase()}…` });
      // Read the quality fresh on every load (cheap) rather than caching it at
      // open time — a Settings change should take effect on the next edit,
      // matching the provider's own "always re-read" convention.
      const quality = normalizeTessellationQuality(
        stateStore.get(CAD_DEFAULT_KEYS.tessellationQuality, DEFAULT_TESSELLATION_QUALITY)
      );
      const { groups, edges, points, tree } = await cadCompute.loadBRepCachedInWorker(
        this.sessionId,
        this.runtimePath,
        bytes,
        format,
        ops,
        tessellationParamsFor(quality)
      );
      if (epoch !== this.epoch) return; // document changed while tessellating
      this.post({
        type: "geometry",
        meshes: groups.flatMap((g) =>
          g.faces.map((f) => ({
            positions: encodeBuffer(f.buffers.positions),
            indices: encodeBuffer(f.buffers.indices),
            groupId: g.id,
            faceId: f.faceId,
          }))
        ),
        edges: edges.map((e) => ({
          positions: encodeBuffer(e.positions),
          edgeId: e.edgeId,
          // cad 1.2.6 classifies patch-seam edges so the viewer can hide them.
          smooth: e.smooth,
        })),
        points: points.map((p) => ({
          position: encodeBuffer(new Float32Array(p.position)),
          pointId: p.pointId,
        })),
      });
      // The file's own declared length unit, so the view-controls Units
      // dropdown opens on it. Both detectors are plain text scans — they stay
      // in the main process rather than costing a worker round trip.
      const text = format === "step" || format === "iges" ? Buffer.from(bytes).toString("latin1") : undefined;
      const sourceUnit =
        format === "step"
          ? detectStepLengthUnit(text!)
          : format === "iges"
            ? detectIgesLengthUnit(text!)
            : undefined;
      this.post({ type: "tree", root: tree, sourceUnit });
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
    }
  }

  /**
   * meshio++-only formats (VTK/VTU/MED/CGNS/Exodus/XDMF/MDPA) — converts the
   * raw file to an STL boundary surface and posts it as `loadMeshBytes`, so
   * the webview treats it exactly like a native `.stl` open (port of
   * provider.handleMeshio).
   *
   * Owns the parts round trip for this route: when the sidecar is still empty,
   * regions correlated onto the boundary auto-create one Part each, persisted
   * immediately so a reopen needn't recompute the correlation. The
   * per-triangle `regionAssignment` rides along on EVERY open where the
   * correlation succeeded — the webview needs it each time to reproduce the
   * same region-aware facet split those ids were computed against. Returns the
   * parts actually in effect so the caller can keep `currentParts` in sync.
   */
  private async handleMeshio(modelPath: string, format: CadFormat): Promise<Part[]> {
    const epoch = this.epoch;
    try {
      this.post({ type: "status", text: `Loading ${format.toUpperCase()}…` });
      const bytes = await fs.readFile(modelPath);
      const [boundary, metadata, existingParts] = await Promise.all([
        cadCompute.convertToStlBoundaryWithRegions(bytes, format),
        cadCompute.readMeshioMetadata(bytes, format),
        readParts(modelPath),
      ]);
      if (epoch !== this.epoch) return [];
      let parts = existingParts;
      if (boundary.regions && existingParts.length === 0) {
        const built = await cadCompute.buildPartsFromMeshioRegions(boundary.stlBytes, boundary.regions);
        if (epoch !== this.epoch) return [];
        if (built.length > 0) {
          parts = built;
          try {
            await writeParts(modelPath, parts);
          } catch {
            // Best-effort persist — the webview still gets these Parts for this
            // session, and a later edit's own autosave retries.
          }
        }
      }
      const hasMetadata =
        metadata.regions.length > 0 ||
        metadata.pointDataNames.length > 0 ||
        metadata.cellDataNames.length > 0 ||
        metadata.fieldDataNames.length > 0;
      this.post({
        type: "loadMeshBytes",
        sourceFormat: format,
        dataBase64: Buffer.from(boundary.stlBytes).toString("base64"),
        meshioMetadata: hasMetadata ? metadata : undefined,
        regionAssignment: boundary.regions
          ? {
              regionNames: boundary.regions.regionNames,
              triangleRegionIndex: encodeBuffer(boundary.regions.triangleRegion),
            }
          : undefined,
      });
      this.post({ type: "parts", parts });
      return parts;
    } catch (err) {
      if (epoch !== this.epoch) return [];
      this.post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
      return [];
    }
  }

  /**
   * Loads the parts sidecar (if any), sends it, and returns it so the caller
   * can keep `currentParts` in sync — without that, a Save right after load
   * flushes a stale `[]` over the sidecar.
   */
  private async sendParts(): Promise<Part[]> {
    if (!this.doc) return [];
    try {
      const parts = await readParts(this.doc.path);
      this.post({ type: "parts", parts });
      return parts;
    } catch {
      this.post({ type: "parts", parts: [] });
      return [];
    }
  }

  private async sendMeshOptions(): Promise<void> {
    if (!this.doc) return;
    this.post({ type: "meshingOptions", options: await readMeshOptions(this.doc.path) });
  }

  /**
   * The cross-document viewer defaults (provider.sendViewerDefaults). The
   * extension reads them from `cadPreview.*` settings; KKSS has no vscode
   * configuration, so they come from `stateStore` under the CAD_DEFAULT_KEYS
   * below — written by Settings ▸ CAD Viewer (app/main/menu.ts) and clamped by
   * the submodule's own `normalizeViewerDefaults`. They are only ever *initial*
   * state: a per-document sidecar value or a runtime toggle still wins.
   */
  private sendViewerDefaults(): void {
    this.post({
      type: "viewerDefaults",
      ...normalizeViewerDefaults({
        background: stateStore.get(CAD_DEFAULT_KEYS.background),
        meshSizePreset: stateStore.get(CAD_DEFAULT_KEYS.meshSizePreset),
        showGridAndAxes: stateStore.get(CAD_DEFAULT_KEYS.showGridAndAxes),
        upAxis: stateStore.get(CAD_DEFAULT_KEYS.upAxis),
      }),
    });
  }

  /**
   * See provider.resolveMeshInput — B-rep re-exports to STEP so edits are
   * baked. `unit` defaults to "mm": interactive Generate always meshes at the
   * native unit (its overlay is display-only), only the FE Mesh panel's Export
   * passes a real one.
   */
  private async resolveMeshInput(
    stl: string | undefined,
    unit: DisplayUnit = "mm"
  ): Promise<MeshGenerationInput | undefined> {
    const doc = this.doc!;
    if (doc.route && doc.route.strategy === "occt") {
      const sourceBytes = await fs.readFile(doc.path);
      // labelStepUnit: false — Gmsh's STEP importer reinterprets a correctly
      // labelled header and would undo this scale entirely. The intermediate
      // file is meshing input only, so it stays labelled "mm" while its
      // geometry is genuinely scaled (see exportBRep's doc comment).
      const stepBytes = await cadCompute.exportBRep(
        this.runtimePath,
        sourceBytes,
        doc.route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        "step",
        this.currentEdits,
        unit,
        false
      );
      return { kind: "brep", stepBytes };
    }
    if (!stl) return undefined;
    const stlBytes = Buffer.from(stl, "base64");
    const factor = unitScaleFactor(unit);
    return { kind: "stl", stlBytes: factor === 1 ? stlBytes : scaleStlBytes(stlBytes, factor) };
  }

  /**
   * See provider.resolveMeshPartsAndOptions. The unit rescale runs LAST, after
   * the STL single-part size override, so that override's raw-mm value is
   * carried into the target unit's space too.
   */
  private async resolveMeshPartsAndOptions(
    input: MeshGenerationInput,
    options: MeshOptions,
    unit: DisplayUnit = "mm"
  ): Promise<{ parts: Part[]; options: MeshOptions }> {
    const rawParts = await readParts(this.doc!.path);
    const { parts, options: sized } =
      input.kind === "brep"
        ? { parts: rawParts, options }
        : { parts: [], options: applyStlPartSizeOverride(options, rawParts) };
    const factor = unitScaleFactor(unit);
    return { parts: scalePartsMeshSizeForUnit(parts, factor), options: scaleMeshOptionsForUnit(sized, factor) };
  }

  /** Port of provider.handleExport (quick-pick + save dialog + write). */
  private async handleExport(modelPath: string, route: FileRoute): Promise<void> {
    const targets = exportTargetsFor(route);
    if (targets.length === 0) return;

    const picked = await showQuickPick(
      targets.map((format) => ({
        label: EXPORT_LABEL[format],
        description: `.${EXPORT_EXTENSION[format]}`,
        format,
      })),
      { placeHolder: "Export model as…" }
    );
    if (!picked) return;

    const targetFormat = picked.format;
    // Every current export target can honestly represent a converted unit
    // (STEP/IGES got verified header handling in cad 1.2.0), but the gate stays
    // as the single source of truth in case a future format can't.
    const unit = UNIT_CONVERTIBLE_FORMATS.has(targetFormat) ? await this.pickExportUnit() : "mm";

    await this.promptSaveAndWrite(
      modelPath,
      EXPORT_EXTENSION[targetFormat],
      EXPORT_LABEL[targetFormat],
      async () => {
        if (BREP_FORMATS.has(targetFormat)) {
          const sourceBytes = await fs.readFile(modelPath);
          return cadCompute.exportBRep(
            this.runtimePath,
            sourceBytes,
            route.format as Extract<CadFormat, "step" | "iges" | "brep">,
            targetFormat as Extract<CadFormat, "step" | "iges" | "brep">,
            this.currentEdits,
            unit
          );
        }
        // Mesh targets are serialized in the webview (it holds the Three.js
        // model) and relayed back via exportResult/exportError.
        const requestId = `${Date.now()}-${Math.random()}`;
        const result = await new Promise<{ data: string; binary: boolean }>((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          this.post({ type: "exportMesh", requestId, format: targetFormat, unit });
        });
        return result.binary ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
      }
    );
  }

  /**
   * The export-unit step (provider.pickExportUnit) — a real geometric scale on
   * the exported file, distinct from the webview's display-unit selector.
   * Defaults to "mm" both as the first item and on Escape: declining this
   * optional step must never cancel the export, unlike declining the format.
   */
  private async pickExportUnit(): Promise<DisplayUnit> {
    const picked = await showQuickPick(
      DISPLAY_UNITS.map((unit) => ({
        label: unit === "mm" ? "Native (mm) — no conversion" : UNIT_LABELS[unit],
        unit,
      })),
      { placeHolder: "Export unit…" }
    );
    return picked?.unit ?? "mm";
  }

  /**
   * File ▸ Save Preprocess… (provider.handleSavePreprocess): bundles the CAD
   * source plus whichever sidecars exist into one `.zip`. Callers must flush
   * the debounced sidecar writes first, so the archive reflects what is on
   * screen rather than a stale on-disk state.
   */
  private async handleSavePreprocess(modelPath: string): Promise<void> {
    const sourceName = path.basename(modelPath);
    const baseName = sourceName.replace(/\.[^.]+$/, "");
    const savePath = await showSaveDialog({
      defaultPath: path.join(path.dirname(modelPath), `${baseName}.preprocess.zip`),
      filters: [{ name: "Preprocess Archive", extensions: ["zip"] }],
    });
    if (!savePath) return;

    try {
      // Inclusion is purely file-existence-driven: a sidecar that was never
      // created is omitted, never an error.
      const readOptional = async (suffix: string): Promise<string | undefined> => {
        try {
          return await fs.readFile(`${modelPath}${suffix}`, "utf8");
        } catch {
          return undefined;
        }
      };
      const [source, parts, annotations, edits, meshOptions] = await Promise.all([
        fs.readFile(modelPath),
        readOptional(".parts.json"),
        readOptional(".annotations.json"),
        readOptional(".edits.json"),
        readOptional(".mesh.json"),
      ]);
      const zipBytes = buildPreprocessZip({ sourceName, source, parts, annotations, edits, meshOptions });
      await fs.writeFile(savePath, zipBytes);
      this.post({ type: "status", text: `Saved preprocess archive to ${savePath}` });
    } catch (err) {
      this.post({ type: "error", message: `Save preprocess failed: ${(err as Error).message}` });
    }
  }

  /**
   * File ▸ Load Preprocess… (provider.loadPreprocessDialog): restores a `.zip`
   * next to a chosen destination and opens it. Works with no document open,
   * which is why it is a plain method rather than a message-loop branch only.
   *
   * The destination extension is checked against the archive's own source
   * format — the save dialog's filter is advisory on some platforms, and
   * restoring a STEP archive to `restored.stl` used to succeed silently.
   */
  private async loadPreprocessDialog(): Promise<void> {
    const zipPath = await showOpenDialog({
      openLabel: "Load Preprocess Archive",
      filters: [{ name: "Preprocess Archive", extensions: ["zip"] }],
    });
    if (!zipPath) return;

    try {
      const contents = readPreprocessZip(await fs.readFile(zipPath));
      const sourceName = contents.manifest.source;
      const ext = sourceName.slice(sourceName.lastIndexOf(".") + 1);
      const destPath = await showSaveDialog({
        defaultPath: path.join(path.dirname(zipPath), sourceName),
        filters: [{ name: "CAD / Mesh", extensions: [ext] }],
      });
      if (!destPath) return;

      const sourceRoute = routeFile(sourceName);
      const destRoute = routeFile(destPath);
      if (!destRoute || !sourceRoute || destRoute.format !== sourceRoute.format) {
        this.post({
          type: "error",
          message:
            `Cannot restore "${sourceName}" (${sourceRoute?.format ?? "unrecognized"}) to ` +
            `"${path.basename(destPath)}" (${destRoute?.format ?? "unrecognized"}) — the destination ` +
            `file extension doesn't match the archive's source format.`,
        });
        return;
      }

      await fs.writeFile(destPath, contents.source);
      allowRoot(path.dirname(destPath));
      if (contents.parts !== undefined) await writeParts(destPath, parsePartsJson(contents.parts));
      if (contents.annotations !== undefined) {
        await writeAnnotations(destPath, parseAnnotationsJson(contents.annotations));
      }
      if (contents.edits !== undefined) {
        const parsed = parseEditsJson(contents.edits);
        await writeEdits(destPath, parsed.ops, parsed.variables);
      }
      if (contents.meshOptions !== undefined) {
        const options = parseMeshJson(contents.meshOptions);
        await writeMeshOptions(destPath, options);
        await writeGeoScript(destPath, options);
      }
      this.hooks.onOpenRequest(destPath);
    } catch (err) {
      this.post({ type: "error", message: `Load preprocess failed: ${(err as Error).message}` });
    }
  }

  /**
   * Saves the current 3D view as a PNG (provider.handleScreenshot) — the same
   * `pending` round trip handleExport's mesh branch uses, minus the format
   * quick-pick.
   */
  private async handleScreenshot(modelPath: string): Promise<void> {
    await this.promptSaveAndWrite(modelPath, "png", "PNG Image", async () => {
      const requestId = `${Date.now()}-${Math.random()}`;
      const result = await new Promise<{ data: string; binary: boolean }>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        this.post({ type: "screenshotRequest", requestId });
      });
      return Buffer.from(result.data, "base64");
    });
  }

  /**
   * Port of provider.promptSaveAndWrite. Returns the written path on success,
   * or undefined when the user cancels the dialog or the write fails.
   */
  private async promptSaveAndWrite(
    modelPath: string,
    ext: string,
    filterLabel: string,
    getBytes: (savePath: string) => Promise<Uint8Array>
  ): Promise<string | undefined> {
    const baseName = path.basename(modelPath).replace(/\.[^.]+$/, "");
    const savePath = await showSaveDialog({
      defaultPath: path.join(path.dirname(modelPath), `${baseName}.${ext}`),
      filters: [{ name: filterLabel, extensions: [ext] }],
    });
    if (!savePath) return undefined;
    try {
      const bytes = await getBytes(savePath);
      await fs.writeFile(savePath, bytes);
      this.post({ type: "status", text: `Exported to ${savePath}` });
      return savePath;
    } catch (err) {
      this.post({ type: "error", message: `Export failed: ${(err as Error).message}` });
      return undefined;
    }
  }
}
