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
 *   cadPreview.openscadBinary      → the cadOpenscadBinary stateStore key
 *                                    (Settings ▸ CAD Viewer Defaults), since
 *                                    the shim's getConfiguration always
 *                                    resolves to the caller's default
 *
 * Deliberately NOT ported from cad 1.12.0:
 *   - SpaceMouse (the provider's spaceMouseConnect/Disconnect commands and the
 *     `spacemouse` relay). It needs `node-hid`, a second native N-API module,
 *     and node-pty is KKSS's only one — see CLAUDE.md. cad `require()`s it
 *     lazily and fails soft, so nothing else in the submodule is affected.
 *   - The Models activity-bar view (cad/src/modelsView.ts): a VS Code TreeView
 *     over the workspace folders, which KKSS has no analogue of and whose job
 *     the home screen and the Open dialog already do.
 *
 * Deliberately NOT ported from cad 2.5.0:
 *   - The `cad-preview.zoomToSelection` command (and the provider's
 *     `zoomToSelection()` → `{type:"zoomToSelection"}` relay). Like every other
 *     `cad-preview.*` command it has no KKSS analogue; the Select menu's own
 *     "Zoom to selection" button is purely webview-side and works unchanged.
 *
 * cad 3.0.0's chrome redesign added two host → webview messages, both ported
 * here: `kernelStatus` (readiness, fed by cadComputeClient's tracker and fanned
 * out to every tab — the provider's constructor subscription) and
 * `documentInfo` (the menubar chip). The chip is a FAITHFUL port of the
 * provider's predicate: KKSS never advances `bakedThrough` (no interactive
 * bake), so an edited STEP/IGES/BREP/STL/OBJ/PLY reads "N unsaved edits" for
 * good. That is accurate by cad's own definition — the source file does not yet
 * contain what is on screen — and is documented rather than special-cased.
 */
import { ipcMain, WebContentsView } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  routeFile,
  COMPARABLE_MESH_FORMATS,
  matchExtension,
  type CadFormat,
  type FileRoute,
  type MeshParseFormat,
} from "../../cad/src/fileRouter";
import { resolveEffectiveSource } from "../../cad/src/scadService";
import { SVG_VIEWS } from "../../cad/src/svgSilhouette";
import type { CompareSource } from "../../cad/src/modelDiffHost";
import { resolveExternalBuffers, type GltfExternalBuffers } from "../../cad/src/gltfParser";
import {
  encodeBuffer,
  type HostToWebview,
  type WebviewToHost,
  type Part,
  type SelectorSynthesizeResultEntry,
} from "../../cad/src/protocol";
import {
  exportTargetsFor,
  EXPORT_EXTENSION,
  EXPORT_LABEL,
  MESH_SAVE_IN_PLACE_FORMATS,
  UNIT_CONVERTIBLE_FORMATS,
} from "../../cad/src/exportTargets";
import { parsePartsJson, serializePartsJson } from "../../cad/src/partsSidecar";
import {
  parseEditsJson,
  serializeEditsJson,
  replayTail,
  type ParsedEdits,
} from "../../cad/src/editsSidecar";
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
import { validateEditOp, type EditOp } from "../../cad/src/editOps";
import { resolvePlaneRefs } from "../../cad/src/planeRefs";
import { emitPrimitiveOps } from "../../cad/src/primitiveEmit";
import { validateMeshioOpSpec, type MeshioOpSpec } from "../../cad/src/meshioOps";
import { PAPER_SIZES } from "../../cad/src/drawingSheet";
import type { ParamVariable } from "../../cad/src/editVariables";
import type {
  Annotation,
  ViewState,
  ConstructionPlane,
  MeshPresetSummary,
} from "../../cad/src/protocol";
import { parsePlanesJson, serializePlanesJson } from "../../cad/src/planesSidecar";
import {
  parseScriptLibraryJson,
  serializeScriptLibraryJson,
  mergeScriptOverrides,
  scriptParameters,
  type ScriptLibrary,
} from "../../cad/src/scriptLibrary";
import { bundledMacrosPath, mergeScriptLibraries } from "../../cad/src/starterMacros";
import { ThumbCache, fetchThumbnail } from "../../cad/src/standardPartsThumbs";
import {
  bundledMeshPresetsPath,
  effectivePresetOptions,
  mergePresetLibraries,
  parseMeshPresetsJson,
  serializeMeshPresetsJson,
  type MeshPresetLibrary,
} from "../../cad/src/meshPresets";
import { compileParametricScript } from "../../cad/src/parametricScript";
import { evaluateVariables } from "../../cad/src/editVariables";
import type { MeshGenerationInput } from "../../cad/src/gmshService";
import {
  isMeshioFieldFailure,
  describeMeshioFieldFailure,
  isHealableSizeError,
  stlBytesForHeal,
  AUTO_DECIMATE_TARGET_TRIANGLES,
} from "../../cad/src/meshioService";
import { cadCompute, kernelState, onKernelState, runOwnedJob, jobStatus, cancelOwnedJob } from "./cadComputeClient";
import { toKkssUrl, allowRoot } from "./protocol";
import { projectRoot } from "./services/projectRoot";
import { showOpenDialog, showSaveDialog } from "./services/dialogs";
import { showQuickPick, showInputBox } from "./services/quickPick";
import { stateStore } from "./services/stateStore";
import { entryForVscode } from "./services/settings/registry";
import { writeFileAtomic } from "./services/atomicWrite";
import { CAD_SIDECAR, MACRO_LIBRARY_NAME, MESH_PRESET_LIBRARY_NAME } from "./services/sidecarSuffixes";

/**
 * stateStore keys backing the viewer defaults the extension gets from its
 * `cadPreview.*` settings — see `sendViewerDefaults`. Derived from the settings
 * registry (services/settings/registry.ts), which is what the Settings page
 * writes, so the two cannot name different keys.
 *
 * `openscadBinary` (cad 1.12.0) is the executable used to convert a `.scad`
 * source to `.csg` on open. Unset means "resolve `openscad` on PATH", the
 * submodule's own default; the OPENSCAD_BINARY environment variable stays the
 * headless escape hatch and already reaches the MCP child through its
 * inherited env. `tessellationQuality` is read fresh on every B-rep load.
 */
const cadKey = (key: string): string => entryForVscode("cadPreview", key)!.storeKey!;
export const CAD_DEFAULT_KEYS = {
  background: cadKey("background"),
  meshSizePreset: cadKey("defaultMeshSizePreset"),
  showGridAndAxes: cadKey("showGridAndAxesOnOpen"),
  upAxis: cadKey("upAxis"),
  tessellationQuality: cadKey("tessellationQuality"),
  openscadBinary: cadKey("openscadBinary"),
} as const;

/** Debounce window for autosaving the parts/edits/mesh-options sidecars (provider.ts). */
const PARTS_SAVE_DEBOUNCE_MS = 500;

const BREP_FORMATS: ReadonlySet<CadFormat> = new Set(["step", "iges", "brep"]);

/**
 * What the OCCT pipeline accepts as a *source*. `.csg` joined it in cad 1.12.0
 * (OpenSCAD's evaluated form, built kernel-side into an opaque base shape, like
 * a STEP import rather than an op history), and `.scad` reaches it by
 * converting to `.csg` first — see `readOcctSource`, after which nothing
 * downstream ever sees "scad".
 *
 * Export *targets* stay `BREP_FORMATS`: both OpenSCAD formats are import-only.
 */
type OcctSourceFormat = Extract<CadFormat, "step" | "iges" | "brep" | "csg">;
const CAD_OPEN_FILTER = {
  name: "CAD / Mesh",
  // Mirrors provider.openFileDialog's own filter — the second and third rows
  // are the meshio++ route (cad 1.2.x, extended in 1.5.1). Note the router
  // still prefers post mode for those (app/main/router.ts); this dialog is the
  // CAD-mode importer. Electron matches the final dot-segment only, so GiD's
  // compound `post.msh` is covered by the plain `msh` entry.
  extensions: [
    "stl", "obj", "ply", "gltf", "glb", "step", "stp", "iges", "igs", "brep", "csg", "scad",
    "vtk", "vtu", "med", "cgns", "exo", "e", "xdmf", "mdpa", "foam",
    "msh", "msh2", "inp", "unv", "su2", "mesh",
  ],
};

interface PendingExport {
  resolve: (result: { data: string; binary: boolean }) => void;
  reject: (err: Error) => void;
}

/**
 * cad 1.5.0's linked cameras relay. In the extension one provider owns every
 * panel, so both the flag and the session registry are instance state; here a
 * tab is its own CadHost, so "every other open CAD view" is this module-level
 * registry instead. Entries are added on construction and removed on dispose.
 */
const liveHosts = new Set<CadHost>();

// cad 3.0.0's status bar. The provider subscribes once in its constructor and
// posts to every session; the same shape here, since one worker serves every
// tab. Module-level and never unsubscribed: it is process-lifetime, like the
// worker itself, and a host that is gone has left `liveHosts`.
onKernelState((state) => {
  for (const host of liveHosts) host.postKernelStatus(state);
});

/**
 * cad 2.5.0's Standard-Parts thumbnails. The provider keeps one `ThumbCache`
 * for every open document (the catalog is document-independent); each tab is
 * its own CadHost here, so it is module-level like `liveHosts`. Session-scoped
 * by construction, and only successful fetches are stored.
 */
const thumbsCache = new ThumbCache();
const THUMB_FETCH_CONCURRENCY = 4;
let camerasLinked = false;

// ---- The three cad *Store.ts files, re-implemented on node:fs --------------

const readParts = async (modelPath: string): Promise<Part[]> => {
  try {
    return parsePartsJson(await fs.readFile(`${modelPath}${CAD_SIDECAR.parts}`, "utf8"));
  } catch {
    return [];
  }
};
const writeParts = (modelPath: string, parts: Part[]): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.parts}`,
    serializePartsJson(path.basename(modelPath), parts)
  );

const readEdits = async (modelPath: string): Promise<ParsedEdits> => {
  try {
    return parseEditsJson(await fs.readFile(`${modelPath}${CAD_SIDECAR.edits}`, "utf8"));
  } catch {
    return { ops: [], variables: [], bakedThrough: 0 };
  }
};
const writeEdits = (
  modelPath: string,
  ops: EditOp[],
  variables: ParamVariable[],
  bakedThrough = 0
): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.edits}`,
    serializeEditsJson(path.basename(modelPath), ops, variables, bakedThrough)
  );

const readAnnotations = async (modelPath: string): Promise<Annotation[]> => {
  try {
    return parseAnnotationsJson(await fs.readFile(`${modelPath}${CAD_SIDECAR.annotations}`, "utf8"));
  } catch {
    return [];
  }
};
const writeAnnotations = (modelPath: string, annotations: Annotation[]): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.annotations}`,
    serializeAnnotationsJson(path.basename(modelPath), annotations)
  );

const readViewState = async (modelPath: string): Promise<ViewState | null> => {
  try {
    return parseViewStateJson(await fs.readFile(`${modelPath}${CAD_SIDECAR.view}`, "utf8"));
  } catch {
    return null;
  }
};
const writeViewState = (modelPath: string, view: ViewState): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.view}`,
    serializeViewStateJson(path.basename(modelPath), view)
  );

// cad 1.7.0's named construction planes. Stores resolved point+normal vectors,
// never a face reference, so it is deliberately outside entity rebinding and
// is never renumbered by an op replay.
const readPlanes = async (modelPath: string): Promise<ConstructionPlane[]> => {
  try {
    return parsePlanesJson(await fs.readFile(`${modelPath}${CAD_SIDECAR.planes}`, "utf8"));
  } catch {
    return [];
  }
};
const writePlanes = (modelPath: string, planes: ConstructionPlane[]): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.planes}`,
    serializePlanesJson(path.basename(modelPath), planes)
  );

/**
 * cad 1.7.0's macro library — per folder, not per model, which is why two tabs
 * on models in one directory write the same path. writeFileAtomic serializes
 * them; a bare writeFile would have let them interleave.
 */
const macroLibraryPath = (modelPath: string): string =>
  path.join(path.dirname(modelPath), MACRO_LIBRARY_NAME);

const readMacros = async (modelPath: string): Promise<ScriptLibrary> => {
  try {
    return parseScriptLibraryJson(await fs.readFile(macroLibraryPath(modelPath), "utf8"));
  } catch {
    return {};
  }
};
const writeMacros = (modelPath: string, library: ScriptLibrary): Promise<void> =>
  writeFileAtomic(macroLibraryPath(modelPath), serializeScriptLibraryJson(library));

/** cad 2.3.0's bundled starter macros, shipped read-only beside the runtime
 *  (dist/macros/starter-library.json) and shadow-merged under the folder's
 *  own library — a missing/unreadable file degrades to no starters. */
const readBundledMacros = async (runtimePath: string): Promise<ScriptLibrary> => {
  try {
    return parseScriptLibraryJson(await fs.readFile(bundledMacrosPath(runtimePath), "utf8"));
  } catch {
    return {};
  }
};

/**
 * cad 2.7.0's meshing-preset library — per folder like the macro library, and
 * the very file the MCP preset tools take as an explicit `libraryPath`, so a
 * preset saved here is appliable by the assistant and vice versa. Missing or
 * unreadable reads as empty; writes go through writeFileAtomic for the same
 * two-tabs-one-folder reason as the macros.
 */
const meshPresetLibraryPath = (modelPath: string): string =>
  path.join(path.dirname(modelPath), MESH_PRESET_LIBRARY_NAME);

const readTextOrEmpty = async (file: string): Promise<string> => {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
};
const readMeshPresets = async (modelPath: string): Promise<MeshPresetLibrary> =>
  parseMeshPresetsJson(await readTextOrEmpty(meshPresetLibraryPath(modelPath)));
const writeMeshPresets = (modelPath: string, library: MeshPresetLibrary): Promise<void> =>
  writeFileAtomic(meshPresetLibraryPath(modelPath), serializeMeshPresetsJson(library));
/** The bundled starters (dist/mesh-presets/starter-presets.json), read-only. */
const readBundledMeshPresets = async (runtimePath: string): Promise<MeshPresetLibrary> =>
  parseMeshPresetsJson(await readTextOrEmpty(bundledMeshPresetsPath(runtimePath)));

const readMeshOptions = async (modelPath: string): Promise<MeshOptions> => {
  try {
    return parseMeshJson(await fs.readFile(`${modelPath}${CAD_SIDECAR.meshOptions}`, "utf8"));
  } catch {
    return DEFAULT_MESH_OPTIONS;
  }
};
const writeMeshOptions = (modelPath: string, options: MeshOptions): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.meshOptions}`,
    serializeMeshJson(path.basename(modelPath), options)
  );
const writeGeoScript = (modelPath: string, options: MeshOptions): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.geoScript}`,
    generateGeoScript(path.basename(modelPath), options)
  );

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
  private planesSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private currentPlanes: ConstructionPlane[] = [];
  private currentEdits: EditOp[] = [];
  private currentVariables: ParamVariable[] = [];
  /** ops[0..bakedThrough) are already baked into the CAD source file itself
   *  (by `cad__save_model` or another process) — only the tail is ever
   *  replayed against the loaded body. Read from the sidecar; never advanced
   *  here, since KKSS has no interactive bake action of its own yet. */
  private currentBakedThrough = 0;
  private currentParts: Part[] = [];
  private currentAnnotations: Annotation[] = [];
  private currentViewState: ViewState | undefined;
  private currentMeshOptions: MeshOptions | undefined;
  /** The latest Standard-Parts search page, so a thumbnails request can be
   *  validated against it (stale pages ignored) and mapped id → image URL. */
  private lastPartsSearch: { requestId: string; pngById: Map<string, string> } | null = null;
  /** Guards stale async completions after the document changes. */
  private epoch = 0;
  /** Last `documentInfo` actually posted (serialized), so syncing is idempotent. */
  private lastDocumentInfo = "";

  constructor(
    private readonly view: WebContentsView,
    /** out/cad-runtime — the dist/-shaped WASM home the cad services expect. */
    private readonly runtimePath: string,
    private readonly hooks: CadHostHooks,
    /** Stable per-tab id — keys this session's slot in the worker's B-rep cache. */
    private readonly sessionId: string
  ) {
    liveHosts.add(this);
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

  /** Called by the module-level readiness subscription above. */
  postKernelStatus(state: ReturnType<typeof kernelState>): void {
    this.post({ type: "kernelStatus", state });
  }

  // ---- cad 3.0.0 document chip (provider.ts isDocumentDirty … postEdits) ----
  // ONE predicate feeds both "dirty" and "N unsaved edits" so they cannot
  // disagree. Only sources that can bake count (B-rep, and the three mesh
  // formats with an in-place writer); an unbaked tail on anything else is
  // sidecar-only and autosaved.
  private isDocumentDirty(): boolean {
    const route = this.doc?.route;
    return (
      !!route &&
      this.currentEdits.length > this.currentBakedThrough &&
      ((route.strategy === "occt" && BREP_FORMATS.has(route.format)) ||
        (route.strategy === "three" && MESH_SAVE_IN_PLACE_FORMATS.has(route.format)))
    );
  }

  /** Deduplicated, so it is safe to call wherever the op list can change. */
  private syncDocumentInfo(): void {
    if (!this.doc) return;
    const dirty = this.isDocumentDirty();
    const info = {
      type: "documentInfo" as const,
      name: path.basename(this.doc.path),
      path: this.doc.path,
      format: this.doc.route?.format ?? null,
      dirty,
      unsavedEdits: dirty ? this.currentEdits.length - this.currentBakedThrough : 0,
    };
    const serialized = JSON.stringify(info);
    if (serialized === this.lastDocumentInfo) return;
    this.lastDocumentInfo = serialized;
    this.post(info);
  }

  /** Every place the host tells the webview about the op list also settles the
   *  watermark, so post + chip resync are one call. */
  private postEdits(): void {
    this.post({
      type: "edits",
      ops: this.currentEdits,
      variables: this.currentVariables,
      bakedThrough: this.currentBakedThrough,
    });
    this.syncDocumentInfo();
  }

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
    if (picked) this.hooks.onOpenRequest(picked[0]);
  }

  /** File ▸ Save — immediately flushes all sidecars (provider flushSidecars). */
  async flushSidecars(): Promise<void> {
    if (!this.doc) return;
    if (this.partsSaveTimer) clearTimeout(this.partsSaveTimer);
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
    if (this.annotationsSaveTimer) clearTimeout(this.annotationsSaveTimer);
    if (this.viewSaveTimer) clearTimeout(this.viewSaveTimer);
    if (this.planesSaveTimer) clearTimeout(this.planesSaveTimer);
    try {
      await Promise.all([
        writeParts(this.doc.path, this.currentParts),
        writePlanes(this.doc.path, this.currentPlanes),
        writeEdits(this.doc.path, this.currentEdits, this.currentVariables, this.currentBakedThrough),
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

  /** File ▸ New Blank Model… (cad-preview.new) — needs no open document either. */
  newBlankModel(): void {
    void this.newBlankModelDialog();
  }

  /** Tab closed — tear down this session's state (timers, pending work, the
   *  worker's cached B-rep entry). The WebContentsView itself is disposed by
   *  the caller (windows.ts's closeTab). */
  dispose(): void {
    liveHosts.delete(this);
    this.disposeSession();
  }

  private disposeSession(): void {
    this.epoch++;
    if (this.partsSaveTimer) clearTimeout(this.partsSaveTimer);
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
    if (this.annotationsSaveTimer) clearTimeout(this.annotationsSaveTimer);
    if (this.viewSaveTimer) clearTimeout(this.viewSaveTimer);
    if (this.planesSaveTimer) clearTimeout(this.planesSaveTimer);
    this.partsSaveTimer = this.editsSaveTimer = this.meshSaveTimer = undefined;
    this.annotationsSaveTimer = this.viewSaveTimer = this.planesSaveTimer = undefined;
    for (const p of this.pending.values()) p.reject(new Error("Document closed"));
    this.pending.clear();
    this.currentEdits = [];
    this.currentVariables = [];
    this.currentBakedThrough = 0;
    this.currentParts = [];
    this.currentAnnotations = [];
    this.currentPlanes = [];
    this.currentViewState = undefined;
    this.currentMeshOptions = undefined;
    this.lastPartsSearch = null;
    // A reopened page must receive the chip again even for an identical value.
    this.lastDocumentInfo = "";
    // The provider frees its per-document BRepCacheEntry in onDidDispose; here
    // the entry lives in the worker, so ask it to. Fire-and-forget: a failure
    // only costs the next load a fresh parse. TWO keys since cad 1.7.0 — the
    // live op preview replays under its own `::oppreview` slot.
    void cadCompute.releaseBRepCache(this.sessionId).catch(() => {});
    void cadCompute.releaseBRepCache(`${this.sessionId}::oppreview`).catch(() => {});
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
        this.doc.route.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg" | "scad">,
        // cad 2.5.0: a profile op may be authored on a named plane and carry
        // no center/normal/up of its own — resolve against the current planes
        // before every replay, or the kernel skips it (provider.loadModel).
        resolvePlaneRefs(replayTail(this.currentEdits, this.currentBakedThrough), this.currentPlanes).ops
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
    if (this.currentParts.length === 0 && this.currentAnnotations.length === 0) return;
    if (JSON.stringify(previousOps) === JSON.stringify(newOps)) return;
    // Tier 0: both lists replay against the current (possibly baked) bytes,
    // so both are tailed identically before the diff — otherwise a change
    // confined to the already-baked prefix would trigger a pointless (and
    // wrong, since the kernel never sees baked ops) replay.
    const previousTail = replayTail(previousOps, this.currentBakedThrough);
    const newTail = replayTail(newOps, this.currentBakedThrough);
    if (JSON.stringify(previousTail) === JSON.stringify(newTail)) return;
    const epoch = this.epoch;
    try {
      const scadWarnings: string[] = [];
      const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
      for (const w of scadWarnings) this.post({ type: "status", text: w });
      const bytes = src.bytes;
      const format = src.format as OcctSourceFormat;
      // Stored selectors resolve FIRST (authoritative — a query that hits is
      // exact by construction) and the heuristic rebind runs on the result, so
      // a query-covered part is never also geometrically remapped underneath
      // its own resolution (provider.rebindPartsOnChange, cad 1.9.0).
      const selected = await cadCompute.resolvePartSelectors(
        this.runtimePath,
        bytes,
        format,
        newTail,
        this.currentParts
      );
      if (epoch !== this.epoch) return;
      // The provider gates on reference identity; a structured clone across the
      // worker RPC is always a fresh array, so compare by value instead (the
      // same reason the rebind below gates on `stats`).
      const selectorsChangedIds =
        JSON.stringify(selected.parts) !== JSON.stringify(this.currentParts);
      if (selectorsChangedIds) this.currentParts = selected.parts;
      for (const warning of selected.warnings) this.post({ type: "status", text: warning });
      const result = await cadCompute.rebindPartsAcrossOps(
        this.runtimePath,
        bytes,
        format,
        previousTail,
        newTail,
        this.currentParts,
        this.currentAnnotations
      );
      if (epoch !== this.epoch) return; // document changed while replaying
      // The provider detects "nothing to do" by reference identity on the
      // returned array; structured clone across the worker RPC always yields a
      // fresh one, so gate on the stats instead — which also skips the
      // provider's own harmless-but-pointless write when every id mapped to
      // itself. Parts and annotations are independent: either can change
      // without the other (rebindPartsAcrossOps's own doc comment — same
      // idMap, zero extra OCCT cost either way).
      const partsChanged = result.stats.rebound > 0 || result.stats.dropped > 0;
      const annotationsChanged =
        result.annotationStats.rebound > 0 || result.annotationStats.dropped > 0;
      if (partsChanged) this.currentParts = result.parts;
      if (annotationsChanged) this.currentAnnotations = result.annotations;
      if (partsChanged || selectorsChangedIds) {
        await writeParts(doc.path, this.currentParts);
        this.post({ type: "parts", parts: this.currentParts });
      }
      if (annotationsChanged) {
        await writeAnnotations(doc.path, this.currentAnnotations);
        this.post({ type: "annotations", annotations: this.currentAnnotations });
      }
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.post({ type: "error", message: `Could not rebind entity ids: ${(err as Error).message}` });
    }
  }

  // Port of provider.ts onDidReceiveMessage, branch for branch.
  private async onMessage(msg: WebviewToHost): Promise<void> {
    if (msg.type === "ready") {
      // First, before any early return: the status bar shows readiness even for
      // a blank tab (provider.ts posts it ahead of the `!route` check too).
      this.post({ type: "kernelStatus", state: kernelState() });
      if (!this.doc) {
        this.post({ type: "status", text: "No file open — use Open… in the toolbar" });
        return;
      }
      if (!this.doc.route) {
        this.post({ type: "error", message: `Unsupported file type: ${this.doc.path}` });
        return;
      }
      // Load edits before the model so a B-rep source is tessellated already-edited.
      // Planes are loaded alongside them so any `planeId` resolves before the
      // first tessellation (provider.ready): since cad 2.5.0 a plane-authored
      // profile op may carry no cached vectors, and the kernel skips one that
      // was never resolved — it would silently vanish on reopen.
      const [parsed, planesInitial] = await Promise.all([
        readEdits(this.doc.path),
        readPlanes(this.doc.path),
      ]);
      this.currentEdits = resolvePlaneRefs(parsed.ops, planesInitial).ops;
      this.currentVariables = parsed.variables;
      this.currentBakedThrough = parsed.bakedThrough;
      this.currentPlanes = planesInitial;
      this.loadModel();
      this.postEdits();
      // The meshio route's own handleMeshio (in loadModel) owns the parts
      // round trip for that route — calling both would double-post "parts".
      if (this.doc.route.strategy !== "meshio") {
        void this.sendParts().then(async (parts) => {
          this.currentParts = parts;
          // Heal a stale selector cache on open: a part whose query still hits
          // keeps its stored ids, anything else freezes with a status line —
          // the same terms as the edit-driven path in rebindPartsOnChange
          // (provider.ts, cad 1.9.0). Skipped entirely for a document carrying
          // no selector at all, which is every pre-1.9.0 sidecar.
          await this.healPartSelectors();
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
      this.post({ type: "planes", planes: this.currentPlanes });
      void this.sendMacros();
      void this.sendMeshPresets();
      // A view opened while linking is on must learn about it (provider.ready).
      if (camerasLinked) this.post({ type: "camerasLinked", enabled: true });
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
      // On EVERY edit, not only when dirty: undoing back to the save point
      // empties the tail, which must clear the chip's dot (provider L1656).
      this.syncDocumentInfo();
      if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
      this.editsSaveTimer = setTimeout(() => {
        void writeEdits(
          doc.path,
          this.currentEdits,
          this.currentVariables,
          this.currentBakedThrough
        ).then(undefined, (err) =>
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
        await runOwnedJob({ ownerId: doc.path, requestId: msg.requestId }, async () => {
        const input = await this.resolveMeshInput(msg.stl);
        if (!input) throw new Error("No mesh geometry available: missing STL data.");
        const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options);
        const startedAt = Date.now();
        const result = await cadCompute.generateMesh(this.runtimePath, input, options, parts);
        this.post({
          type: "meshingResult",
          requestId: msg.requestId,
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
        });
      } catch (err) {
        this.post({ type: "meshingError", requestId: msg.requestId, message: (err as Error).message });
      } finally {
        this.post({ type: "meshingJobSettled", requestId: msg.requestId });
      }
      return;
    }

    if (msg.type === "meshingCancel") {
      const job = cancelOwnedJob(doc.path, msg.requestId);
      if (job) this.post({ type: "status", text: job.state === "cancelled" ? "Meshing cancelled." : "Cancelling meshing job…" });
      return;
    }

    if (msg.type === "meshingExport") {
      try {
        await runOwnedJob({ ownerId: doc.path, requestId: msg.requestId }, async () => {
        const assertJobActive = () => {
          const state = jobStatus(doc.path, msg.requestId)?.state;
          if (state === "cancelling" || state === "cancelled") throw new Error(`CAD job ${msg.requestId} was cancelled.`);
        };
        const unit = msg.unit ?? "mm";
        const input = await this.resolveMeshInput(msg.stl, unit);
        if (!input) throw new Error("No mesh geometry available: missing STL data.");
        const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options, unit);
        let savedPath: string | undefined;
        if (msg.target === "msh") {
          const result = await cadCompute.generateMesh(this.runtimePath, input, options, parts);
          savedPath = await this.promptSaveAndWrite(doc.path, "msh", "GMSH Mesh", async () => {
            assertJobActive();
            return Buffer.from(result.mshText, "utf8");
          }, assertJobActive);
        } else if (msg.target === "geoUnrolled") {
          const geo = await cadCompute.exportGeoUnrolled(this.runtimePath, input, options, parts);
          savedPath = await this.promptSaveAndWrite(doc.path, "geo_unrolled", "GMSH Unrolled Geometry", async (savePath) => {
            assertJobActive();
            if (!geo.xao) return Buffer.from(geo.text, "utf8");
            // B-rep geometry can't be textually unrolled — write the XAO
            // companion beside the chosen path and point the Merge stub at it
            // (same fix-up as provider.ts).
            const xaoName = `${path.basename(savePath)}.xao`;
            await fs.writeFile(path.join(path.dirname(savePath), xaoName), geo.xao);
            const fixedText = geo.text.replace(/Merge "[^"]*\.xao";/, `Merge "${xaoName}";`);
            return Buffer.from(fixedText, "utf8");
          }, assertJobActive);
        } else if (msg.target === "mdpaElements" || msg.target === "mdpaGeometries") {
          const format = meshExportFormat(msg.target)!;
          const text = await cadCompute.exportMdpa(
            this.runtimePath,
            input,
            options,
            parts,
            msg.target === "mdpaElements" ? "elements" : "geometries"
          );
          savedPath = await this.promptSaveAndWrite(doc.path, format.extension, format.filterLabel, async () => {
            assertJobActive();
            return Buffer.from(text, "utf8");
          }, assertJobActive);
        } else if (msg.target === "med" || msg.target === "cgns" || msg.target === "xdmf") {
          // meshio++ bridge — Gmsh's own writers can't produce these; re-encode
          // generateMesh's MSH 4.1 text via exportViaMeshio.
          const format = meshExportFormat(msg.target)!;
          const meshed = await cadCompute.generateMesh(this.runtimePath, input, options, parts);
          const { bytes, companion } = await cadCompute.exportViaMeshio(meshed.mshText, msg.target);
          savedPath = await this.promptSaveAndWrite(doc.path, format.extension, format.filterLabel, async (savePath) => {
            assertJobActive();
            if (!companion) return Buffer.from(bytes);
            // xdmf's HDF5 companion — same "write beside the chosen save path
            // and rewrite the embedded reference" pattern as geoUnrolled's .xao.
            const h5Name = `${path.basename(savePath).replace(/\.[^.]+$/, "")}.h5`;
            await fs.writeFile(path.join(path.dirname(savePath), h5Name), companion.bytes);
            const fixedText = Buffer.from(bytes).toString("utf8").split(companion.name).join(h5Name);
            return Buffer.from(fixedText, "utf8");
          }, assertJobActive);
        } else {
          const format = meshExportFormat(msg.target);
          if (!format) throw new Error(`Unknown mesh export format: ${msg.target}`);
          const text = await cadCompute.exportMeshFormat(this.runtimePath, input, options, parts, msg.target);
          savedPath = await this.promptSaveAndWrite(doc.path, format.extension, format.filterLabel, async () => {
            assertJobActive();
            return Buffer.from(text, "utf8");
          }, assertJobActive);
        }
        // Pre → post sync: a written mesh may be openable in post mode. The
        // router (in index.ts) decides whether this format actually is.
        if (savedPath) this.hooks.onMeshExported(savedPath);
        });
      } catch (err) {
        this.post({ type: "error", message: `Export failed: ${(err as Error).message}` });
      } finally {
        this.post({ type: "meshingJobSettled", requestId: msg.requestId });
      }
      return;
    }

    if (msg.type === "openFile") {
      void this.openFileDialog();
      return;
    }

    if (msg.type === "newBlank") {
      // Like openFile, this ignores the current route — it CREATES a document
      // rather than acting on this one.
      void this.newBlankModel();
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
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const bytes = src.bytes;
        const properties = await cadCompute.computeMassProperties(
          this.runtimePath,
          bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough),
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
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const bytes = src.bytes;
        const result = await cadCompute.measureExact(
          this.runtimePath,
          bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough),
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
        // cad 1.7.0 replaced the null return with a typed failure, so the
        // three reasons the old message had to guess between are now named.
        if (!result) {
          throw new Error(`Field "${msg.field}" not found, not a plain scalar, or the boundary isn't pure triangles.`);
        }
        if (isMeshioFieldFailure(result)) {
          throw new Error(describeMeshioFieldFailure(result.reason, msg.field));
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

    // ---- cad 1.7.0 / 1.8.0 ------------------------------------------------

    if (msg.type === "planesChanged") {
      // Debounced autosave with its own timer — mirrors partsChanged.
      this.currentPlanes = msg.planes;
      if (this.planesSaveTimer) clearTimeout(this.planesSaveTimer);
      this.planesSaveTimer = setTimeout(() => {
        void writePlanes(doc.path, this.currentPlanes).catch((err: Error) =>
          this.post({ type: "error", message: `Could not save construction planes: ${err.message}` })
        );
      }, PARTS_SAVE_DEBOUNCE_MS);
      return;
    }

    if (msg.type === "setCamerasLinked") {
      // Provider-level in cad (one provider, many panels); here each tab is
      // its own CadHost, so the flag and the relay live in a module-level
      // registry of live hosts — see `liveHosts` above.
      camerasLinked = msg.enabled;
      for (const host of liveHosts) host.post({ type: "camerasLinked", enabled: msg.enabled });
      return;
    }

    if (msg.type === "entityFactsRequest") {
      try {
        // requireBRep is the guard AND the narrowing: it throws for a mesh
        // source, so `format` below is the document's own occt format.
        const format = this.requireBRep(
          "Geometry classification requires a B-rep source; a mesh has no analytic surface type."
        );
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const bytes = src.bytes;
        const facts = await cadCompute.getEntityFacts(
          this.runtimePath,
          bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough),
          msg.entityId
        );
        this.post({ type: "entityFactsResult", requestId: msg.requestId, facts });
      } catch (err) {
        this.post({ type: "entityFactsError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "clashCheckRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error(
            "Clash detection needs a B-rep source; mesh sources have no exact boolean geometry to intersect."
          );
        }
        // Mirror checkInterferenceTool's resolveOperand: volumes only
        // (interference is a solid-only concept); unknown/empty degrades to
        // a warning, never a throw.
        const warnings: string[] = [];
        const resolveOperand = async (label: "A" | "B", partName: string): Promise<string[]> => {
          const parts = await readParts(doc.path);
          const part = parts.find((p) => p.name === partName);
          if (!part) {
            warnings.push(`Part "${partName}" (operand ${label}) not found.`);
            return [];
          }
          if (part.volumes.length === 0) {
            warnings.push(`Part "${partName}" (operand ${label}) has no assigned solids (volumes).`);
          }
          return part.volumes;
        };
        const [idsA, idsB] = await Promise.all([
          resolveOperand("A", msg.partA),
          resolveOperand("B", msg.partB),
        ]);
        if (idsA.length === 0 || idsB.length === 0) {
          for (const w of warnings) this.post({ type: "status", text: w });
          this.post({
            type: "clashCheckResult",
            requestId: msg.requestId,
            result: { hasOverlap: false, overlapVolume: 0, unresolvedA: [], unresolvedB: [] },
          });
          return;
        }
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const result = await cadCompute.checkInterference(
          this.runtimePath,
          src.bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough),
          idsA,
          idsB
        );
        for (const w of warnings) this.post({ type: "status", text: w });
        if (result.unresolvedA.length > 0) {
          this.post({ type: "status", text: `Operand A: unresolved id(s) ${result.unresolvedA.join(", ")}.` });
        }
        if (result.unresolvedB.length > 0) {
          this.post({ type: "status", text: `Operand B: unresolved id(s) ${result.unresolvedB.join(", ")}.` });
        }
        this.post({ type: "clashCheckResult", requestId: msg.requestId, result });
      } catch (err) {
        this.post({ type: "clashCheckError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    // Clash panel, all-pairs variant over checkInterferenceAll (one
    // parse/replay total, AABB-pre-filtered) — mirrors checkInterferenceAllTool's
    // selection: every Part with volumes. Pairs are named in the kernel's
    // i<j enumeration order.
    if (msg.type === "clashCheckAllRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error(
            "Clash detection needs a B-rep source; mesh sources have no exact boolean geometry to intersect."
          );
        }
        const parts = await readParts(doc.path);
        const usable = parts.filter((p) => p.volumes.length > 0);
        if (usable.length < 2) {
          throw new Error(
            usable.length === 0
              ? "No Parts with assigned solids — assign solids to at least two Parts first."
              : "Only one Part has assigned solids — at least two are needed to check for clashes."
          );
        }
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const result = await cadCompute.checkInterferenceAll(
          this.runtimePath,
          src.bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough),
          usable.map((p) => p.volumes),
          // cad 2.5.0's bounded run: pairs past the budget come back as
          // `unchecked` placeholders (still one row per pair, so the count
          // check below holds) and are never reported as clash-free.
          msg.maxPairs !== undefined || msg.maxBooleans !== undefined
            ? { maxPairs: msg.maxPairs, maxBooleans: msg.maxBooleans }
            : undefined
        );
        const expected = (usable.length * (usable.length - 1)) / 2;
        if (result.pairs.length !== expected) {
          throw new Error(
            `Interference pipeline returned ${result.pairs.length} pair(s) for ${usable.length} part(s) — expected ${expected}.`
          );
        }
        for (const w of result.warnings) this.post({ type: "status", text: w });
        const named: Array<(typeof result.pairs)[number] & { partA: string; partB: string }> = [];
        for (let x = 0, n = 0; x < usable.length; x++) {
          for (let y = x + 1; y < usable.length; y++, n++) {
            named.push({ ...result.pairs[n], partA: usable[x].name, partB: usable[y].name });
          }
        }
        this.post({
          type: "clashCheckAllResult",
          requestId: msg.requestId,
          pairs: named,
          warnings: result.warnings,
          totalPairs: result.totalPairs,
          checkedPairs: result.checkedPairs,
          screenedPairs: result.screenedPairs,
          partial: result.uncheckedCount > 0,
        });
      } catch (err) {
        this.post({ type: "clashCheckAllError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "bomRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error(
            "BOM rows are computed for B-rep sources on the host; mesh sources have no per-part rows to compute."
          );
        }
        const parts = await readParts(doc.path);
        if (parts.length === 0) {
          this.post({
            type: "bomResult",
            requestId: msg.requestId,
            rows: [],
            warnings: ["No parts defined on this document."],
          });
          return;
        }
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const result = await cadCompute.computeBom(
          this.runtimePath,
          src.bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough),
          parts
        );
        this.post({
          type: "bomResult",
          requestId: msg.requestId,
          rows: result.rows,
          warnings: [...scadWarnings, ...result.warnings],
        });
      } catch (err) {
        this.post({ type: "bomError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "primitiveRecognizeRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error(
            "Primitive recognition needs a B-rep source; mesh sources have no analytic surfaces to classify."
          );
        }
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const report = await cadCompute.recognizePrimitives(
          this.runtimePath,
          src.bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough)
        );
        this.post({ type: "primitiveRecognizeResult", requestId: msg.requestId, report });
      } catch (err) {
        this.post({
          type: "primitiveRecognizeError",
          requestId: msg.requestId,
          message: (err as Error).message,
        });
      }
      return;
    }

    if (msg.type === "selectorSynthesizeRequest") {
      // The Edits panel's "Pin query" row. The webview sends the whole picked
      // set in one round trip and the host answers per id, so one refusal never
      // costs the rest of the selection.
      try {
        const format = this.requireBRep(
          "Pinning an operand as a query requires a B-rep source; mesh sources have no produced-face classification to induce from."
        );
        if (msg.entityIds.length === 0 || msg.entityIds.length > 25) {
          throw new Error(
            `Cannot synthesize queries for ${msg.entityIds.length} entities — pick between 1 and 25.`
          );
        }
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        // msg.op addresses the persistent (baked-inclusive) history; the
        // kernel only ever sees the replay tail, so it needs a tail-relative
        // index — and an op inside the baked prefix can't be re-synthesized
        // without rewriting the source file, since the kernel never replays it.
        const tailEdits = replayTail(this.currentEdits, this.currentBakedThrough);
        const replayOp = msg.op - this.currentBakedThrough;
        if (!Number.isInteger(replayOp) || replayOp < 0 || replayOp >= tailEdits.length) {
          throw new Error(
            `Bucket op ${msg.op} is inside the baked prefix — it cannot be re-synthesized without rewriting the source file.`
          );
        }
        const results: SelectorSynthesizeResultEntry[] = [];
        for (const entityId of msg.entityIds) {
          try {
            const r = await cadCompute.synthesizeSelector(
              this.runtimePath,
              src.bytes,
              src.format as OcctSourceFormat,
              tailEdits,
              replayOp,
              msg.role,
              entityId
            );
            // The kind tag is stamped from the producing op itself — server-
            // derived, never caller-supplied (the set_part precedent).
            results.push({
              entityId,
              query: r.query,
              kind: r.query ? (this.currentEdits[msg.op]?.op ?? null) : null,
              reason: r.reason,
            });
          } catch (err) {
            results.push({ entityId, query: null, kind: null, reason: (err as Error).message });
          }
        }
        this.post({ type: "selectorSynthesizeResult", requestId: msg.requestId, results });
      } catch (err) {
        this.post({
          type: "selectorSynthesizeError",
          requestId: msg.requestId,
          message: (err as Error).message,
        });
      }
      return;
    }

    if (msg.type === "meshHealRequest") {
      try {
        const format = this.requireMesh("Mesh healability check requires an STL/OBJ/PLY/glTF source.");
        const bytes = await fs.readFile(doc.path);
        const external = await this.gltfBuffers(format, bytes);
        try {
          const report = await cadCompute.checkMeshHealth(this.runtimePath, bytes, format, external);
          this.post({ type: "meshHealResult", requestId: msg.requestId, report });
        } catch (err) {
          // Same autoDecimate opt-in as check_mesh_health's MCP tool: only a
          // size refusal is decimation-shaped; anything else (corrupt file,
          // unparseable content) rethrows untouched.
          if (!msg.autoDecimate || !isHealableSizeError(err)) throw err;
          const forHeal = stlBytesForHeal(bytes, format, external);
          const ratio = Math.min(1, AUTO_DECIMATE_TARGET_TRIANGLES / forHeal.fromTriangles);
          const decimated = await cadCompute.decimateStlBoundary(forHeal.stlBytes, ratio);
          const report = await cadCompute.checkMeshHealth(this.runtimePath, decimated.bytes, "stl");
          this.post({
            type: "meshHealResult",
            requestId: msg.requestId,
            report: {
              ...report,
              decimated: { fromTriangles: decimated.fromTriangles, toTriangles: decimated.toTriangles, ratio },
            },
          });
        }
      } catch (err) {
        this.post({ type: "meshHealError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "fitRegionRequest") {
      try {
        const format = this.requireMesh("Region fitting requires an STL/OBJ/PLY/glTF source.");
        const bytes = await fs.readFile(doc.path);
        const fit = await cadCompute.fitMeshRegion(
          bytes,
          format,
          msg.point,
          {},
          await this.gltfBuffers(format, bytes)
        );
        this.post({ type: "fitRegionResult", requestId: msg.requestId, fit });
      } catch (err) {
        this.post({ type: "fitRegionError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "meshioOpsRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "meshio") {
          throw new Error(
            "Mesh operations require a meshio++-imported source (VTK/MED/CGNS/Exodus/XDMF/MDPA/Gmsh/Abaqus/UNV/SU2/Medit/GiD)."
          );
        }
        if (doc.route.format === "openfoam") {
          throw new Error(
            "Mesh operations are not available for OpenFOAM case markers — open the converted mesh instead."
          );
        }
        const specs = (msg.ops ?? []).map((o) => validateMeshioOpSpec(o));
        if (specs.length === 0 || specs.some((s) => s === null)) {
          throw new Error(
            "Unknown mesh operation — pick one of clean/decimate/smooth/subdivide/refine/agglomerate/convertCells."
          );
        }
        const report = await this.handleMeshioOps(doc.path, doc.route, specs.map((s) => s!));
        // A dismissed save dialog is a quiet no-op (no result post), mirroring
        // every other save flow here.
        if (report) {
          this.post({
            type: "meshioOpsResult",
            requestId: msg.requestId,
            steps: report.steps,
            warnings: report.warnings,
          });
        }
      } catch (err) {
        this.post({ type: "meshioOpsError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "standardPartsSearchRequest") {
      try {
        const result = await cadCompute.searchStandardParts({ q: msg.q, page: msg.page, pageSize: 20 });
        if (!result.available) throw new Error(result.reason);
        this.lastPartsSearch = {
          requestId: msg.requestId,
          pngById: new Map(result.value.items.map((i) => [i.id, i.pngUrl ?? ""])),
        };
        this.post({
          type: "standardPartsSearchResult",
          requestId: msg.requestId,
          items: result.value.items,
          page: result.value.page,
          totalPages: result.value.totalPages,
          total: result.value.total,
        });
      } catch (err) {
        this.post({
          type: "standardPartsSearchError",
          requestId: msg.requestId,
          message: (err as Error).message,
        });
      }
      return;
    }

    if (msg.type === "standardPartsThumbsRequest") {
      // Fire-and-forget: fetch this rendered page's thumbnails with bounded
      // concurrency and post back only the successes — failures stay absent
      // (text fallback), never an error. Must not hold the message loop:
      // search/insert round trips behind a slow image fetch would read as a
      // hung panel.
      void (async () => {
        const seen = this.lastPartsSearch;
        if (!seen || seen.requestId !== msg.searchId) return; // stale page
        const ids = msg.ids.filter((id) => seen.pngById.has(id)).slice(0, 25);
        const thumbs: Array<{ id: string; dataUrl: string }> = [];
        for (let i = 0; i < ids.length; i += THUMB_FETCH_CONCURRENCY) {
          const batch = ids.slice(i, i + THUMB_FETCH_CONCURRENCY);
          const results = await Promise.all(
            batch.map(async (id) => {
              const url = seen.pngById.get(id) ?? "";
              if (!url) return null;
              const hit = thumbsCache.get(url);
              if (hit) return { id, dataUrl: hit };
              const dataUrl = await fetchThumbnail(url);
              if (!dataUrl) return null; // never cached, never posted
              thumbsCache.set(url, dataUrl);
              return { id, dataUrl };
            })
          );
          for (const r of results) if (r) thumbs.push(r);
        }
        // Re-check after the awaits: a newer search, a document replaced in
        // this tab or a closed tab (disposeSession nulls it) all make this
        // page's thumbnails stale, and the view may already be gone.
        if (thumbs.length === 0 || this.lastPartsSearch !== seen) return;
        this.post({ type: "standardPartsThumbsResult", searchId: msg.searchId, thumbs });
      })().catch(() => {
        // `fetchThumbnail` and the cache never throw, but a floating promise
        // must never take down the handler; the text fallback already covers it.
      });
      return;
    }

    if (msg.type === "standardPartsInsertRequest") {
      try {
        const downloaded = await cadCompute.downloadStandardPart(msg.id);
        if (!downloaded.available) throw new Error(downloaded.reason);
        const savePath = await showSaveDialog({
          defaultPath: path.join(path.dirname(doc.path), msg.suggestedName),
          filters: [{ name: "STEP files", extensions: ["step", "stp"] }],
        });
        if (!savePath) {
          this.post({ type: "standardPartsInsertResult", requestId: msg.requestId, path: null });
          return;
        }
        await fs.writeFile(savePath, downloaded.value.bytes);
        this.post({ type: "standardPartsInsertResult", requestId: msg.requestId, path: savePath });
        this.hooks.onOpenRequest(savePath);
      } catch (err) {
        this.post({
          type: "standardPartsInsertError",
          requestId: msg.requestId,
          message: (err as Error).message,
        });
      }
      return;
    }

    if (msg.type === "importSvgRequest" || msg.type === "importDxfRequest") {
      const isSvg = msg.type === "importSvgRequest";
      const kind = isSvg ? "SVG" : "DXF";
      try {
        const picked = await showOpenDialog({
          openLabel: `Import ${kind}`,
          filters: [{ name: `${kind} files`, extensions: [isSvg ? "svg" : "dxf"] }],
        });
        if (!picked) return; // dialog dismissed — a quiet no-op, not an error
        const text = await fs.readFile(picked[0], "utf8");
        this.post(isSvg ? { type: "importSvgResult", text } : { type: "importDxfResult", text });
      } catch (err) {
        const message = (err as Error).message;
        this.post(isSvg ? { type: "importSvgError", message } : { type: "importDxfError", message });
      }
      return;
    }

    if (
      msg.type === "exportSvgRequest" ||
      msg.type === "exportDxfRequest" ||
      msg.type === "exportDrawingRequest"
    ) {
      await this.handleExportSilhouette(
        msg.type === "exportDxfRequest" ? "dxf" : "svg",
        msg.type === "exportDrawingRequest"
      );
      return;
    }

    if (msg.type === "exportSheetRequest") {
      if (doc.route) void this.handleExportSheet(doc.path, doc.route);
      return;
    }

    if (msg.type === "opPreviewRequest") {
      // Live preview of an in-progress edit: replays [...ops, draft] under a
      // SECOND cache key so the document's own cached B-rep is untouched, and
      // persists nothing. disposeSession() releases both keys.
      try {
        const format = this.requireBRep(
          "Live preview requires a B-rep source; mesh sources preview client-side and never send this request."
        );
        const clean = validateEditOp(msg.op);
        if (!clean) throw new Error("The drafted operation is invalid and cannot be previewed.");
        const planes = await readPlanes(doc.path).catch(() => [] as ConstructionPlane[]);
        const resolvedDraft = resolvePlaneRefs([clean], planes).ops[0] ?? clean;
        const resolvedOps = resolvePlaneRefs(
          replayTail(this.currentEdits, this.currentBakedThrough),
          planes
        ).ops;
        const result = await cadCompute.loadBRepCachedInWorker(
          `${this.sessionId}::oppreview`,
          this.runtimePath,
          await fs.readFile(doc.path),
          format,
          [...resolvedOps, resolvedDraft],
          tessellationParamsFor(this.tessellationQuality())
        );
        this.post({
          type: "opPreviewResult",
          requestId: msg.requestId,
          meshes: result.groups.flatMap((g) =>
            g.faces.map((f) => ({
              positions: encodeBuffer(f.buffers.positions),
              indices: encodeBuffer(f.buffers.indices),
              groupId: g.id,
              faceId: f.faceId,
            }))
          ),
          edges: result.edges.map((e) => ({
            positions: encodeBuffer(e.positions),
            edgeId: e.edgeId,
            smooth: e.smooth,
          })),
          points: result.points.map((p) => ({
            position: encodeBuffer(new Float32Array(p.position)),
            pointId: p.pointId,
          })),
          opOutcomes: result.opOutcomes,
          // cad 2.5.0's per-band colouring: the draft op's own bucket
          // (replay-tail-relative, like opOutcomes — the webview translates).
          opBuckets: result.opBuckets,
        });
      } catch (err) {
        this.post({ type: "opPreviewError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "macroRun") {
      try {
        const library = await readMacros(doc.path);
        const bundled = await readBundledMacros(this.runtimePath);
        // Caller-owned entries shadow bundled starters of the same name — the
        // same merge (and precedence) sendMacros displays, so Run and the
        // panel list can never disagree about which script a name means.
        const { merged } = mergeScriptLibraries(bundled, library);
        const entry = merged[msg.name];
        if (!entry) throw new Error(`No saved macro named "${msg.name}".`);
        const { script, unknownNames } = mergeScriptOverrides(entry.script, msg.parameters);
        const { values } = evaluateVariables(this.currentVariables);
        const compiled = compileParametricScript(script, values);
        if (compiled.ops.length === 0) {
          throw new Error(compiled.issues[0] ?? `"${msg.name}" compiled to no ops.`);
        }
        // Straight onto the webview's own op stack, so a macro is undoable and
        // removable op-by-op exactly like a hand-applied edit.
        this.post({ type: "macroApplyOps", ops: compiled.ops });
        const skipped =
          unknownNames.length > 0 ? ` (ignored unknown parameter(s): ${unknownNames.join(", ")})` : "";
        this.post({ type: "status", text: `Ran "${msg.name}" — ${compiled.ops.length} op(s)${skipped}.` });
      } catch (err) {
        this.post({ type: "error", message: (err as Error).message });
      }
      return;
    }

    // ---- cad 2.7.0: meshing presets ---------------------------------------

    if (msg.type === "meshPresetApply") {
      try {
        const library = await readMeshPresets(doc.path);
        const bundled = await readBundledMeshPresets(this.runtimePath);
        // Same merge (and precedence) sendMeshPresets displays, so Apply and
        // the panel list can never disagree about what a name means.
        const { merged } = mergePresetLibraries(bundled, library);
        const entry = merged[msg.name];
        if (!entry) throw new Error(`No saved mesh preset named "${msg.name}".`);
        const { options, warnings } = effectivePresetOptions(entry);
        // Exactly what set_mesh_options writes: `.mesh.json` + regenerated
        // `.geo`, with the session copy updated so a later Save flushes the
        // applied values rather than stale ones.
        this.currentMeshOptions = options;
        await Promise.all([writeMeshOptions(doc.path, options), writeGeoScript(doc.path, options)]);
        this.post({ type: "meshingOptions", options });
        const suffix = warnings.length > 0 ? ` (${warnings.join(" ")})` : "";
        this.post({ type: "status", text: `Applied mesh preset "${msg.name}".${suffix}` });
      } catch (err) {
        this.post({ type: "error", message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "meshPresetSaveCurrent") {
      try {
        const name = await showInputBox({
          title: "Save meshing preset",
          prompt: "Name for this preset (current FE Mesh options, stored in mm)",
          placeHolder: "my-coarse",
        });
        if (name === undefined || name.trim() === "") return; // dismissed — a quiet no-op
        const trimmed = name.trim();
        // Current options are mm-native, so the preset is stored at `unit: "mm"`
        // — conversion on a later apply is then a no-op, and the stored numbers
        // always match what the panel showed.
        const options = this.currentMeshOptions ?? (await readMeshOptions(doc.path));
        const library = await readMeshPresets(doc.path);
        const existed = Object.prototype.hasOwnProperty.call(library, trimmed);
        library[trimmed] = {
          name: trimmed,
          description: "Saved from current options",
          unit: "mm",
          engine: options.engine,
          options,
        };
        await writeMeshPresets(doc.path, library);
        await this.sendMeshPresets();
        this.post({
          type: "status",
          text: `Saved mesh preset "${trimmed}"${existed ? " (replaced existing)." : "."}`,
        });
      } catch (err) {
        this.post({ type: "error", message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "meshPresetDelete") {
      try {
        const library = await readMeshPresets(doc.path);
        if (!Object.prototype.hasOwnProperty.call(library, msg.name)) {
          // Either a bundled starter (read-only — the panel hides its Delete
          // button, so this is a backstop, not a normal path) or a name that
          // was never saved here at all.
          const bundled = await readBundledMeshPresets(this.runtimePath);
          if (Object.prototype.hasOwnProperty.call(bundled, msg.name)) {
            throw new Error(
              `"${msg.name}" is a bundled starter preset and cannot be deleted — save your own preset under a different name to override it.`
            );
          }
          throw new Error(`No saved mesh preset named "${msg.name}".`);
        }
        delete library[msg.name];
        await writeMeshPresets(doc.path, library);
        await this.sendMeshPresets();
        this.post({ type: "status", text: `Deleted mesh preset "${msg.name}".` });
      } catch (err) {
        this.post({ type: "error", message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "macroSaveCurrent") {
      try {
        if (this.currentEdits.length === 0) {
          throw new Error("Nothing to save — apply some edits first.");
        }
        const name = await showInputBox({
          title: "Save macro",
          prompt: `Name for this macro (${this.currentEdits.length} op(s))`,
          placeHolder: "bolt-circle",
        });
        if (name === undefined || name.trim() === "") return; // dismissed — a quiet no-op
        const library = await readMacros(doc.path);
        // The op list IS the recording: "record" is a selection over edits
        // already applied, not a live capture session.
        library[name.trim()] = {
          name: name.trim(),
          description: `Recorded from ${this.currentEdits.length} op(s)`,
          script: {
            variables: this.currentVariables.map((v) => ({ name: v.name, expr: v.expr })),
            steps: this.currentEdits.map((op) => ({ op })),
          },
        };
        await writeMacros(doc.path, library);
        await this.sendMacros();
        this.post({ type: "status", text: `Saved macro "${name.trim()}".` });
      } catch (err) {
        this.post({ type: "error", message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "macroDelete") {
      try {
        const library = await readMacros(doc.path);
        if (!Object.prototype.hasOwnProperty.call(library, msg.name)) {
          // Either a bundled starter (read-only — the panel hides its Delete
          // button, so this is a backstop, not a normal path) or a name that
          // was never saved here at all.
          const bundled = await readBundledMacros(this.runtimePath);
          if (Object.prototype.hasOwnProperty.call(bundled, msg.name)) {
            throw new Error(
              `"${msg.name}" is a bundled starter macro and cannot be deleted — save your own macro under a different name to override it.`
            );
          }
          throw new Error(`No saved macro named "${msg.name}".`);
        }
        delete library[msg.name];
        await writeMacros(doc.path, library);
        await this.sendMacros();
        this.post({ type: "status", text: `Deleted macro "${msg.name}".` });
      } catch (err) {
        this.post({ type: "error", message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "promoteToBrepButtonClicked") {
      await this.handlePromoteToBrep();
      return;
    }

    if (msg.type === "repairMeshButtonClicked") {
      await this.handleRepairMesh();
      return;
    }

    if (msg.type === "decomposeExportClicked") {
      if (doc.route) void this.handleDecomposeExport(doc.path, doc.route);
      return;
    }

    if (msg.type === "decomposeSaveMacroClicked") {
      if (doc.route) void this.handleDecomposeSaveMacro(doc.path, doc.route);
      return;
    }
  }

  /**
   * The configured tessellation quality, re-read on every use rather than
   * cached at open time — a Settings change takes effect on the next load,
   * matching the provider's own "always re-read" convention.
   */
  private tessellationQuality(): TessellationQuality {
    return normalizeTessellationQuality(
      stateStore.get(CAD_DEFAULT_KEYS.tessellationQuality, DEFAULT_TESSELLATION_QUALITY)
    );
  }

  /** Posts the folder-level macro library to the webview (provider.sendMacros). */
  private async sendMacros(): Promise<void> {
    if (!this.doc) return;
    const library = await readMacros(this.doc.path);
    const bundled = await readBundledMacros(this.runtimePath);
    const { merged } = mergeScriptLibraries(bundled, library);
    const owned = new Set(Object.keys(library));
    const macros = Object.values(merged)
      .map((entry) => ({
        name: entry.name,
        description: entry.description ?? null,
        parameters: scriptParameters(entry.script),
        // A caller-owned entry shadows a bundled starter of the same name —
        // the merged row is theirs (deletable), never the read-only starter.
        readOnly: !owned.has(entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.post({ type: "macros", macros });
  }

  /**
   * Posts the saved meshing-preset list for this document's folder
   * (provider.sendMeshPresets, cad 2.7.0). Bundled starters merge under the
   * folder's own library and are stamped `readOnly` — the sendMacros precedent.
   */
  private async sendMeshPresets(): Promise<void> {
    if (!this.doc) return;
    const library = await readMeshPresets(this.doc.path);
    const bundled = await readBundledMeshPresets(this.runtimePath);
    const { merged } = mergePresetLibraries(bundled, library);
    const owned = new Set(Object.keys(library));
    const presets: MeshPresetSummary[] = Object.values(merged)
      .map((entry) => ({
        name: entry.name,
        description: entry.description ?? null,
        unit: entry.unit,
        engine: entry.engine,
        // A caller-owned entry shadows a bundled starter of the same name —
        // the merged row is theirs (deletable), never the read-only starter.
        readOnly: !owned.has(entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.post({ type: "meshingPresets", presets });
  }

  /**
   * `.scad`-aware source reader for every occt path (provider.readOcctSource,
   * cad 1.12.0): reads the bytes and, for a `.scad`, converts them to `.csg`
   * with the user-installed openscad binary, so everything downstream only ever
   * sees step/iges/brep/csg. Conversion runs host-side with `cwd` at the
   * source's own directory — that is what keeps a multi-file model's relative
   * `use`/`include`/`import` working, and why this cannot move into the compute
   * worker (which only ever receives marshalled bytes).
   *
   * Conversion chatter accumulates into `warnings`; each caller status-posts
   * them. A missing binary throws `ScadUnavailableError`, whose message IS the
   * install hint, so every caller's existing catch already reports it properly.
   */
  private async readOcctSource(
    fsPath: string,
    format: CadFormat,
    warnings: string[]
  ): Promise<{ bytes: Uint8Array; format: CadFormat }> {
    return resolveEffectiveSource({
      modelPath: fsPath,
      format,
      readBytes: async () => fs.readFile(fsPath),
      warnings,
      binary: stateStore.get<string>(CAD_DEFAULT_KEYS.openscadBinary) || undefined,
    });
  }

  /** The document's B-rep format, or a thrown explanation for a mesh source. */
  private requireBRep(why: string): OcctSourceFormat {
    const route = this.doc?.route;
    if (!route || route.strategy !== "occt") throw new Error(why);
    return route.format as OcctSourceFormat;
  }

  /** The document's mesh format, or a thrown explanation for a B-rep source. */
  private requireMesh(why: string): MeshParseFormat {
    const route = this.doc?.route;
    if (!route || route.strategy !== "three") throw new Error(why);
    return route.format as MeshParseFormat;
  }

  /**
   * A `.gltf` references its vertex data from sibling `.bin` files, so those
   * have to be read and handed alongside the document's own bytes (the
   * provider's `resolveGltfBuffersFor`). Returns undefined for every other
   * format, and skips a buffer that cannot be read — the parser reports the
   * gap far better than a failed open would.
   */
  private async gltfBuffers(
    format: MeshParseFormat,
    bytes: Uint8Array
  ): Promise<GltfExternalBuffers | undefined> {
    if (!this.doc || format !== "gltf") return undefined;
    const dir = path.dirname(this.doc.path);
    return resolveExternalBuffers(bytes, async (relative) => {
      try {
        return new Uint8Array(await fs.readFile(path.join(dir, relative)));
      } catch {
        return undefined;
      }
    });
  }

  private async handleBRep(
    modelPath: string,
    format: Extract<CadFormat, "step" | "iges" | "brep" | "csg" | "scad">,
    ops: EditOp[]
  ): Promise<void> {
    const epoch = this.epoch;
    try {
      this.post({ type: "status", text: `Loading ${format.toUpperCase()} kernel…` });
      // A `.scad` converts to `.csg` bytes first (user-installed openscad
      // binary) — everything below only ever sees step/iges/brep/csg. A missing
      // binary throws ScadUnavailableError, whose message the catch below posts
      // verbatim: it IS the install hint.
      const scadWarnings: string[] = [];
      const src = await this.readOcctSource(modelPath, format, scadWarnings);
      const bytes = src.bytes;
      const effectiveFormat = src.format as OcctSourceFormat;
      this.post({ type: "status", text: `Tessellating ${format.toUpperCase()}…` });
      // Read the quality fresh on every load (cheap) rather than caching it at
      // open time — a Settings change should take effect on the next edit,
      // matching the provider's own "always re-read" convention.
      const quality = normalizeTessellationQuality(
        stateStore.get(CAD_DEFAULT_KEYS.tessellationQuality, DEFAULT_TESSELLATION_QUALITY)
      );
      const { groups, edges, points, tree, queryWarnings, warnings } =
        await cadCompute.loadBRepCachedInWorker(
          this.sessionId,
          this.runtimePath,
          bytes,
          effectiveFormat,
          ops,
          tessellationParamsFor(quality)
        );
      if (epoch !== this.epoch) return; // document changed while tessellating
      // A frozen operand query replays on its cached ids — the user has to know
      // the query was not honored rather than staring at unchanged geometry.
      // `.csg` parse/build skips (a dropped hull(), a faceted-cylinder
      // approximation) ride the same channel and must never be silent.
      for (const w of queryWarnings ?? []) this.post({ type: "status", text: w });
      for (const w of warnings ?? []) this.post({ type: "status", text: w });
      for (const w of scadWarnings) this.post({ type: "status", text: w });
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
      const text =
        effectiveFormat === "step" || effectiveFormat === "iges"
          ? Buffer.from(bytes).toString("latin1")
          : undefined;
      const sourceUnit =
        effectiveFormat === "step"
          ? detectStepLengthUnit(text!)
          : effectiveFormat === "iges"
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
      const [boundary, metadata, provenance, existingParts] = await Promise.all([
        cadCompute.convertToStlBoundaryWithRegions(bytes, format),
        cadCompute.readMeshioMetadata(bytes, format),
        // Provenance block, if the file carries one — never throws, so a
        // file without one simply yields nothing here.
        cadCompute.readMeshioProvenance(bytes, format),
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
      if (provenance) {
        this.post({ type: "status", text: `Provenance: ${provenance.lines.join(" | ")}` });
      }
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
      // Conversion chatter is deliberately dropped here rather than
      // status-posted: the document's own load path already surfaced the
      // identical warnings on open and re-surfaces them on every edit reload,
      // so repeating them on every meshing call would be spam for a condition
      // that has not changed. A missing binary still throws and reaches the
      // caller's catch, exactly like any other load failure.
      const src = await this.readOcctSource(doc.path, doc.route.format, []);
      const sourceBytes = src.bytes;
      // labelStepUnit: false — Gmsh's STEP importer reinterprets a correctly
      // labelled header and would undo this scale entirely. The intermediate
      // file is meshing input only, so it stays labelled "mm" while its
      // geometry is genuinely scaled (see exportBRep's doc comment).
      const stepBytes = await cadCompute.exportBRep(
        this.runtimePath,
        sourceBytes,
        src.format as OcctSourceFormat,
        "step",
        replayTail(this.currentEdits, this.currentBakedThrough),
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
          const scadWarnings: string[] = [];
          const src = await this.readOcctSource(modelPath, route.format, scadWarnings);
          for (const w of scadWarnings) this.post({ type: "status", text: w });
          const sourceBytes = src.bytes;
          return cadCompute.exportBRep(
            this.runtimePath,
            sourceBytes,
            src.format as OcctSourceFormat,
            targetFormat as Extract<CadFormat, "step" | "iges" | "brep">,
            replayTail(this.currentEdits, this.currentBakedThrough),
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
   * File ▸ New Blank Model… (provider.newBlankModelDialog, cad 1.10.0) —
   * creates an empty B-rep document and opens it, so the Edits panel's creation
   * vocabulary (primitives, 2D sketch profiles, bottom-up wireframe modeling,
   * booleans, fillets, patterns) can be used from scratch rather than only on
   * top of an existing model.
   *
   * The source file is an EMPTY COMPOUND and stays that way: everything the
   * user authors lives in the replayable `<file>.brep.edits.json` op-list,
   * exactly as it does for an edited STEP, so the read-only-CAD invariant is
   * untouched. `.brep` rather than `.step` because BREP is OCCT's own
   * serialization and carries no unit header to declare for geometry that isn't
   * there yet.
   *
   * Session-free, like `loadPreprocessDialog`: it creates a document rather
   * than acting on one, so it must work with no CAD tab focused. The new file
   * goes through `hooks.onOpenRequest` — index.ts opens it into a tab the same
   * way the Open dialog does.
   */
  private async newBlankModelDialog(): Promise<void> {
    try {
      // With no open document, fall back to the project root rather than a bare
      // relative name — that would resolve against the process cwd, which is
      // arbitrary in a packaged app.
      const defaultDir = this.doc ? path.dirname(this.doc.path) : projectRoot.effective();
      const destPath = await showSaveDialog({
        defaultPath: defaultDir ? path.join(defaultDir, "untitled.brep") : "untitled.brep",
        filters: [{ name: "CAD (B-rep)", extensions: ["brep"] }],
      });
      if (!destPath) return;

      // The dialog's filter is advisory on some platforms, so verify the
      // extension actually routes — the same cross-check, and the same
      // reasoning, as loadPreprocessDialog's.
      const route = routeFile(destPath);
      if (!route || route.strategy !== "occt" || route.format !== "brep") {
        this.post({
          type: "error",
          message: `A blank model must be created as a .brep file — "${path.basename(destPath)}" is not one.`,
        });
        return;
      }

      // Refuse to overwrite. Blanking an existing model would leave its own
      // .edits.json replaying against an empty base — geometry that looks
      // plausible and is silently wrong. A generic overwrite prompt reads as
      // routine and is easy to click through, so this refuses and names the fix.
      if (
        await fs
          .stat(destPath)
          .then(() => true)
          .catch(() => false)
      ) {
        this.post({
          type: "error",
          message:
            `"${path.basename(destPath)}" already exists. New Blank Model only creates new ` +
            `files — use File ▸ Open… to open the existing one.`,
        });
        return;
      }

      // The same pipeline function decompose_to_primitives goes through; an
      // empty op list is a supported input (see its doc comment).
      const built = await cadCompute.buildPrimitivesFile(this.runtimePath, [], "brep", "mm");
      await fs.writeFile(destPath, built.bytes);
      allowRoot(path.dirname(destPath));

      this.post({
        type: "status",
        text:
          "Blank model created — build it with the Edits panel. Your geometry lives in the " +
          ".edits.json sidecar beside it, so keep the pair together, or use File ▸ Export… / " +
          "Save Preprocess… to produce a standalone file.",
      });
      this.hooks.onOpenRequest(destPath);
    } catch (err) {
      this.post({ type: "error", message: `New blank model failed: ${(err as Error).message}` });
    }
  }

  /**
   * Re-resolves any stored `Part.selector` against the current model and
   * persists the result (provider's on-open half of cad 1.9.0's selector
   * synthesis). A part whose query still hits gets exact ids back; one whose
   * producing op changed kind freezes on its cached ids with a status line,
   * rather than silently resolving against the wrong op.
   *
   * Gated to documents that actually carry a selector, which is every sidecar
   * written before 1.9.0 — for those this costs nothing at all.
   */
  private async healPartSelectors(): Promise<void> {
    const doc = this.doc;
    if (!doc?.route || doc.route.strategy !== "occt") return;
    if (!this.currentParts.some((p) => p.selector !== undefined)) return;
    const epoch = this.epoch;
    try {
      const scadWarnings: string[] = [];
      const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
      for (const w of scadWarnings) this.post({ type: "status", text: w });
      const selected = await cadCompute.resolvePartSelectors(
        this.runtimePath,
        src.bytes,
        src.format as OcctSourceFormat,
        replayTail(this.currentEdits, this.currentBakedThrough),
        this.currentParts
      );
      if (epoch !== this.epoch) return; // document changed while resolving
      // Reference identity can't survive the worker RPC — compare by value,
      // same as rebindPartsOnChange.
      if (JSON.stringify(selected.parts) !== JSON.stringify(this.currentParts)) {
        this.currentParts = selected.parts;
        await writeParts(doc.path, this.currentParts);
        this.post({ type: "parts", parts: this.currentParts });
      }
      for (const warning of selected.warnings) this.post({ type: "status", text: warning });
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.post({
        type: "error",
        message: `Could not resolve stored selectors: ${(err as Error).message}`,
      });
    }
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
        readOptional(CAD_SIDECAR.parts),
        readOptional(CAD_SIDECAR.annotations),
        readOptional(CAD_SIDECAR.edits),
        readOptional(CAD_SIDECAR.meshOptions),
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
    const picked = await showOpenDialog({
      openLabel: "Load Preprocess Archive",
      filters: [{ name: "Preprocess Archive", extensions: ["zip"] }],
    });
    if (!picked) return;
    const zipPath = picked[0];

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
        await writeEdits(destPath, parsed.ops, parsed.variables, parsed.bakedThrough);
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
  /**
   * File ▾ ▸ Export Silhouette SVG/DXF… and Export Technical Drawing…
   * (provider.handleExportSvg). The drawing variant shares this whole
   * view/unit/save flow deliberately — the only difference is that the
   * pipeline solves hidden-line removal rather than tracing an outline.
   */
  private async handleExportSilhouette(format: "svg" | "dxf", hiddenLines: boolean): Promise<void> {
    const doc = this.doc;
    if (!doc?.route) return;
    const route = doc.route;
    if (route.strategy !== "occt" && !COMPARABLE_MESH_FORMATS.has(route.format)) {
      this.post({
        type: "error",
        message: `Silhouette ${format.toUpperCase()} export requires a STEP/IGES/BREP/CSG/SCAD or STL/OBJ/PLY/glTF source.`,
      });
      return;
    }

    type ViewChoice = {
      label: string;
      description?: string;
      direction: [number, number, number];
      up?: [number, number, number];
    };
    const choices: ViewChoice[] = [];
    if (this.currentViewState) {
      choices.push({
        label: "Current view",
        description: "as shown in the 3D view",
        direction: this.currentViewState.viewDirection,
        up: this.currentViewState.cameraUp,
      });
    }
    for (const [name, view] of Object.entries(SVG_VIEWS)) {
      choices.push({
        label: name.charAt(0) + name.slice(1).toLowerCase(),
        description: `[${view.direction.join(", ")}]`,
        ...view,
      });
    }

    const picked = await showQuickPick(choices, { placeHolder: "Silhouette view…" });
    if (!picked) return; // the primary choice — Escape cancels the export
    const unit = await this.pickExportUnit();

    await this.promptSaveAndWrite(
      doc.path,
      format,
      format === "dxf" ? "DXF Drawing" : "SVG Drawing",
      async () => {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const bytes = src.bytes;
        const source: CompareSource =
          route.strategy === "occt"
            ? {
                kind: "brep",
                bytes,
                format: src.format as OcctSourceFormat,
                ops: replayTail(this.currentEdits, this.currentBakedThrough),
              }
            : route.format === "gltf"
              ? {
                  kind: "gltf",
                  bytes,
                  externalBuffers: await this.gltfBuffers("gltf", bytes),
                }
              : { kind: route.format as "stl" | "obj" | "ply", bytes };
        const result = await cadCompute.exportSvgSilhouette(this.runtimePath, source, {
          direction: picked.direction,
          up: picked.up,
          unit,
          title: `${path.basename(doc.path)} — ${picked.label}`,
          format,
          annotations: this.currentAnnotations,
          hiddenLines,
        });
        for (const warning of result.warnings) this.post({ type: "status", text: warning });
        return Buffer.from(format === "dxf" ? (result.dxf ?? result.svg) : result.svg, "utf8");
      }
    );
  }

  /**
   * File ▸ Export Drawing Sheet… (provider.handleExportSheet, cad 2.3.0) —
   * several orthographic/iso views of the model at one shared scale, inside
   * a frame with a title block. Deliberately no unit quick-pick (the scale
   * ratio must stay in real mm, unlike the plain silhouette export above).
   * Pinned annotations are baked in via `dimensionDrawings`.
   */
  private async handleExportSheet(modelPath: string, route: FileRoute): Promise<void> {
    if (route.strategy !== "occt" && !COMPARABLE_MESH_FORMATS.has(route.format)) {
      this.post({
        type: "error",
        message: "Drawing sheet export requires a STEP/IGES/BREP/CSG/SCAD or STL/OBJ/PLY/glTF source.",
      });
      return;
    }

    const formatPick = await showQuickPick(
      [
        { label: "SVG", description: "vector drawing, prints at the sheet's physical size", format: "svg" as const },
        { label: "DXF", description: "layers 0 / HIDDEN / DIMENSIONS / BORDER / TITLE", format: "dxf" as const },
      ],
      { placeHolder: "Drawing sheet format…" }
    );
    if (!formatPick) return;

    const paperPick = await showQuickPick(
      PAPER_SIZES.map((paper) =>
        paper === "fit"
          ? { label: "Fit (1:1)", description: "sheet sized to the views at full scale", paper }
          : { label: paper, description: "landscape — largest standard scale that fits", paper }
      ),
      { placeHolder: "Paper size…" }
    );
    if (!paperPick) return;

    const format = formatPick.format;
    const name = path.basename(modelPath);
    await this.promptSaveAndWrite(
      modelPath,
      format,
      format === "dxf" ? "DXF Drawing" : "SVG Drawing",
      async () => {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(modelPath, route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const bytes = src.bytes;
        const source: CompareSource =
          route.strategy === "occt"
            ? {
                kind: "brep",
                bytes,
                format: src.format as OcctSourceFormat,
                ops: replayTail(this.currentEdits, this.currentBakedThrough),
              }
            : route.format === "gltf"
              ? { kind: "gltf", bytes, externalBuffers: await this.gltfBuffers("gltf", bytes) }
              : { kind: route.format as "stl" | "obj" | "ply", bytes };
        const views = (["front", "top", "right", "iso-ftr"] as const).map((view) => {
          const key = view === "iso-ftr" ? "ISO" : view.toUpperCase();
          return { name: view, ...SVG_VIEWS[key] };
        });
        const result = await cadCompute.exportDrawingSheet(this.runtimePath, source, {
          views,
          format,
          paper: paperPick.paper,
          projection: "first",
          annotations: this.currentAnnotations,
          title: name,
          date: new Date().toISOString().slice(0, 10),
        });
        for (const warning of result.warnings) this.post({ type: "status", text: warning });
        this.post({ type: "status", text: `Drawing sheet: ${result.views.length} views at ${result.scaleLabel}` });
        return Buffer.from(result.content, "utf8");
      }
    );
  }

  /** Mesh Health ▸ Promote to B-rep (provider.handlePromoteToBrep). */
  private async handlePromoteToBrep(): Promise<void> {
    const doc = this.doc;
    if (!doc?.route) return;
    if (doc.route.strategy !== "three") {
      this.post({ type: "error", message: "Promote to B-rep requires an STL/OBJ/PLY/glTF source." });
      return;
    }
    const meshFormat = doc.route.format as MeshParseFormat;

    const picked = await showQuickPick(
      [...BREP_FORMATS].map((format) => ({
        label: EXPORT_LABEL[format],
        description: `.${EXPORT_EXTENSION[format]}`,
        format: format as Extract<CadFormat, "step" | "iges" | "brep">,
      })),
      { placeHolder: "Promote to B-rep as…" }
    );
    if (!picked) return;
    const unit = await this.pickExportUnit();

    await this.promptSaveAndWrite(
      doc.path,
      EXPORT_EXTENSION[picked.format],
      EXPORT_LABEL[picked.format],
      async () => {
        const bytes = await fs.readFile(doc.path);
        const result = await cadCompute.promoteMeshToBrep(
          this.runtimePath,
          bytes,
          meshFormat,
          picked.format,
          unit,
          await this.gltfBuffers(meshFormat, bytes)
        );
        return result.bytes;
      }
    );
  }

  /**
   * Mesh Health ▸ Repair (robust) (provider.handleRepairMesh). Writes a NEW
   * watertight STL by tetrahedralizing with fTetWild and taking the volume
   * mesh's own boundary — watertight by construction however broken the input
   * was. The user reviews the result and re-runs Check Healability themselves;
   * chaining it automatically is deliberately not done.
   */
  private async handleRepairMesh(): Promise<void> {
    const doc = this.doc;
    if (!doc?.route) return;
    if (doc.route.strategy !== "three") {
      this.post({ type: "error", message: "Repair (robust) requires an STL/OBJ/PLY/glTF source." });
      return;
    }
    const meshFormat = doc.route.format as MeshParseFormat;

    await this.promptSaveAndWrite(doc.path, "stl", "STL", async () => {
      const bytes = await fs.readFile(doc.path);
      const result = await cadCompute.repairMesh(
        this.runtimePath,
        bytes,
        meshFormat,
        await this.gltfBuffers(meshFormat, bytes)
      );
      return result.stlBytes;
    });
  }

  /**
   * Primitives panel (Tier 2 "Primitive-recognition panel") — the interactive
   * half of `cad__decompose_to_primitives`. A ONE-SHOT EXPORT (recognize each
   * solid, emit parametric creation ops, write them as a brand-new
   * STEP/IGES/BREP file the user opens separately), not an in-place
   * reclassification of this document — the same export model
   * `handlePromoteToBrep` follows. Emission is computed fresh here rather
   * than trusting a client snapshot. A document with zero recognized solids
   * posts an explanatory error rather than writing an empty file.
   */
  private async handleDecomposeExport(modelPath: string, route: FileRoute): Promise<void> {
    if (route.strategy !== "occt") {
      this.post({
        type: "error",
        message: "Primitive export needs a B-rep source; mesh sources have no analytic surfaces to classify.",
      });
      return;
    }
    const picked = await showQuickPick(
      [...BREP_FORMATS].map((format) => ({
        label: EXPORT_LABEL[format],
        description: `.${EXPORT_EXTENSION[format]}`,
        format: format as Extract<CadFormat, "step" | "iges" | "brep">,
      })),
      { placeHolder: "Export recognized primitives as…" }
    );
    if (!picked) return;
    const unit = await this.pickExportUnit();

    await this.promptSaveAndWrite(
      modelPath,
      EXPORT_EXTENSION[picked.format],
      EXPORT_LABEL[picked.format],
      async () => {
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(modelPath, route.format, scadWarnings);
        for (const w of scadWarnings) this.post({ type: "status", text: w });
        const report = await cadCompute.recognizePrimitives(
          this.runtimePath,
          src.bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough)
        );
        const emission = emitPrimitiveOps(report, {
          existingVariableNames: this.currentVariables.map((v) => v.name),
        });
        if (emission.ops.length === 0) {
          throw new Error("No primitives recognized — nothing to export.");
        }
        const build = await cadCompute.buildPrimitivesFile(
          this.runtimePath,
          emission.ops,
          picked.format,
          unit
        );
        for (const w of [...emission.warnings, ...build.warnings]) this.post({ type: "status", text: w });
        return build.bytes;
      }
    );
  }

  /**
   * Primitives panel, Save-macro variant — the same emission as
   * handleDecomposeExport, saved as a reusable parameterized macro into this
   * document's folder macro library (the same file macroSaveCurrent and the
   * MCP save_parametric_script tool write, so a macro recorded here is
   * directly runnable by an agent and vice versa) instead of a B-rep file.
   * The emitted script is dry-compiled against its own declared defaults
   * before saving, so a broken macro never enters the library silently.
   */
  private async handleDecomposeSaveMacro(modelPath: string, route: FileRoute): Promise<void> {
    try {
      if (route.strategy !== "occt") {
        throw new Error(
          "Primitive macros need a B-rep source; mesh sources have no analytic surfaces to classify."
        );
      }
      const scadWarnings: string[] = [];
      const src = await this.readOcctSource(modelPath, route.format, scadWarnings);
      for (const w of scadWarnings) this.post({ type: "status", text: w });
      const report = await cadCompute.recognizePrimitives(
        this.runtimePath,
        src.bytes,
        src.format as OcctSourceFormat,
        replayTail(this.currentEdits, this.currentBakedThrough)
      );
      const emission = emitPrimitiveOps(report, {
        existingVariableNames: this.currentVariables.map((v) => v.name),
      });
      if (emission.ops.length === 0) {
        throw new Error("No primitives recognized — nothing to save.");
      }
      const name = await showInputBox({
        title: "Save primitives as macro",
        prompt: `Name for this macro (${emission.ops.length} op(s), ${emission.variables.length} variable(s))`,
        placeHolder: "recognized-primitives",
      });
      if (name === undefined || name.trim() === "") return; // dismissed — a quiet no-op
      const trimmed = name.trim();
      const scriptDoc: Record<string, unknown> = {
        variables: emission.variables,
        steps: emission.ops.map((op) => ({ op })),
      };
      const probe = compileParametricScript(scriptDoc, {});
      if (probe.ops.length === 0) {
        throw new Error(`Refusing to save "${trimmed}": the emitted script compiled to no ops.`);
      }
      const library = await readMacros(modelPath);
      const existed = Object.prototype.hasOwnProperty.call(library, trimmed);
      library[trimmed] = { name: trimmed, script: scriptDoc };
      await writeMacros(modelPath, library);
      await this.sendMacros();
      this.post({
        type: "status",
        text: `Saved macro "${trimmed}"${existed ? " (replaced existing)." : "."}`,
      });
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
    }
  }

  /**
   * Mesh-operations panel (Tier 2 "Mesh-operations panel for meshio
   * sources") — runs one validated meshio++ operation over the current
   * meshio++-imported source and writes the result to a NEW file at a
   * save-dialog-chosen path (the export model, like `mesh__transform_mesh`'s
   * `outputPath` — the source is never modified). Mirrors `handleRepairMesh`'s
   * structure via the shared `promptSaveAndWrite`, but keeps the source's own
   * extension (including the compound `.post.msh`) so the output stays in
   * the same format family the user opened. Returns the per-step report for
   * the `meshioOpsResult` post, or `null` when the save dialog was dismissed
   * (a quiet no-op, never an error). A step that cannot run is reported and
   * skipped by `runMeshioOps` itself, never silent — those warnings surface
   * both in the result post and as status lines.
   */
  private async handleMeshioOps(
    modelPath: string,
    route: FileRoute,
    ops: MeshioOpSpec[]
  ): Promise<{ steps: Array<{ op: string; applied: boolean; detail: string }>; warnings: string[] } | null> {
    const extKey = matchExtension(modelPath) ?? route.format;
    // The save-dialog filter takes a bare extension; the compound GiD key
    // (post.msh) is not one — fall back to the route format there.
    const ext = extKey.includes(".") ? route.format : extKey;
    let report: { steps: Array<{ op: string; applied: boolean; detail: string }>; warnings: string[] } | null =
      null;
    await this.promptSaveAndWrite(modelPath, ext, `${route.format.toUpperCase()} Mesh`, async () => {
      const sourceBytes = await fs.readFile(modelPath);
      const result = await cadCompute.runMeshioOps(sourceBytes, route.format, ops, ext);
      report = { steps: result.steps, warnings: result.warnings };
      for (const step of result.steps) {
        this.post({
          type: "status",
          text: `Mesh op ${step.op}: ${step.applied ? step.detail : `skipped — ${step.detail}`}`,
        });
      }
      for (const warning of result.warnings) this.post({ type: "status", text: warning });
      return result.bytes;
    });
    return report;
  }

  private async promptSaveAndWrite(
    modelPath: string,
    ext: string,
    filterLabel: string,
    getBytes: (savePath: string) => Promise<Uint8Array>,
    beforeWrite?: () => void
  ): Promise<string | undefined> {
    const baseName = path.basename(modelPath).replace(/\.[^.]+$/, "");
    const savePath = await showSaveDialog({
      defaultPath: path.join(path.dirname(modelPath), `${baseName}.${ext}`),
      filters: [{ name: filterLabel, extensions: [ext] }],
    });
    if (!savePath) return undefined;
    try {
      const bytes = await getBytes(savePath);
      beforeWrite?.();
      await fs.writeFile(savePath, bytes);
      this.post({ type: "status", text: `Exported to ${savePath}` });
      return savePath;
    } catch (err) {
      this.post({ type: "error", message: `Export failed: ${(err as Error).message}` });
      return undefined;
    }
  }
}
