import { finishOpen } from "./services/performance";
/**
 * CAD mode host adapter — a 1:1 port of cad/src/provider.ts's
 * resolveCustomEditor message loop onto Electron primitives.
 *
 * Substitutions relative to the extension (everything else is unchanged and
 * imported straight from the submodule):
 *   webview.postMessage            → WebContentsView.webContents.send
 *   onDidReceiveMessage            → ipcMain.on("cad:toHost")
 *   vscode.workspace.fs            → node:fs/promises (the cad *Store.ts
 *                                    files re-implemented over the vscode-free
 *                                    *Sidecar parse/serialize modules,
 *                                    including layersStore over layersSidecar)
 *   webview.asWebviewUri           → toKkssUrl (kkss-file:// scheme)
 *   OCCT/Gmsh service calls        → cadCompute worker RPC (same signatures,
 *                                    extensionPath = out/cad-runtime)
 *   showOpenDialog/showSaveDialog  → services/dialogs
 *   showQuickPick                  → services/quickPick modal window
 *   vscode.openWith                → hooks.onOpenRequest (router)
 *   cadPreview.openscadBinary      → the cadOpenscadBinary stateStore key
 *   cadPreview.openscadBackend     → cadOpenscadBackend (auto/cgal/manifold)
 *   cadPreview.openscadLibraryPaths → cadOpenscadLibraryPaths (OPENSCADPATH
 *                                    prepend, conversion child only)
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
 * provider's predicate: an edited STEP/IGES/BREP/STL/OBJ/PLY reads "N unsaved
 * edits" until File ▸ Save bakes the tail into the source (`saveDocument`, with
 * the ordering owned by `cadSaveInPlace.ts`), which advances `bakedThrough`.
 * That is accurate by cad's own definition — the source file does not yet
 * contain what is on screen.
 *
 * cad 3.16.0 (v3.14.0 → v3.16.0) ported, message for message against
 * provider.ts:
 *   - The OpenSCAD Customizer (`scadParams`/`scadOverrides` on ready, the
 *     `scadApplyOverrides` handler, the `<model>.scad-params.json` sidecar as the
 *     eighth `*Store.ts` re-implementation, and the defines replayed by
 *     `readOcctSource` on every conversion so opening, edits, BOM/hole-table/
 *     clash/health/measure, meshing and export all see the applied values).
 *     The preprocess archive carries the sidecar both ways. NOT ported: the
 *     source-file and sidecar watchers that re-post on an external change, for
 *     the same reason the include-tracking watchers are absent — KKSS has no
 *     source watcher (the conversions' own caching/depfile work comes free
 *     through `resolveEffectiveSource`).
 *   - Clash clearance (`minClearance` on both requests, including the same
 *     numeric guard, so an unusable value never reaches OCCT).
 *   - `color()` → Parts: `handleBRep` now returns the base shape's colour
 *     groups and `loadModel` chains them into `autoCreateCsgColorParts`, with
 *     the provider's own guards (edit-free tail, no existing Parts).
 *   - `documentInfo.relativePath` for Copy reference — relative to the EXPLICIT
 *     project root only (see `relativePath`), never an invented path.
 *   - `.3mf`, `.dae` and `.amf` join the router as display-only mesh formats,
 *     so every operation that needs triangles refuses them by name through
 *     cad's own `displayOnlyMeshMessage` (see `requireComparableMesh`) instead
 *     of the generic STL/OBJ/PLY/glTF sentence.
 *   - The Printability panel (`printabilityRequest` → `printabilityResult` /
 *     `printabilityError` over `docPipeline.checkPrintability`), including the
 *     tolerant read of the bundled starter limits
 *     (dist/process-limits/starter-limits.json).
 *   - cad 3.28.0's Draft panel (`draftRequest` → `draftResult` / `draftError`
 *     over `draftAnalysisHost.checkDraft`), including the per-corner draft
 *     overlay and the same display-only refusal as printability.
 * NOT ported from cad 3.16.0: `edits.externalFrom` (the badge marking an append
 * another writer made) — it is only ever set by the edits watcher, which KKSS
 * does not have, and the field is optional for exactly that reason.
 */
import { dialog, ipcMain, WebContentsView } from "electron";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { toast } from "./services/notifications";
import * as path from "node:path";
import { t } from "../shared/i18n";
import {
  routeFile,
  COMPARABLE_MESH_FORMATS,
  matchExtension,
  type CadFormat,
  type FileRoute,
  type MeshParseFormat,
} from "../../cad/src/fileRouter";
import { resolveEffectiveSource } from "../../cad/src/scadService";
import { parseScadParameters, validateScadOverrides, type ScadValue } from "../../cad/src/scadParams";
import {
  parseScadOverridesJson,
  serializeScadOverridesJson,
} from "../../cad/src/scadOverridesSidecar";
import {
  buildPartsFromCsgColors,
  csgColorPartsNote,
  type CsgColorGroup,
} from "../../cad/src/csgColorParts";
import { DISPLAY_ONLY_MESH_FORMATS, displayOnlyMeshMessage } from "../../cad/src/fileRouter";
import { SVG_VIEWS } from "../../cad/src/svgSilhouette";
import type { CompareSource } from "../../cad/src/modelDiffHost";
import type { Axis } from "../../cad/src/printability";
import { resolveExternalBuffers, type GltfExternalBuffers } from "../../cad/src/gltfParser";
import {
  encodeBuffer,
  type HostToWebview,
  type WebviewToHost,
  type Layer,
  type Part,
  type SelectorSynthesizeResultEntry,
} from "../../cad/src/protocol";
import {
  exportTargetsFor,
  EXPORT_EXTENSION,
  EXPORT_LABEL,
  MESH_SAVE_IN_PLACE_FORMATS,
  SAVE_IN_PLACE_FORMATS,
  UNIT_CONVERTIBLE_FORMATS,
} from "../../cad/src/exportTargets";
import {
  recoverInterruptedSave,
  savePaths,
  type SaveRecoveryDeps,
  type SaveRecoveryResult,
} from "../../cad/src/saveRecovery";
import { parsePartsJson, serializePartsJson } from "../../cad/src/partsSidecar";
import {
  parseLayersFile,
  serializeLayersJson,
  layersWithDefault,
  resolveLayerDrawFilter,
  type LayerDrawSubset,
} from "../../cad/src/layersSidecar";
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
  SIZE_MAX_SENTINEL,
  type MeshOptions,
} from "../../cad/src/meshOptions";
import { meshExportFormat, constraintExportWarning } from "../../cad/src/meshExportFormats";
import { dropInterfaceFacets, mdpaConstraintSummary, parseMdpaConstraintLinks } from "../../cad/src/mdpaConstraints";
import {
  rankFileName,
  partitionManifestName,
  partitionManifestJson,
  partitionWarnings,
  PARTITION_LAYOUT_NOTE,
} from "../../cad/src/mdpaPartition";
import { validateMergeFacets } from "../../cad/src/meshFacetMerge";
import { DISPLAY_UNITS, UNIT_LABELS, unitScaleFactor, type DisplayUnit } from "../../cad/src/lengthUnits";
import { detectStepLengthUnit } from "../../cad/src/stepUnits";
import { detectIgesLengthUnit } from "../../cad/src/igesUnits";
import { resolveCadMeshInput } from "./cadMeshInput";
import { rebaseOpOutcomes } from "./cadOpOutcomes";
import {
  saveBrepInPlace,
  saveMeshInPlace,
  type BrepSaveFormat,
  type MeshSaveFormat,
  type SaveFs,
  type SaveOutcome,
} from "./cadSaveInPlace";
import { normalizeViewerDefaults } from "../../cad/src/viewerDefaults";
import { validateEditOp, type EditOp } from "../../cad/src/editOps";
import { resolvePlaneRefs } from "../../cad/src/planeRefs";
import { emitPrimitiveOps } from "../../cad/src/primitiveEmit";
import { validateMeshioOpSpec, type MeshioOpSpec } from "../../cad/src/meshioOps";
import { validateMmgOptions } from "../../cad/src/mmgOptions";
import { remeshedParts } from "../../cad/src/mmgParts";
import { meshioCompanionCandidates } from "../../cad/src/meshioCompanions";
import type { MeshioCompanion } from "../../cad/src/meshioService";
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
import {
  bundledProcessLimitsPath,
  parseProcessLimits,
  resolvePlate,
  resolveProcess,
} from "../../cad/src/processLimits";
import { compileParametricScript } from "../../cad/src/parametricScript";
import { evaluateVariables } from "../../cad/src/editVariables";
import type { MeshGenerationInput } from "../../cad/src/gmshService";
import { sweepOutputName, SWEEP_NOTE, validateSweepSizes, type MeshSweepOutcome } from "../../cad/src/meshSweep";
import {
  isMeshioFieldFailure,
  describeMeshioFieldFailure,
  isHealableSizeError,
  stlBytesForHeal,
  decimatedInfo,
  AUTO_DECIMATE_TARGET_TRIANGLES,
} from "../../cad/src/meshioService";
import { cadCompute, kernelState, onKernelState, runOwnedJob, jobStatus, cancelOwnedJob } from "./cadComputeClient";
import { runCadMeshSweep } from "./cadMeshSweep";
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
 * `openscadBinary` (cad 1.12.0) is the executable the `.scad` → `.csg`
 * conversion falls back to. Since cad 3.26.0 the conversion is WASM-first
 * (the bundled build needs no install); unset still means "resolve `openscad`
 * on PATH", the submodule's own default, and the OPENSCAD_BINARY environment
 * variable stays the headless escape hatch and already reaches the MCP child
 * through its inherited env. `openscadBackend` (cad 3.12.0, auto|cgal|manifold) and
 * `openscadLibraryPaths` (extra OPENSCADPATH folders) ride the same
 * `resolveEffectiveSource` call — see `readOcctSource`, which spreads all
 * three so no entry point configures one and forgets the others.
 * `tessellationQuality` is read fresh on every B-rep load.
 */
const cadKey = (key: string): string => entryForVscode("cadPreview", key)!.storeKey!;
export const CAD_DEFAULT_KEYS = {
  background: cadKey("background"),
  meshSizePreset: cadKey("defaultMeshSizePreset"),
  showGridAndAxes: cadKey("showGridAndAxesOnOpen"),
  upAxis: cadKey("upAxis"),
  tessellationQuality: cadKey("tessellationQuality"),
  openscadBinary: cadKey("openscadBinary"),
  openscadBackend: cadKey("openscadBackend"),
  openscadLibraryPaths: cadKey("openscadLibraryPaths"),
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
    "stl", "obj", "ply", "gltf", "glb", "3mf", "dae", "amf", "usd", "usda", "usdc", "usdz", "wrl", "fbx", "step", "stp", "iges", "igs", "brep", "csg", "scad",
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

// Presentation/drawing layers (cad f53c7ed, roadmap "Layers, distinct from
// Parts") — same node:fs re-implementation shape as readParts/writeParts.
const readLayers = async (modelPath: string): Promise<{ layers: Layer[]; nextId: number }> => {
  try {
    return parseLayersFile(await fs.readFile(`${modelPath}${CAD_SIDECAR.layers}`, "utf8"));
  } catch {
    return { layers: [], nextId: 0 };
  }
};
const writeLayers = (modelPath: string, layers: Layer[], nextId: number): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.layers}`,
    serializeLayersJson(path.basename(modelPath), layers, nextId)
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
 * cad 3.16.0's OpenSCAD Customizer overrides (scadOverridesStore.ts, the eighth
 * sidecar): the `-D` defines the panel's Apply persists, replayed by
 * `readOcctSource` on every `.scad` conversion. The model file itself is never
 * written. Same node:fs re-implementation shape as the six above — cad's own
 * store is vscode-coupled (`assertNotDirty` guards the interactive save path,
 * which has no counterpart here).
 */
const readScadOverrides = async (modelPath: string): Promise<Record<string, ScadValue>> => {
  try {
    return parseScadOverridesJson(await fs.readFile(`${modelPath}${CAD_SIDECAR.scadOverrides}`, "utf8"));
  } catch {
    return {};
  }
};
const writeScadOverrides = (modelPath: string, overrides: Record<string, ScadValue>): Promise<void> =>
  writeFileAtomic(
    `${modelPath}${CAD_SIDECAR.scadOverrides}`,
    serializeScadOverridesJson(path.basename(modelPath), overrides)
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

/** cad 3.18.0's bundled printability process limits and build plates
 *  (dist/process-limits/starter-limits.json), read-only. The panel can always
 *  pass explicit numbers instead, and those win; a missing or broken bundle
 *  degrades to "no starters", never an error (parseProcessLimits itself drops
 *  a bad row rather than the file). */
const readBundledProcessLimits = async (runtimePath: string) =>
  parseProcessLimits(await readTextOrEmpty(bundledProcessLimitsPath(runtimePath)));

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
  /** A mesh file was exported to disk (post mode may want to open it).
   * `sourcePath` is the CAD document it was exported from, so the layer
   * sync can translate `<source>.layers.json` into the target's view sidecar. */
  onMeshExported(fsPath: string, sourcePath: string): void;
  /** The tab's unsaved state flipped (drives the tab dot). */
  onDirtyChanged(): void;
  /** Modal "Save in place" / Cancel for a bake into the source file. */
  confirmSaveInPlace(message: string): Promise<boolean>;
}

/** The real filesystem, shaped for `cadSaveInPlace`. */
const SAVE_FS: SaveFs = {
  readFile: (p) => fs.readFile(p),
  writeFile: (p, bytes) => fs.writeFile(p, bytes),
  copyFile: (from, to) => fs.copyFile(from, to),
  rename: (from, to) => fs.rename(from, to),
  rm: (p) => fs.rm(p, { force: true }),
};

export class CadHost {
  private doc: { path: string; route: FileRoute | undefined } | undefined;
  private readonly pending = new Map<string, PendingExport>();
  private partsSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private layersSaveTimer: ReturnType<typeof setTimeout> | undefined;
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
   *  replayed against the loaded body. Read from the sidecar and advanced by
   *  File ▸ Save (`saveDocument`) or by another process (`cad__save_model`). */
  private currentBakedThrough = 0;
  private currentParts: Part[] = [];
  private currentLayers: Layer[] = [];
  /** Never-recycled `layer-N` allocation counter, persisted in the sidecar. */
  private currentLayersNextId = 0;
  private currentAnnotations: Annotation[] = [];
  private currentViewState: ViewState | undefined;
  private currentMeshOptions: MeshOptions | undefined;
  /**
   * cad 3.16.0's OpenSCAD Customizer overrides, as last applied. Session state
   * only — the sidecar beside the `.scad` file is the source of truth, and
   * `readOcctSource` re-reads it, so this exists to answer the panel with what
   * the geometry on screen was actually built from.
   */
  private currentScadOverrides: Record<string, ScadValue> = {};
  /** MSH text of the last mesh this panel generated — what the quality gate
   * runs over. Reset at the start of each generate, mirroring provider.ts. */
  private lastMshText: string | null = null;
  /** The latest Standard-Parts search page, so a thumbnails request can be
   *  validated against it (stale pages ignored) and mapped id → image URL. */
  private lastPartsSearch: { requestId: string; pngById: Map<string, string> } | null = null;
  /** Guards stale async completions after the document changes. */
  private epoch = 0;
  /** Last `documentInfo` actually posted (serialized), so syncing is idempotent. */
  private lastDocumentInfo = "";
  /** Last dirty value reported to the tab strip, so the hook fires on a flip only. */
  private lastDirty = false;
  /** True once this session has made the one-deep `<file>.bak` (first save asks). */
  private madeSourceBackupThisSession = false;
  /** Re-entrancy guard: a second Save while one is in flight would stack two bakes. */
  private saving: Promise<boolean> | undefined;

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
    finishOpen(this.currentFile, msg.type);
    this.view.webContents.send("cad:toWebview", msg);
  };

  /** Called by the module-level readiness subscription above. */
  postKernelStatus(state: ReturnType<typeof kernelState>): void {
    this.post({ type: "kernelStatus", state });
  }

  // ---- cad 3.26.0 recoverable save-in-place (mesh 3.7.0's journal, now shared) ----
  //
  // The CONSUMER half of `saveRecovery.ts` only, ported from
  // provider.ts's `recoverSave`. KKSS opens no transaction of its own: its
  // File ▸ Save flushes sidecars and never bakes, so `beginSave`/
  // `endSave` have no call site here and `performSaveInPlace` has no
  // counterpart to guard. What KKSS does need is the other direction — an
  // interrupted transaction left by `cad__save_model` (or any other process
  // baking that file) must be settled on open, or the viewer replays the same
  // edit over geometry that already contains it, which is exactly the hazard
  // the journal exists to remove.
  //
  // The deps are node:fs rather than `vscode.workspace.fs`, and two of the
  // extension's hooks have no counterpart: `askUnrecognised` is the modal
  // picker (a dismissed picker is the `null` that means "keep"), and
  // `withSourceWrite` is a no-op because this host has no source watcher to
  // suppress — a change made here is observed the same way any other external
  // write is.
  private meshRecoveryDeps(docPath: string): SaveRecoveryDeps {
    const sibling = (name: string): string => path.join(path.dirname(docPath), name);
    return {
      readBytes: (name) => fs.readFile(sibling(name)),
      readBytesOrNull: async (name) => {
        // A Buffer IS a Uint8Array, and hashing walks it as one, so the node
        // read needs no copy — only the absent/unreadable case is special.
        try {
          return await fs.readFile(sibling(name));
        } catch {
          return null;
        }
      },
      writeBytes: (name, bytes) => fs.writeFile(sibling(name), bytes),
      renameOver: (from, to) => fs.rename(sibling(from), sibling(to)),
      deleteFile: (name) => fs.rm(sibling(name), { force: true }),
      readEdits: () => readEdits(docPath),
      writeEdits: (ops, variables, bakedThrough) =>
        writeEdits(docPath, ops, variables, bakedThrough),
      askUnrecognised: async (info) => {
        // The same two answers the provider's showWarningMessage offers. The
        // restore option exists only when that backup genuinely is this
        // transaction's pre-save state (saveRecovery decides it), so it is
        // offered conditionally here too.
        const restore = t("Restore the pre-save backup");
        const picked = await showQuickPick(
          [
            ...(info.canRestoreBackup ? [{ label: restore }] : []),
            { label: t("Keep the current file") },
          ],
          { placeHolder: info.message },
        );
        if (!picked) return null;
        return picked.label === restore ? "restore" : "keep";
      },
      withSourceWrite: (fn) => fn(),
    };
  }

  /**
   * Repairs an interrupted save-in-place, if one is pending — mesh or B-rep
   * (cad 3.26.0). Returns the
   * upstream result so a caller that already holds state can react; the `ready`
   * hydration simply re-reads the sidecar afterwards, which is correct for
   * every branch (a `finish` wrote it, a `restore` rewrote the source, and the
   * rest left both alone).
   *
   * Gated on `SAVE_IN_PLACE_FORMATS` — the same one set the save paths
   * gate on — so a glTF, meshio or CAD-text source never reaches the journal
   * machinery at all. Non-fatal by construction upstream: a recovery problem
   * must never be the reason a model refuses to open, so the caller keeps
   * today's behaviour and only reports the message.
   */
  private async recoverMeshSave(): Promise<SaveRecoveryResult> {
    const route = this.doc?.route;
    if (!this.doc || !route || !SAVE_IN_PLACE_FORMATS.has(route.format)) {
      return {
        action: "none",
        reason: "not-savable",
        bakedThrough: 0,
        message: null,
        sidecarChanged: false,
        sourceChanged: false,
      };
    }
    const fileName = path.basename(this.doc.path);
    const result = await recoverInterruptedSave(
      savePaths(fileName, EXPORT_EXTENSION[route.format as CadFormat]),
      fileName,
      this.meshRecoveryDeps(this.doc.path)
    );
    if (result.message) {
      // The unrecognised branch is the one case the user must see as an ERROR,
      // not a status line: the document may be showing geometry that does not
      // match its edit history (provider.ts, the same rule).
      if (result.action === "ask") this.post({ type: "error", message: result.message });
      else this.post({ type: "status", text: result.message });
    }
    return result;
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
      relativePath: this.relativePath(),
      format: this.doc.route?.format ?? null,
      dirty,
      unsavedEdits: dirty ? this.currentEdits.length - this.currentBakedThrough : 0,
    };
    const serialized = JSON.stringify(info);
    // The tab dot follows the same predicate as the chip, reported on a flip
    // only. Before the dedup return: the chip may be unchanged while a reset
    // `lastDirty` still needs reconciling.
    if (dirty !== this.lastDirty) {
      this.lastDirty = dirty;
      this.hooks.onDirtyChanged();
    }
    if (serialized === this.lastDocumentInfo) return;
    this.lastDocumentInfo = serialized;
    this.post(info);
  }

  /**
   * cad 3.16.0's Copy-reference path — what a copied entity reference quotes
   * (`examples/STP/bull.stp#face-12`). The provider gets it from
   * `vscode.workspace.asRelativePath`; KKSS has no workspace folders, so this is
   * the *explicit* project root only (the one value CLAUDE.md's project-folder
   * invariant allows to be displayed or handed to a submodule), and only while
   * the document really sits inside it. Undefined otherwise, which the field is
   * explicitly optional for — a quote then carries the absolute path, never a
   * made-up relative one.
   */
  private relativePath(): string | undefined {
    const root = projectRoot.explicit();
    if (!root) return undefined;
    const relative = path.relative(root, this.doc!.path);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join("/");
  }

  /** Unsaved edits that File ▸ Save would write into the source file. */
  isDirty(): boolean {
    return this.isDocumentDirty();
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

  /** The sidecar half of File ▸ Save (provider flushSidecars) — `saveDocument` adds the bake. */
  async flushSidecars(): Promise<void> {
    if (!this.doc) return;
    if (this.partsSaveTimer) clearTimeout(this.partsSaveTimer);
    if (this.layersSaveTimer) clearTimeout(this.layersSaveTimer);
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
    if (this.annotationsSaveTimer) clearTimeout(this.annotationsSaveTimer);
    if (this.viewSaveTimer) clearTimeout(this.viewSaveTimer);
    if (this.planesSaveTimer) clearTimeout(this.planesSaveTimer);
    try {
      await Promise.all([
        writeParts(this.doc.path, this.currentParts),
        writeLayers(this.doc.path, this.currentLayers, this.currentLayersNextId),
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

  /**
   * File ▸ Save, and the "Save" of the close/quit/replace prompts: flushes every
   * sidecar, then — when the source is a format that can take its own edits
   * back — bakes the unbaked tail into the file itself (cad's
   * `saveDocumentSource`, Ctrl+S in VS Code).
   *
   * Resolves `true` when there is nothing left unsaved, `false` when the user
   * declined the first-save confirmation (nothing was written, the tab stays
   * dirty), and THROWS when the write failed — the same contract
   * `MeshHost.saveDocument` has, so index.ts's one dirty-tab guard serves both.
   * Concurrent calls share one in-flight save: a second bake stacked on the
   * first would replay the same tail over a half-written source.
   */
  saveDocument(): Promise<boolean> {
    if (this.saving) return this.saving;
    const run = this.runSave().finally(() => {
      this.saving = undefined;
    });
    this.saving = run;
    return run;
  }

  private async runSave(): Promise<boolean> {
    const doc = this.doc;
    if (!doc?.route) return true;
    const epoch = this.epoch;
    const route = doc.route;
    await this.flushSidecars();
    if (!this.isDocumentDirty()) return true;

    // Settle a transaction a previous run (or `cad__save_model`) left in flight
    // BEFORE opening a new one, so two saves can never stack their markers. A
    // `finish` moves the watermark and a `restore` rewrote the source, so the
    // sidecar is re-read and the page reloaded. Mesh and B-rep alike since
    // cad 3.26.0 (provider.ts settles before both save paths).
    if (SAVE_IN_PLACE_FORMATS.has(route.format)) {
      const recovered = await this.recoverMeshSave();
      if (recovered.sidecarChanged || recovered.sourceChanged) {
        const settled = await readEdits(doc.path);
        this.currentEdits = resolvePlaneRefs(settled.ops, this.currentPlanes).ops;
        this.currentVariables = settled.variables;
        this.currentBakedThrough = settled.bakedThrough;
        this.postEdits();
        if (recovered.sourceChanged) this.loadModel();
        if (!this.isDocumentDirty()) return true;
      }
    }

    const warnings: string[] = [];
    const common = {
      fs: SAVE_FS,
      confirm: (message: string) => this.hooks.confirmSaveInPlace(message),
      commitWatermark: (next: number) => this.commitWatermark(next),
    };
    let outcome: SaveOutcome;
    if (route.strategy === "occt") {
      const format = route.format as BrepSaveFormat;
      const bakedBefore = this.currentBakedThrough;
      outcome = await saveBrepInPlace(
        {
          docPath: doc.path,
          format,
          edits: this.currentEdits,
          bakedThrough: bakedBefore,
          parts: this.currentParts,
          annotations: this.currentAnnotations,
          layers: this.currentLayers,
          firstSaveOfSession: !this.madeSourceBackupThisSession,
        },
        {
          ...common,
          readSource: () => this.readOcctSource(doc.path, route.format, warnings),
          exportBRep: (src, tail, unit, parts) =>
            cadCompute.exportBRep(this.runtimePath, src.bytes, src.format as OcctSourceFormat, format, tail, unit, true, parts),
          rebindAcrossSave: (oldBytes, oldFormat, oldOps, newBytes, parts, annotations, layers) =>
            cadCompute.rebindPartsAcrossSave(
              this.runtimePath,
              oldBytes,
              oldFormat as OcctSourceFormat,
              oldOps,
              newBytes,
              format,
              [],
              parts,
              annotations,
              layers
            ),
        }
      );
    } else if (route.strategy === "three" && MESH_SAVE_IN_PLACE_FORMATS.has(route.format)) {
      const format = route.format as MeshSaveFormat;
      outcome = await saveMeshInPlace(
        {
          docPath: doc.path,
          format,
          edits: this.currentEdits,
          variables: this.currentVariables,
          bakedThrough: this.currentBakedThrough,
          firstSaveOfSession: !this.madeSourceBackupThisSession,
        },
        {
          ...common,
          bake: (bytes, fmt, tail) => cadCompute.bakeMeshEdits(bytes, fmt, tail, fmt),
        }
      );
    } else {
      // meshio / glTF / CAD-text sources have no same-format writer: the
      // sidecars were flushed above and that is the whole save.
      return true;
    }

    if (outcome.status === "cancelled") return false;
    if (outcome.status === "failed") {
      this.post({ type: "error", message: outcome.message });
      throw new Error(outcome.message);
    }
    if (epoch !== this.epoch) return true; // document replaced while saving
    if (outcome.madeBackup) this.madeSourceBackupThisSession = true;
    for (const w of [...warnings, ...outcome.warnings]) this.post({ type: "status", text: w });
    await this.adoptRebound(doc.path, outcome.rebound);
    // The webview adopts the new save point from the `edits` post (its undo
    // gate and the locked rows), then the page reloads from the new bytes.
    this.postEdits();
    this.post({
      type: "status",
      text: `Saved in place to ${path.basename(doc.path)} (${outcome.baked} op(s) baked)`,
    });
    if (route.strategy === "three") {
      // The bytes at the same URL just changed; a query string defeats any
      // cached copy (the protocol handler routes on the path alone).
      this.post({ type: "loadUrl", url: `${toKkssUrl(doc.path)}?v=${Date.now()}`, format: route.format });
    } else {
      this.loadModel();
    }
    return true;
  }

  /**
   * Advances the save marker and persists it — the host half of
   * `SaveInPlaceDeps.commitWatermark`. Clears the pending autosave first (a
   * stale-watermark write must not land after this one), and leaves the
   * previous watermark in effect if the write throws.
   */
  private async commitWatermark(next: number): Promise<void> {
    const doc = this.doc;
    if (!doc) throw new Error("The document was closed while saving.");
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    this.editsSaveTimer = undefined;
    const before = this.currentBakedThrough;
    this.currentBakedThrough = next;
    try {
      await writeEdits(doc.path, this.currentEdits, this.currentVariables, next);
    } catch (err) {
      this.currentBakedThrough = before;
      throw err;
    }
  }

  /** Persists and posts whichever of Parts/annotations/layers a save's rebind changed. */
  private async adoptRebound(
    modelPath: string,
    rebound: { parts?: Part[]; annotations?: Annotation[]; layers?: Layer[] } | undefined
  ): Promise<void> {
    if (!rebound) return;
    if (rebound.parts) {
      this.currentParts = rebound.parts;
      await writeParts(modelPath, this.currentParts);
      this.post({ type: "parts", parts: this.currentParts });
    }
    if (rebound.annotations) {
      this.currentAnnotations = rebound.annotations;
      await writeAnnotations(modelPath, this.currentAnnotations);
      this.post({ type: "annotations", annotations: this.currentAnnotations });
    }
    if (rebound.layers) {
      this.currentLayers = rebound.layers;
      await writeLayers(modelPath, this.currentLayers, this.currentLayersNextId);
      this.post({ type: "layers", layers: this.currentLayers, nextId: this.currentLayersNextId });
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
    if (this.layersSaveTimer) clearTimeout(this.layersSaveTimer);
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
    if (this.annotationsSaveTimer) clearTimeout(this.annotationsSaveTimer);
    if (this.viewSaveTimer) clearTimeout(this.viewSaveTimer);
    if (this.planesSaveTimer) clearTimeout(this.planesSaveTimer);
    this.partsSaveTimer = this.editsSaveTimer = this.meshSaveTimer = undefined;
    this.layersSaveTimer = undefined;
    this.annotationsSaveTimer = this.viewSaveTimer = this.planesSaveTimer = undefined;
    for (const p of this.pending.values()) p.reject(new Error("Document closed"));
    this.pending.clear();
    this.currentEdits = [];
    this.currentVariables = [];
    this.currentBakedThrough = 0;
    this.currentParts = [];
    this.currentLayers = [];
    this.currentLayersNextId = 0;
    this.currentAnnotations = [];
    this.currentPlanes = [];
    this.currentScadOverrides = {};
    this.lastMshText = null;
    this.currentViewState = undefined;
    this.currentMeshOptions = undefined;
    this.lastPartsSearch = null;
    // A reopened page must receive the chip again even for an identical value.
    this.lastDocumentInfo = "";
    // Not fired: the caller (openPath → onTitle, or tab close) refreshes the strip.
    this.lastDirty = false;
    // The one-deep backup belongs to a document session, not to the tab.
    this.madeSourceBackupThisSession = false;
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
  private loadModel(autoFit = true): void {
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
        resolvePlaneRefs(replayTail(this.currentEdits, this.currentBakedThrough), this.currentPlanes).ops,
        autoFit
      ).then((csgColors) => this.autoCreateCsgColorParts(csgColors));
    }
  }

  /**
   * cad 3.16.0's `color()` → Parts (provider.autoCreateCsgColorParts): a
   * `.csg`/`.scad` source can carry named colours per solid, and the viewer
   * turns them into Parts so the colour groups are addressable for meshing and
   * selection. Deliberately narrow, every guard load-bearing:
   *
   * - Only when the document has an edit-free *replay tail*: with ops applied,
   *   the colours describe a base the user has since reshaped, and inventing
   *   Parts from it would silently claim membership the geometry no longer has.
   * - Only when there are no Parts yet — an authored Part list always wins,
   *   because a user's grouping is more specific than `color()`.
   * - Failures post a status line; they never fail the load.
   */
  private async autoCreateCsgColorParts(groups: readonly CsgColorGroup[] | undefined): Promise<void> {
    const doc = this.doc;
    if (!groups || groups.length === 0 || !doc) return;
    try {
      if (replayTail(this.currentEdits, this.currentBakedThrough).length > 0) return;
      if (this.currentParts.length > 0 || (await readParts(doc.path)).length > 0) return;
      const parts = buildPartsFromCsgColors(groups);
      if (parts.length === 0) return;
      this.currentParts = parts;
      await writeParts(doc.path, parts);
      this.post({ type: "parts", parts });
      this.post({ type: "status", text: csgColorPartsNote(parts.length) });
    } catch (err) {
      this.post({ type: "status", text: `Could not create Parts from color(): ${(err as Error).message}` });
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
    if (this.currentParts.length === 0 && this.currentAnnotations.length === 0 && this.currentLayers.length === 0) return;
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
        this.currentAnnotations,
        this.currentLayers
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
      const layersChanged = result.layerStats.rebound > 0 || result.layerStats.dropped > 0;
      if (partsChanged) this.currentParts = result.parts;
      if (annotationsChanged) this.currentAnnotations = result.annotations;
      if (layersChanged) this.currentLayers = result.layers;
      if (partsChanged || selectorsChangedIds) {
        await writeParts(doc.path, this.currentParts);
        this.post({ type: "parts", parts: this.currentParts });
      }
      if (annotationsChanged) {
        await writeAnnotations(doc.path, this.currentAnnotations);
        this.post({ type: "annotations", annotations: this.currentAnnotations });
      }
      if (layersChanged) {
        await writeLayers(doc.path, this.currentLayers, this.currentLayersNextId);
        this.post({ type: "layers", layers: this.currentLayers, nextId: this.currentLayersNextId });
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
      // A renderer reload loses its document chip even when the host's
      // document state did not change. Force the ready handshake to resend
      // documentInfo instead of treating the unchanged value as a duplicate.
      this.lastDocumentInfo = "";
      // cad 3.7.0's recoverable mesh save-in-place (roadmap 1.5): repair an
      // interrupted transaction FIRST, so the hydration below reads whatever
      // watermark recovery landed. The interactive bake and `cad__save_model`
      // (or any other process) both bake in place, so an interrupted one can be
      // left behind, and a `finish` here is the difference between the pending
      // edits applying once and being replayed over geometry that already
      // contains them.
      await this.recoverMeshSave();
      // Load edits before the model so a B-rep source is tessellated already-edited.
      // Planes are loaded alongside them so any `planeId` resolves before the
      // first tessellation (provider.ready): since cad 2.5.0 a plane-authored
      // profile op may carry no cached vectors, and the kernel skips one that
      // was never resolved — it would silently vanish on reopen.
      const [parsed, planesInitial, layersInitial] = await Promise.all([
        readEdits(this.doc.path),
        readPlanes(this.doc.path),
        readLayers(this.doc.path),
      ]);
      this.currentEdits = resolvePlaneRefs(parsed.ops, planesInitial).ops;
      this.currentVariables = parsed.variables;
      this.currentBakedThrough = parsed.bakedThrough;
      this.currentPlanes = planesInitial;
      this.currentLayers = layersInitial.layers;
      this.currentLayersNextId = layersInitial.nextId;
      // A genuine open: the viewer must re-frame (`autoFit: false`), unlike an
      // edit-driven rebuild (provider `loadModel(true)` vs `loadModel()`).
      this.loadModel(false);
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
      this.post({ type: "layers", layers: this.currentLayers, nextId: this.currentLayersNextId });
      void this.sendMeshOptions();
      void readViewState(this.doc.path).then((view) => {
        this.currentViewState = view ?? undefined;
        this.post({ type: "viewState", view });
      });
      this.post({ type: "planes", planes: this.currentPlanes });
      // cad 3.16.0's OpenSCAD Customizer (provider.ready): the panel's fields
      // come from the source text (the same parseScadParameters the
      // `list_scad_parameters` tool uses — no openscad binary needed) and its
      // values from the sidecar. Posted for a `.scad` document ONLY, so any
      // other format leaves the panel hidden with nothing to hydrate.
      if (this.doc.route.format === "scad") {
        void fs
          .readFile(this.doc.path, "utf8")
          .then(
            (text) => {
              this.post({ type: "scadParams", params: parseScadParameters(text) });
            },
            () => {
              this.post({ type: "scadParams", params: [] });
            }
          );
        void readScadOverrides(this.doc.path).then((overrides) => {
          this.currentScadOverrides = overrides;
          this.post({ type: "scadOverrides", overrides: this.currentScadOverrides });
        });
      }
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

    if ((msg as { type?: string }).type === "layersChanged") {
      const layersMsg = msg as unknown as { type: "layersChanged"; layers: Layer[]; nextId: number };
      this.currentLayers = layersMsg.layers;
      this.currentLayersNextId = layersMsg.nextId;
      if (this.layersSaveTimer) clearTimeout(this.layersSaveTimer);
      this.layersSaveTimer = setTimeout(() => {
        void writeLayers(doc.path, layersMsg.layers, layersMsg.nextId).then(undefined, (err) =>
          this.post({ type: "error", message: `Could not save layers: ${(err as Error).message}` })
        );
      }, PARTS_SAVE_DEBOUNCE_MS);
      return;
    }

    // cad 3.16.0's OpenSCAD Customizer Apply (provider.ts): validate the form's
    // values against the LIVE source text (unknown names and wrong types are
    // dropped with a warning, the `convert_scad` rule), persist the validated
    // set, and reload the geometry with the values as `-D` overrides. The
    // source file itself is never written. The provider's own warning at the
    // end is load-bearing here too: an override that changes a dimension can
    // renumber edge-N/face-N ids authored against the defaults, and a changed
    // *base* is outside what the entity rebind repairs — so we warn rather than
    // claim verified highlights. KKSS has no source watcher, so there is no
    // sidecar watcher to reconcile either (the same reason `edits.externalFrom`
    // is not ported).
    if (msg.type === "scadApplyOverrides") {
      if (!doc.route || doc.route.format !== "scad") return;
      void (async () => {
        try {
          const text = await fs.readFile(doc.path, "utf8");
          const { defines, warnings } = validateScadOverrides(parseScadParameters(text), msg.overrides);
          this.currentScadOverrides = defines;
          try {
            await writeScadOverrides(doc.path, this.currentScadOverrides);
          } catch (err) {
            this.post({
              type: "error",
              message: `Could not save Customizer overrides: ${(err as Error).message}`,
            });
            return;
          }
          this.post({ type: "scadOverrides", overrides: this.currentScadOverrides });
          for (const w of warnings) this.post({ type: "status", text: w });
          if (this.currentParts.length > 0 || this.currentAnnotations.length > 0) {
            this.post({
              type: "status",
              text: "Customizer overrides changed the base shape — Part and annotation ids may have shifted; check highlights before meshing.",
            });
          }
          this.loadModel(true);
        } catch (err) {
          this.post({
            type: "error",
            message: `Could not apply Customizer overrides: ${(err as Error).message}`,
          });
        }
      })();
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

    if (msg.type === "meshDeviationRequest") {
      const epoch = this.epoch;
      try {
        if (!doc.route) throw new Error("Unsupported file type.");
        const input = await this.resolveMeshInput(msg.stl, "mm");
        if (epoch !== this.epoch) return;
        if (!input) throw new Error("No mesh geometry available: missing STL data.");
        const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options);
        if (epoch !== this.epoch) return;

        let reference: Parameters<typeof cadCompute.measureMeshDeviation>[1];
        const scadWarnings: string[] = [];
        if (doc.route.strategy === "occt") {
          const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
          reference = {
            kind: "brep",
            bytes: src.bytes,
            format: src.format as OcctSourceFormat,
            ops: replayTail(this.currentEdits, this.currentBakedThrough),
          };
        } else if (input.kind === "stl") {
          reference = { kind: "stl", stlBytes: input.stlBytes };
        } else {
          throw new Error("No reference surface available for this source.");
        }
        const result = await cadCompute.measureMeshDeviation(
          this.runtimePath,
          reference,
          input,
          options,
          parts,
          { tolerance: msg.tolerance, perCorner: true }
        );
        if (epoch !== this.epoch) return;
        for (const warning of [...scadWarnings, ...result.warnings]) {
          this.post({ type: "status", text: warning });
        }
        const corners = result.corners;
        if (!corners) throw new Error("The deviation worker returned no per-corner boundary data.");
        let max = msg.tolerance;
        for (const distance of corners.distances) {
          if (Number.isFinite(distance) && distance > max) max = distance;
        }
        this.post({
          type: "meshDeviationResult",
          requestId: msg.requestId,
          report: result.report,
          positions: encodeBuffer(corners.positions),
          distances: encodeBuffer(corners.distances),
          max,
        });
      } catch (err) {
        if (epoch === this.epoch) {
          this.post({ type: "meshDeviationError", requestId: msg.requestId, message: (err as Error).message });
        }
      }
      return;
    }

    if (msg.type === "meshingGenerate") {
      try {
        await runOwnedJob({ ownerId: doc.path, requestId: msg.requestId }, async () => {
        const input = await this.resolveMeshInput(msg.stl);
        if (!input) throw new Error("No mesh geometry available: missing STL data.");
        const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options);
        const startedAt = Date.now();
        this.lastMshText = null;
        const result = await cadCompute.generateMesh(this.runtimePath, input, options, parts);
        this.lastMshText = result.mshText;
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
          // cad 3.26.0: achieved boundary-layer rows per wall Part (2-D B-rep
          // generates only) — the FE Mesh panel appends them to the Part's
          // Layer row and highlights a shortfall.
          ...(result.boundaryLayers ? { boundaryLayers: result.boundaryLayers } : {}),
          // cad 3.30.0: the octree engines report their own facts. The panel
          // renders whichever block is present; forwarding both keeps the
          // "Octree mesh" and "Octree" readouts from silently disappearing.
          ...(result.octree ? { octree: result.octree } : {}),
          ...(result.octreeMesh ? { octreeMesh: result.octreeMesh } : {}),
          // cad 3.31/3.32: the meshcad surface engine's facts, and the hanging-
          // node octree's master/slave line segments for the links toggle.
          meshcad: result.meshcad,
          constraintLinks: result.constraintLinks ? encodeBuffer(result.constraintLinks) : undefined,
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

    if (msg.type === "meshSweepRequest") {
      let outputDir: string | undefined;
      let completedSweep: {
        outcome: MeshSweepOutcome;
        warnings: string[];
        outputDir: string | null;
      } | undefined;
      try {
        const sizes = validateSweepSizes(msg.sizes);
        if (msg.writeOutputs) {
          const picked = await showOpenDialog({
            title: "Choose a folder for sweep meshes",
            openLabel: "Write sweep meshes here",
            canSelectFolders: true,
            defaultPath: path.dirname(doc.path),
          });
          if (!picked?.length) {
            this.post({ type: "meshSweepError", requestId: msg.requestId, message: "No output folder chosen — sweep not run." });
            return;
          }
          outputDir = picked[0];
        }

        await runOwnedJob({ ownerId: doc.path, requestId: msg.requestId }, async () => {
          const isJobCancelled = () => {
            const state = jobStatus(doc.path, msg.requestId)?.state;
            return state === "cancelling" || state === "cancelled";
          };
          const input = await this.resolveMeshInput(msg.stl);
          if (!input) throw new Error("No mesh geometry available: missing STL data.");
          const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options);
          const warnings: string[] = [];
          const baseName = path.basename(doc.path).replace(/\.[^.]+$/, "");
          const outcome = await runCadMeshSweep(
            sizes,
            options,
            (runOptions) => cadCompute.generateMesh(this.runtimePath, input, runOptions, parts),
            {
              warnings,
              isCancelled: isJobCancelled,
              onRunStart: (index, size) => {
                this.post({ type: "status", text: `Sweep: meshing at size ${size} (${index + 1}/${sizes.length})…` });
              },
              writeOutputs: outputDir
                ? async (size, _runOptions, result) => {
                    const target = path.join(outputDir!, sweepOutputName(baseName, size, "msh"));
                    await fs.writeFile(target, Buffer.from(result.mshText, "utf8"));
                    return [target];
                  }
              : undefined,
            }
          );
          completedSweep = { outcome, warnings, outputDir: outputDir ?? null };
        });
        if (completedSweep) {
          this.post({
            type: "meshSweepResult",
            requestId: msg.requestId,
            runs: completedSweep.outcome.runs,
            cancelled: completedSweep.outcome.cancelled,
            warnings: completedSweep.warnings,
            note: SWEEP_NOTE,
            outputDir: completedSweep.outputDir,
          });
        }
      } catch (err) {
        // runOwnedJob marks an owner-cancelled task as rejected after its body
        // returns. A partial sweep is nevertheless a normal result upstream:
        // surface its completed rows instead of replacing them with an error.
        const cancelled = ["cancelling", "cancelled"].includes(
          jobStatus(doc.path, msg.requestId)?.state ?? ""
        );
        if (completedSweep?.outcome.cancelled || cancelled) {
          this.post({
            type: "meshSweepResult",
            requestId: msg.requestId,
            runs: completedSweep?.outcome.runs ?? [],
            cancelled: true,
            warnings: completedSweep?.warnings ?? [],
            note: SWEEP_NOTE,
            outputDir: completedSweep?.outputDir ?? outputDir ?? null,
          });
        } else {
          this.post({ type: "meshSweepError", requestId: msg.requestId, message: (err as Error).message });
        }
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
        } else if ((msg.target === "mdpaElements" || msg.target === "mdpaGeometries") && (options.mdpaRanks ?? 1) >= 2) {
          // cad 3.31.0: one MDPA per MPI rank plus a manifest. The save dialog
          // names the STEM; the files are `<stem>_<rank>.mdpa` beside it, so ask
          // first and mesh only once the user has committed (provider.ts).
          const format = meshExportFormat(msg.target)!;
          const baseName = path.basename(doc.path).replace(/\.[^.]+$/, "");
          const saveDialogPath = await showSaveDialog({
            defaultPath: path.join(path.dirname(doc.path), `${baseName}.${format.extension}`),
            filters: [{ name: `${format.filterLabel} — one file per rank`, extensions: [format.extension] }],
          });
          if (saveDialogPath) {
            const stem = path.basename(saveDialogPath).replace(/\.mdpa$/i, "");
            const split = await cadCompute.exportMdpaPartitioned(
              this.runtimePath,
              input,
              options,
              parts,
              msg.target === "mdpaElements" ? "elements" : "geometries",
              stem
            );
            assertJobActive();
            const dir = path.dirname(saveDialogPath);
            const outputs = [
              ...split.files.map((f) => ({ file: path.join(dir, rankFileName(stem, f.rank)), bytes: Buffer.from(f.text, "utf8") })),
              {
                file: path.join(dir, partitionManifestName(stem)),
                bytes: Buffer.from(partitionManifestJson(split.report, { source: path.basename(doc.path), format: msg.target }), "utf8"),
              },
            ];
            // The dialog only confirmed ONE name; the siblings must not be replaced unasked.
            const existing = outputs.filter((o) => fsSync.existsSync(o.file)).map((o) => path.basename(o.file));
            let go = true;
            if (existing.length > 0) {
              const { response } = await dialog.showMessageBox({
                type: "warning",
                buttons: ["Overwrite", "Cancel"],
                defaultId: 1,
                cancelId: 1,
                message: `${existing.length} existing file${existing.length === 1 ? "" : "s"} would be replaced: ${existing.join(", ")}`,
              });
              go = response === 0;
            }
            if (go) {
              for (const o of outputs) await fs.writeFile(o.file, o.bytes);
              const r = split.report;
              this.post({
                type: "status",
                text: `Exported ${r.ranks} rank files (${rankFileName(stem, 0)} … ${rankFileName(stem, r.ranks - 1)}) and ${partitionManifestName(stem)} — ${r.methodUsed.toUpperCase()}, balance ${r.balanceMaxOverMean.toFixed(3)}, ${r.interfaceNodes} interface nodes (${(r.interfaceFraction * 100).toFixed(1)} %).`,
              });
              for (const w of [...partitionWarnings(r), PARTITION_LAYOUT_NOTE]) this.post({ type: "status", text: w });
              savedPath = saveDialogPath;
            }
          }
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
        // A hanging-node octree's constraints exist only in MDPA: any other
        // format is a non-conforming mesh — say so after the write, never drop
        // them silently (provider.ts).
        const lossFormat = meshExportFormat(msg.target);
        const lossWarning = lossFormat && savedPath ? constraintExportWarning(options, lossFormat) : null;
        if (lossWarning) {
          this.post({ type: "status", text: lossWarning });
          toast("warning", lossWarning);
        }
        // Pre → post sync: a written mesh may be openable in post mode. The
        // router (in index.ts) decides whether this format actually is.
        if (savedPath) this.hooks.onMeshExported(savedPath, doc.path);
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
      // The webview's own File ▸ Save — the same save as the native menu's.
      // A failure is already on the error banner (runSave posts it).
      void this.saveDocument().catch(() => undefined);
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

    if (msg.type === "holeTableRequest") {
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error("Hole tables enumerate analytic B-rep cylinder faces; mesh sources have none.");
        }
        const sourceWarnings: string[] = [];
        const source = await this.readOcctSource(doc.path, doc.route.format, sourceWarnings);
        for (const warning of sourceWarnings) this.post({ type: "status", text: warning });
        const result = await cadCompute.computeHoleTable(
          this.runtimePath,
          source.bytes,
          source.format as Extract<CadFormat, "step" | "iges" | "brep" | "csg">,
          replayTail(this.currentEdits, this.currentBakedThrough)
        );
        this.post({ type: "holeTableResult", requestId: msg.requestId, rows: result.rows, warnings: [...sourceWarnings, ...result.warnings] });
      } catch (err) {
        this.post({ type: "holeTableError", requestId: msg.requestId, message: (err as Error).message });
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
        // cad 3.16.0's clearance (provider.ts's own guard): a distance query
        // beside the intersection, in mm. Refused up front so an unusable value
        // never reaches the kernel as NaN.
        if (msg.minClearance !== undefined && !(Number.isFinite(msg.minClearance) && msg.minClearance >= 0)) {
          throw new Error("Clearance must be a number >= 0 (mm).");
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
          idsB,
          ...(msg.minClearance !== undefined ? [msg.minClearance] : [])
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
        // cad 3.16.0's clearance — same guard as the single-pair handler above.
        if (msg.minClearance !== undefined && !(Number.isFinite(msg.minClearance) && msg.minClearance >= 0)) {
          throw new Error("Clearance must be a number >= 0 (mm).");
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
          // check below holds) and are never reported as clash-free. cad
          // 3.16.0's clearance rides the same options object.
          msg.maxPairs !== undefined || msg.maxBooleans !== undefined || msg.minClearance !== undefined
            ? {
                maxPairs: msg.maxPairs,
                maxBooleans: msg.maxBooleans,
                ...(msg.minClearance !== undefined ? { minClearance: msg.minClearance } : {}),
              }
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

    if (msg.type === "brepHealthRequest") {
      const epoch = this.epoch;
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error("B-rep Health needs a B-rep source; use Mesh Health for a mesh.");
        }
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        const report = await cadCompute.checkBrepHealth(
          this.runtimePath,
          src.bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough)
        );
        if (epoch !== this.epoch) return;
        for (const warning of scadWarnings) this.post({ type: "status", text: warning });
        this.post({ type: "brepHealthResult", requestId: msg.requestId, report });
      } catch (err) {
        if (epoch === this.epoch) {
          this.post({ type: "brepHealthError", requestId: msg.requestId, message: (err as Error).message });
        }
      }
      return;
    }

    if (msg.type === "qualityGateRequest") {
      // cad 3.17.0 FE Mesh quality gate, ported message-for-message from
      // provider.ts: meshio++'s checkQuality over the last generated mesh.
      try {
        if (this.lastMshText === null) throw new Error("Generate a mesh first — the quality gate runs over the last generated mesh.");
        const result = await cadCompute.checkMeshQuality(this.lastMshText, msg.require.trim());
        this.post({ type: "qualityGateResult", requestId: msg.requestId, result });
      } catch (err) {
        this.post({ type: "qualityGateError", requestId: msg.requestId, message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "passagesRequest") {
      const epoch = this.epoch;
      try {
        if (!doc.route || doc.route.strategy !== "occt") {
          throw new Error("Passage analysis needs a B-rep source; a mesh has no analytic cylinders or planes to measure.");
        }
        const scadWarnings: string[] = [];
        const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
        const options = this.currentMeshOptions ?? (await readMeshOptions(doc.path));
        const sizeMax = options.sizeMax >= SIZE_MAX_SENTINEL ? null : options.sizeMax;
        const report = await cadCompute.analyzePassages(
          this.runtimePath,
          src.bytes,
          src.format as OcctSourceFormat,
          replayTail(this.currentEdits, this.currentBakedThrough),
          { targetCells: msg.targetCells, sizeMax, parts: this.currentParts }
        );
        if (epoch !== this.epoch) return;
        for (const warning of scadWarnings) this.post({ type: "status", text: warning });
        this.post({ type: "passagesResult", requestId: msg.requestId, report, sizeMax });
      } catch (err) {
        if (epoch === this.epoch) {
          this.post({ type: "passagesError", requestId: msg.requestId, message: (err as Error).message });
        }
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
        const format = this.requireComparableMesh(
          "a mesh healability check",
          "Mesh healability check requires an STL/OBJ/PLY/glTF source."
        );
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
          const decimated = await cadCompute.coarsenStlBoundary(
            this.runtimePath,
            forHeal.stlBytes,
            AUTO_DECIMATE_TARGET_TRIANGLES
          );
          const report = await cadCompute.checkMeshHealth(this.runtimePath, decimated.bytes, "stl");
          this.post({
            type: "meshHealResult",
            requestId: msg.requestId,
            report: {
              ...report,
              decimated: decimatedInfo(decimated, forHeal.fromTriangles),
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
        const format = this.requireComparableMesh(
          "region fitting",
          "Region fitting requires an STL/OBJ/PLY/glTF source."
        );
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

    // cad 3.11.0 MMG remeshing (provider remeshRequest, message for message).
    // The webview's Mesh ops · Remesh panel ships verbatim in viewer.js, so a
    // missing branch dead-ends its Run button. File mode remeshes the original
    // FE file; generated mode freshly meshes the current edited geometry first.
    // Both always write a NEW .med + Parts sidecar — never the source.
    if (msg.type === "remeshRequest") {
      try {
        const options = validateMmgOptions(msg.options);
        if (msg.source !== "file" && msg.source !== "generated") {
          throw new Error("MMG input must be file or generated");
        }
        const baseName = path.basename(doc.path).replace(/\.[^.]+$/, "");
        const savePath = await showSaveDialog({
          defaultPath: path.join(path.dirname(doc.path), `${baseName}-remeshed.med`),
          filters: [{ name: "MED mesh (named regions)", extensions: ["med"] }],
        });
        if (!savePath) {
          this.post({ type: "remeshResult", requestId: msg.requestId, cancelled: true, warnings: [] });
          return;
        }
        if (path.resolve(savePath) === path.resolve(doc.path)) {
          throw new Error("MMG always writes a new file; choose a path different from the source");
        }
        if (!savePath.toLowerCase().endsWith(".med")) {
          throw new Error("MMG output must be .med to preserve named regions");
        }
        await this.assertRemeshTargetsAbsent(savePath);
        await runOwnedJob({ ownerId: doc.path, requestId: msg.requestId }, async () => {
          const assertJobActive = () => {
            const state = jobStatus(doc.path, msg.requestId)?.state;
            if (state === "cancelling" || state === "cancelled") {
              throw new Error(`CAD job ${msg.requestId} was cancelled.`);
            }
          };
          const warnings: string[] = [];
          let bytes: Uint8Array;
          let format: string;
          let name: string | undefined;
          let companions: MeshioCompanion[] | undefined;
          // cad 3.21.0: adapting to a field reads the source mesh's result
          // fields, so a freshly generated mesh (which carries none) is refused
          // with the submodule's own wording rather than rebuilt fieldless.
          if (options.adaptField && msg.source === "generated") {
            throw new Error(
              "Adapting to a field needs the original FE mesh file — a freshly generated mesh carries no result fields"
            );
          }
          if (msg.source === "generated") {
            const input = await this.resolveMeshInput(msg.stl);
            if (!input) throw new Error("No geometry to generate a mesh from");
            const resolved = await this.resolveMeshPartsAndOptions(input, msg.meshOptions);
            const generated = await cadCompute.generateMesh(this.runtimePath, input, resolved.options, resolved.parts);
            bytes = Buffer.from(generated.mshText, "utf8");
            format = "gmsh";
            warnings.push(...(generated.warnings ?? []));
          } else {
            if (!doc.route || doc.route.strategy !== "meshio" || doc.route.format === "openfoam") {
              throw new Error("File mode requires a meshio-readable triangle/tetra FE mesh");
            }
            bytes = await fs.readFile(doc.path);
            name = path.basename(doc.path);
            format = doc.route.format;
            companions = await this.resolveMeshioCompanions(doc.path, format, bytes);
            if (replayTail(this.currentEdits, this.currentBakedThrough).length) {
              warnings.push(
                "File mode remeshes the original FE mesh; display edits are not baked in. Use generated mode for edited geometry."
              );
            }
          }
          const result = await cadCompute.remeshMesh(this.runtimePath, bytes, format, options, name, companions);
          const boundary = await cadCompute.convertToStlBoundaryWithRegions(result.bytes, "med");
          const built = boundary.regions
            ? await cadCompute.buildPartsFromMeshioRegions(boundary.stlBytes, boundary.regions)
            : [];
          const rebound = remeshedParts(built, this.currentParts, result.regionNames);
          assertJobActive();
          // Remeshing can take minutes. Recheck after it, so a file created
          // while the worker ran is not mistaken for our unused save path.
          await this.assertRemeshTargetsAbsent(savePath);
          await fs.writeFile(savePath, result.bytes);
          await writeParts(savePath, rebound.parts);
          this.post({
            type: "remeshResult",
            requestId: msg.requestId,
            report: result.report,
            adapt: "adapt" in result ? result.adapt : undefined,
            written: savePath,
            warnings: [...warnings, ...result.warnings, ...rebound.warnings],
          });
        });
      } catch (err) {
        this.post({ type: "remeshError", requestId: msg.requestId, message: (err as Error).message });
      } finally {
        this.post({ type: "meshingJobSettled", requestId: msg.requestId });
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
      await this.handlePromoteToBrep(msg.mergeFacets === true);
      return;
    }

    if (msg.type === "repairMeshButtonClicked") {
      await this.handleRepairMesh();
      return;
    }

    if (msg.type === "fitMeshToCadButtonClicked") {
      await this.handleFitMeshToCad();
      return;
    }

    if (msg.type === "surfaceToolRequest") {
      if (doc.route) void this.handleSurfaceTool(doc.path, doc.route, msg);
      return;
    }

    if (msg.type === "draftRequest") {
      // cad 3.28.0's Draft panel, ported message-for-message from provider.ts:
      // facts-only draft/undercut analysis over the welded triangles any source
      // reduces to, plus the per-corner draft overlay the view colours by.
      const epoch = this.epoch;
      try {
        if (!doc.route) throw new Error("Unsupported file type.");
        let source: Parameters<typeof cadCompute.checkDraft>[1];
        const scadWarnings: string[] = [];
        if (doc.route.strategy === "occt") {
          const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
          source = {
            kind: "brep",
            bytes: src.bytes,
            format: src.format as OcctSourceFormat,
            ops: replayTail(this.currentEdits, this.currentBakedThrough),
          };
        } else {
          if (DISPLAY_ONLY_MESH_FORMATS.has(doc.route.format)) {
            throw new Error(displayOnlyMeshMessage(doc.route.format, "a draft check"));
          }
          // The webview serialises the DISPLAYED (edited) mesh, so pending mesh
          // edits are already in it.
          if (!msg.stl) throw new Error("No mesh geometry available: missing STL data.");
          source = { kind: "stl", bytes: Buffer.from(msg.stl, "base64") };
        }
        const result = await cadCompute.checkDraft(this.runtimePath, source, {
          pull: msg.pull as Axis,
          minDraftDeg: msg.minDraftDeg,
          twoSided: msg.twoSided,
          overlay: true,
        });
        if (epoch !== this.epoch) return;
        for (const warning of scadWarnings) this.post({ type: "status", text: warning });
        this.post({
          type: "draftResult",
          requestId: msg.requestId,
          report: result.report,
          positions: encodeBuffer(result.overlay!.positions),
          values: encodeBuffer(result.overlay!.values),
        });
      } catch (err) {
        if (epoch === this.epoch) {
          this.post({ type: "draftError", requestId: msg.requestId, message: (err as Error).message });
        }
      }
      return;
    }

    if (msg.type === "printabilityRequest") {
      // cad 3.18.0's Printability panel, ported message-for-message from
      // provider.ts: a facts-only report over the welded triangles any source
      // reduces to, plus the overhang overlay for `up`. The bundled starter
      // limits are read tolerantly — a broken bundle degrades to "no
      // starters", never an error.
      const epoch = this.epoch;
      try {
        if (!doc.route) throw new Error("Unsupported file type.");
        let source: Parameters<typeof cadCompute.checkPrintability>[1];
        const scadWarnings: string[] = [];
        if (doc.route.strategy === "occt") {
          const src = await this.readOcctSource(doc.path, doc.route.format, scadWarnings);
          source = {
            kind: "brep",
            bytes: src.bytes,
            format: src.format as OcctSourceFormat,
            ops: replayTail(this.currentEdits, this.currentBakedThrough),
          };
        } else {
          if (DISPLAY_ONLY_MESH_FORMATS.has(doc.route.format)) {
            throw new Error(displayOnlyMeshMessage(doc.route.format, "a printability check"));
          }
          // The webview serialises the DISPLAYED (edited) mesh, so pending mesh
          // edits are already in it.
          if (!msg.stl) throw new Error("No mesh geometry available: missing STL data.");
          source = { kind: "stl", bytes: Buffer.from(msg.stl, "base64") };
        }
        const library = await readBundledProcessLimits(this.runtimePath);
        const result = await cadCompute.checkPrintability(this.runtimePath, source, {
          overhangLimitDeg: msg.overhangLimitDeg,
          process: resolveProcess(msg.process, library),
          plate: resolvePlate(msg.plate, library),
          overlayUp: msg.up,
        });
        if (epoch !== this.epoch) return;
        for (const warning of scadWarnings) this.post({ type: "status", text: warning });
        this.post({
          type: "printabilityResult",
          requestId: msg.requestId,
          report: result.report,
          up: msg.up,
          positions: encodeBuffer(result.overlay!.positions),
          values: encodeBuffer(result.overlay!.values),
        });
      } catch (err) {
        if (epoch === this.epoch) {
          this.post({ type: "printabilityError", requestId: msg.requestId, message: (err as Error).message });
        }
      }
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
   * so everything downstream only ever
   * sees step/iges/brep/csg. Conversion runs host-side with `cwd` at the
   * source's own directory — that is what keeps a multi-file model's relative
   * `use`/`include`/`import` working, and why this cannot move into the compute
   * worker (which only ever receives marshalled bytes).
   *
   * cad 3.26.0 is WASM-first: the bundled OpenSCAD WASM port evaluates the
   * source inside the compute worker (`convertScadViaWasm`, Manifold backend
   * by default) with no install needed, and the user-installed binary is only
   * the fallback for constructs the WASM path declines (a ScadWasmFallbackError
   * — import()/surface(), a missing include, the staging caps — whose class
   * name survives the worker hop, see cadCompute.worker.ts). Any other WASM
   * failure surfaces instead of retrying the binary. A missing binary then
   * throws `ScadUnavailableError`, whose message IS the
   * install hint, so every caller's existing catch already reports it properly.
   *
   * cad 3.16.0 also replays the persisted Customizer overrides here (the
   * provider's own readOcctSource): a `.scad` source converts with its
   * `<model>.scad-params.json` defines, so opening, every edit's
   * re-tessellation, BOM/hole-table/clash/health/measure, meshing and export
   * all see the applied values. Read from disk rather than from a session field
   * so this stays stateless like every other caller — the Apply handler awaits
   * the sidecar write before reloading, so a read here sees the new values.
   */
  private async readOcctSource(
    fsPath: string,
    format: CadFormat,
    warnings: string[]
  ): Promise<{ bytes: Uint8Array; format: CadFormat }> {
    // cad 3.12.0: backend + library paths ride alongside the binary (the
    // provider spreads readScadSettings() here). Unset backend means "auto"
    // (no flag, OpenSCAD default + OPENSCAD_BACKEND fallback); an empty
    // library list means no OPENSCADPATH prepend.
    const libraryPaths = stateStore.get<string[]>(CAD_DEFAULT_KEYS.openscadLibraryPaths);
    // Unknown names and wrong types are dropped with a warning (the
    // `convert_scad` rule); out-of-range values apply with a note, because
    // OpenSCAD itself does not clamp.
    let defines: Record<string, ScadValue> | undefined;
    if (format === "scad") {
      try {
        const [sourceText, stored] = await Promise.all([
          fs.readFile(fsPath, "utf8").catch(() => ""),
          readScadOverrides(fsPath),
        ]);
        if (sourceText !== "" && Object.keys(stored).length > 0) {
          const { defines: validated, warnings: overrideWarnings } = validateScadOverrides(
            parseScadParameters(sourceText),
            stored
          );
          defines = validated;
          warnings.push(...overrideWarnings);
        }
      } catch {
        // A failed sidecar/source read degrades to the authored defaults — the
        // conversion itself still runs, never blocked by the overrides.
      }
    }
    return resolveEffectiveSource({
      modelPath: fsPath,
      format,
      readBytes: async () => fs.readFile(fsPath),
      warnings,
      binary: stateStore.get<string>(CAD_DEFAULT_KEYS.openscadBinary) || undefined,
      backend: stateStore.get<string>(CAD_DEFAULT_KEYS.openscadBackend) || undefined,
      libraryPaths: Array.isArray(libraryPaths) ? libraryPaths : undefined,
      ...(defines && Object.keys(defines).length > 0 ? { defines } : {}),
      // cad 3.26.0 WASM-first: the worker evaluates .scad with the bundled
      // build; the binary above is only the fallback for declined constructs.
      // extensionPath is this tab's WASM home (out/cad-runtime), the same root
      // getScadWasmBinary reads dist/openscad-core.wasm from.
      wasm: {
        extensionPath: this.runtimePath,
        convertScadViaWasm: (extensionPath, modelPath, opts) =>
          cadCompute.convertScadViaWasm(extensionPath, modelPath, opts),
      },
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
   * The mesh-source gate for an operation the kernel needs triangles for
   * (cad 3.16.0). `.3mf` and `.dae` route here too, but cad classifies them as
   * display-only: three's loaders live in the webview and the host has no
   * triangle parser for them, so the provider refuses them *by name* through
   * cad's own `displayOnlyMeshMessage` builder (one accurate sentence that says
   * to export to STL/OBJ/PLY/glTF first) instead of the generic "requires an
   * STL/OBJ/PLY/glTF source". `what` is the operation, in the provider's own
   * phrasing; `fallback` is the message for every other non-three route.
   */
  private requireComparableMesh(what: string, fallback: string): MeshParseFormat {
    const route = this.doc?.route;
    if (!route || route.strategy !== "three") throw new Error(fallback);
    if (!COMPARABLE_MESH_FORMATS.has(route.format)) {
      throw new Error(displayOnlyMeshMessage(route.format, what));
    }
    return route.format as MeshParseFormat;
  }

  /**
   * A `.gltf` references its vertex data from sibling `.bin` files, so those
   * have to be read and handed alongside the document's own bytes (the
   * provider's `resolveGltfBuffersFor`). Returns undefined for every other
   * format, and skips a buffer that cannot be read — the parser reports the
   * gap far better than a failed open would.
   *
   * cad 3.14.0: a Draco/meshopt-compressed file additionally gets its decoded
   * geometry via the kernel worker (WASM decoders never run here) into the
   * reserved `decoded:` entries the synchronous parser consumes.
   */
  private async gltfBuffers(
    format: MeshParseFormat,
    bytes: Uint8Array
  ): Promise<GltfExternalBuffers | undefined> {
    if (!this.doc || format !== "gltf") return undefined;
    const dir = path.dirname(this.doc.path);
    return resolveExternalBuffers(
      bytes,
      async (relative) => {
        try {
          return new Uint8Array(await fs.readFile(path.join(dir, relative)));
        } catch {
          return undefined;
        }
      },
      (raw, external) => cadCompute.decodeGltfGeometry(this.runtimePath, raw, external)
    );
  }

  private async handleBRep(
    modelPath: string,
    format: Extract<CadFormat, "step" | "iges" | "brep" | "csg" | "scad">,
    ops: EditOp[],
    autoFit = true
  ): Promise<CsgColorGroup[] | undefined> {
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
      const { groups, edges, points, tree, opOutcomes, opBuckets, guideIds, queryWarnings, warnings, assemblyPending, csgColors } =
        await cadCompute.loadBRepCachedInWorker(
          this.sessionId,
          this.runtimePath,
          bytes,
          effectiveFormat,
          ops,
          tessellationParamsFor(quality),
          // cad 3.14.0's deferred STEP assembly read crashes the kernel (SIGSEGV)
          // on the reload after a second File > Save, so the read is synchronous
          // until that is fixed upstream. The `assemblyPending` upgrade below
          // stays wired and is dormant while this is false.
          { deferAssemblyTree: false }
        );
      if (epoch !== this.epoch) return; // document changed while tessellating
      // A frozen operand query replays on its cached ids — the user has to know
      // the query was not honored rather than staring at unchanged geometry.
      // `.csg` parse/build skips (a dropped hull(), a faceted-cylinder
      // approximation) ride the same channel and must never be silent.
      for (const w of queryWarnings ?? []) this.post({ type: "status", text: w });
      for (const w of warnings ?? []) this.post({ type: "status", text: w });
      for (const w of scadWarnings) this.post({ type: "status", text: w });
      // The kernel replayed only the unbaked tail, so its op indices are
      // tail-relative — re-base them onto full-history rows (provider.handleBRep).
      const rebased = rebaseOpOutcomes(
        opOutcomes,
        opBuckets,
        this.currentBakedThrough,
        this.currentEdits.slice(0, this.currentBakedThrough).map((o) => o.op)
      );
      this.post({
        type: "geometry",
        autoFit,
        opOutcomes: rebased.opOutcomes,
        guideIds,
        opBuckets: rebased.opBuckets,
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
      // cad 3.14.0 "Post geometry before the XCAF assembly tree": the kernel
      // deferred the STEP assembly read so the geometry above went out first.
      // Upgrade the flat tree in a second message once it finishes. Non-fatal
      // by design — any failure or supersede leaves the flat tree (exactly
      // what a failed correlation shows today). Generation-guarded via epoch,
      // the provider's genHolder.current equivalent.
      if (assemblyPending) {
        void cadCompute
          .resolveAssemblyTreeForDocument(this.sessionId, this.runtimePath)
          .then((nested) => {
            if (nested && epoch === this.epoch) {
              this.post({ type: "tree", root: nested, sourceUnit, upgrade: true });
            }
          })
          .catch(() => {
            /* flat tree stays */
          });
      }
      // `.csg`/`.scad` colour groups for the BASE shape (undefined for every
      // other source): the caller decides whether they become Parts —
      // provider.handleBRep's return value, which loadModel chains into
      // autoCreateCsgColorParts.
      return csgColors;
    } catch (err) {
      if (epoch !== this.epoch) return undefined; // superseded — the catch posts nothing
      this.post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
      return undefined;
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
      // cad 3.31.0: a Kratos deck with multi-point constraints (hanging nodes)
      // opens with the constraint blocks stripped; read them back from the
      // original bytes to draw the links, and take the coarse/fine interface
      // out of the displayed boundary (provider.handleMeshio).
      let stlBytes = boundary.stlBytes;
      let regions = boundary.regions;
      let constraintLinks: ReturnType<typeof parseMdpaConstraintLinks>;
      let interfaceNote: string | undefined;
      if (format === "mdpa") {
        constraintLinks = parseMdpaConstraintLinks(new TextDecoder().decode(bytes));
        if (constraintLinks && constraintLinks.interfaceQuads.length > 0) {
          const dropped = dropInterfaceFacets(new TextDecoder().decode(stlBytes), constraintLinks.interfaceQuads);
          if (dropped.declined) {
            interfaceNote = "the model is too large to take the hanging-node interfaces out of the displayed surface — they are drawn as internal walls";
          } else if (dropped.dropped > 0) {
            stlBytes = new TextEncoder().encode(dropped.stl);
            if (regions) {
              const region = regions.triangleRegion.filter((_, i) => dropped.keep[i]);
              regions = { regionNames: regions.regionNames, triangleRegion: Int32Array.from(region) };
            }
          }
        }
      }
      let parts = existingParts;
      if (regions && existingParts.length === 0) {
        const built = await cadCompute.buildPartsFromMeshioRegions(stlBytes, regions);
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
        dataBase64: Buffer.from(stlBytes).toString("base64"),
        meshioMetadata: hasMetadata ? metadata : undefined,
        regionAssignment: regions
          ? {
              regionNames: regions.regionNames,
              triangleRegionIndex: encodeBuffer(regions.triangleRegion),
            }
          : undefined,
        meshConstraints: constraintLinks
          ? {
              points: encodeBuffer(constraintLinks.points),
              indices: encodeBuffer(constraintLinks.indices),
              constraintCount: constraintLinks.constraintCount,
              slaveCount: constraintLinks.slaveCount,
              variables: constraintLinks.variables,
              truncated: constraintLinks.truncated,
              summary: [
                mdpaConstraintSummary(constraintLinks),
                ...constraintLinks.notes,
                ...(interfaceNote ? [interfaceNote] : []),
              ].join(" · "),
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
    if (!doc.route) return undefined;
    const warnings: string[] = [];
    const input = await resolveCadMeshInput(doc.path, doc.route,
      replayTail(this.currentEdits, this.currentBakedThrough), stl, unit, cadCompute, warnings);
    for (const text of warnings) this.post({ type: "status", text });
    return input;
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
      const [source, parts, layers, annotations, edits, meshOptions, scadOverrides] = await Promise.all([
        fs.readFile(modelPath),
        readOptional(CAD_SIDECAR.parts),
        readOptional(CAD_SIDECAR.layers),
        readOptional(CAD_SIDECAR.annotations),
        readOptional(CAD_SIDECAR.edits),
        readOptional(CAD_SIDECAR.meshOptions),
        // cad 3.16.0: the Customizer's defines travel with the archive, so a
        // restored `.scad` opens with the same geometry rather than reverting to
        // the authored defaults.
        readOptional(CAD_SIDECAR.scadOverrides),
      ]);
      const zipBytes = buildPreprocessZip({
        sourceName,
        source,
        parts,
        layers,
        annotations,
        edits,
        meshOptions,
        scadOverrides,
      });
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
      if ((contents as { layers?: string }).layers !== undefined) {
        const parsedLayers = parseLayersFile((contents as { layers: string }).layers);
        await writeLayers(destPath, parsedLayers.layers, parsedLayers.nextId);
      }
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
      // cad 3.16.0: rehydrate the Customizer defines, parsed through the
      // sidecar's own validator so a hand-edited archive cannot inject a
      // non-ScadValue or an unknown parameter name.
      if (contents.scadOverrides !== undefined) {
        await writeScadOverrides(destPath, parseScadOverridesJson(contents.scadOverrides));
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
   * Layer-filter pick for drawing exports (provider.pickLayersFilter, cad
   * f53c7ed). `undefined` = draw everything (no filter); `null` = refused —
   * the caller returns without exporting. Mesh sources refuse an explicit
   * filter choice; B-rep sources resolve names through `resolveLayerDrawFilter`.
   */
  private async pickLayersFilter(route: FileRoute): Promise<LayerDrawSubset[] | undefined | null> {
    const full = layersWithDefault(this.currentLayers);
    const hasMembers = full.some((l) => l.volumes.length + l.surfaces.length + l.lines.length + l.points.length > 0);
    if (full.length <= 1 && !hasMembers) return undefined;
    type Choice = { label: string; description?: string; pick: "all" | "visible" | string };
    const choices: Choice[] = [
      { label: "All layers", description: "draw every layer", pick: "all" },
      { label: "Visible layers only", description: "draw each currently-visible layer", pick: "visible" },
      ...full.map((l): Choice => ({ label: l.name, description: l.id, pick: l.id })),
    ];
    const picked = await showQuickPick(choices, { placeHolder: "Drawing layers…" });
    if (!picked || picked.pick === "all") return undefined;
    const names = picked.pick === "visible" ? full.filter((l) => l.visible).map((l) => l.id) : [picked.pick];
    if (route.strategy !== "occt") {
      this.post({ type: "error", message: "The layers filter in drawing exports is B-rep only in this version — mesh sources draw unfiltered." });
      return null;
    }
    const { subsets, warnings } = resolveLayerDrawFilter(full, names);
    for (const w of warnings) this.post({ type: "status", text: w });
    if (subsets.length === 0) {
      this.post({ type: "error", message: "None of the picked layers matched — the drawing would be empty." });
      return null;
    }
    return subsets;
  }
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
        message:
          route.strategy === "three"
            ? displayOnlyMeshMessage(route.format, `a ${format.toUpperCase()} silhouette export`)
            : `Silhouette ${format.toUpperCase()} export requires a STEP/IGES/BREP/CSG/SCAD or STL/OBJ/PLY/glTF source.`,
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
    const layerFilter = await this.pickLayersFilter(route);
    if (layerFilter === null) return;
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
          ...(layerFilter ? { layerFilter } : {}),
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
        message:
          route.strategy === "three"
            ? displayOnlyMeshMessage(route.format, "a drawing sheet export")
            : "Drawing sheet export requires a STEP/IGES/BREP/CSG/SCAD or STL/OBJ/PLY/glTF source.",
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
    // Drawing sheets resolve the layer filter from the sheet form's layer
    // checkboxes upstream; KKSS's sheet flow has no such form, so offer the
    // same All/Visible/Named pick as the silhouette path.
    const sheetLayerFilter = await this.pickLayersFilter(route);
    if (sheetLayerFilter === null) return;
    // cad 3.28.0's hole callouts need the B-rep's cylindrical faces, so the
    // quick-pick is B-rep only (mesh sources keep the plain sheet path).
    const holePick =
      route.strategy === "occt"
        ? await showQuickPick(
            [
              { label: "No hole callouts", description: "draw the sheet without centre marks", holeCallouts: false },
              { label: "Hole callouts", description: "centre marks and Ø callouts for cylindrical holes", holeCallouts: true },
            ],
            { placeHolder: "Hole callouts…" }
          )
        : undefined;
    if (route.strategy === "occt" && !holePick) return;
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
          ...(sheetLayerFilter ? { layerFilter: sheetLayerFilter } : {}),
          ...(holePick?.holeCallouts ? { holeCallouts: true } : {}),
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
  private async handlePromoteToBrep(mergeFacets = false): Promise<void> {
    const doc = this.doc;
    if (!doc?.route) return;
    if (!COMPARABLE_MESH_FORMATS.has(doc.route.format)) {
      this.post({
        type: "error",
        message:
          doc.route.strategy === "three"
            ? displayOnlyMeshMessage(doc.route.format, "Promote to B-rep")
            : "Promote to B-rep requires an STL/OBJ/PLY/glTF source.",
      });
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
        // The options argument is only passed when merging, so a plain promote
        // is byte-identical to before (cad 3.24.0 provider.ts parity).
        const result = mergeFacets
          ? await cadCompute.promoteMeshToBrep(
              this.runtimePath,
              bytes,
              meshFormat,
              picked.format,
              unit,
              await this.gltfBuffers(meshFormat, bytes),
              { mergeFacets: validateMergeFacets(true) }
            )
          : await cadCompute.promoteMeshToBrep(
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
    if (!COMPARABLE_MESH_FORMATS.has(doc.route.format)) {
      this.post({
        type: "error",
        message:
          doc.route.strategy === "three"
            ? displayOnlyMeshMessage(doc.route.format, "Repair (robust)")
            : "Repair (robust) requires an STL/OBJ/PLY/glTF source.",
      });
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
   * Surface Tools panel (cad 3.32.0, meshio++ 17.23): `project_to_cad` and
   * `grow_prism_layers` over the OPEN document's STEP/IGES source, ported
   * message-for-message from provider.handleSurfaceTool. The host owns the
   * dialogs (project: the mesh to snap, then a save path; prism: a save path);
   * the compute worker does the work on raw bytes, so pending edits are NOT
   * baked (the panel says so). Neither the CAD source nor the picked mesh is
   * ever written. Replies `surfaceToolResult` or `surfaceToolError`.
   */
  private async handleSurfaceTool(
    modelPath: string,
    route: FileRoute,
    msg: Extract<WebviewToHost, { type: "surfaceToolRequest" }>
  ): Promise<void> {
    const epoch = this.epoch;
    const fail = (message: string, cancelled = false): void => {
      if (epoch !== this.epoch) return;
      this.post({ type: "surfaceToolError", requestId: msg.requestId, tool: msg.tool, message, cancelled });
    };
    if (route.format !== "step" && route.format !== "iges") {
      fail("Surface tools need a STEP or IGES source (they read its exact NURBS faces).");
      return;
    }
    const baseName = path.basename(modelPath).replace(/\.[^.]+$/, "");
    try {
      const cadBytes = await fs.readFile(modelPath);
      const sig = (n: number): string => (Number.isFinite(n) ? Number(n.toPrecision(4)).toString() : "n/a");
      if (msg.tool === "projectToCad") {
        const picked = await showOpenDialog({
          openLabel: "Project this mesh",
          title: "Mesh to snap onto this model (must carry cad:face — a mesh_cad_surface .msh / .vtk / .vtu)",
          filters: [{ name: "Surface mesh", extensions: ["msh", "vtk", "vtu"] }],
          defaultPath: path.dirname(modelPath),
        });
        if (!picked?.length) return fail("Cancelled.", true);
        const meshPath = picked[0];
        const meshRoute = routeFile(meshPath);
        if (!meshRoute || meshRoute.strategy !== "meshio") return fail("That file is not a meshio++-readable surface mesh.");
        const savePath = await showSaveDialog({
          defaultPath: path.join(path.dirname(modelPath), `${baseName}-projected.vtu`),
          filters: [{ name: "Surface mesh", extensions: ["vtu", "vtk", "msh"] }],
        });
        if (!savePath) return fail("Cancelled.", true);
        if (savePath === modelPath || savePath === meshPath) return fail("Choose a new file — neither input is overwritten.");
        const ext = path.extname(savePath).toLowerCase();
        const meshBytes = await fs.readFile(meshPath);
        const options = msg.maxDistance > 0 ? { maxDistance: msg.maxDistance } : {};
        const result = await cadCompute.projectMeshToCad(meshBytes, meshRoute.format, cadBytes, route.format, ext, options);
        await fs.writeFile(savePath, result.outputBytes);
        const r = result.report;
        if (epoch !== this.epoch) return;
        this.post({
          type: "surfaceToolResult",
          requestId: msg.requestId,
          tool: "projectToCad",
          written: savePath,
          rows: [
            ["Projected", String(r.numProjected)],
            ["On edges", `${r.numOnEdges} (${r.numOnCurves} on curves, ${r.numCorners} corners)`],
            ["Too far / failed", `${r.numTooFar} / ${r.numFailed}`],
            ["Outside trim", String(r.numOutsideTrim)],
            ["Max move", `${sig(r.maxMove)} mm`],
          ],
          warnings: r.warnings,
        });
        return;
      }
      const savePath = await showSaveDialog({
        defaultPath: path.join(path.dirname(modelPath), `${baseName}-layers.vtu`),
        filters: [{ name: "Layered mesh", extensions: ["vtu", "vtk", "msh"] }],
      });
      if (!savePath) return fail("Cancelled.", true);
      if (savePath === modelPath) return fail("Choose a new file — the CAD source is never overwritten.");
      const ext = path.extname(savePath).toLowerCase();
      const result = await cadCompute.growPrismLayersModel(
        { kind: "cad", bytes: cadBytes, meshioFormat: route.format, targetSize: msg.targetSize },
        ext,
        { firstHeight: msg.firstHeight, numLayers: msg.numLayers, growth: msg.growth, reverse: msg.reverse || undefined }
      );
      await fs.writeFile(savePath, result.outputBytes);
      const r = result.report;
      if (epoch !== this.epoch) return;
      this.post({
        type: "surfaceToolResult",
        requestId: msg.requestId,
        tool: "prismLayers",
        written: savePath,
        rows: [
          ["Wedges", `${r.numWedges} over ${result.numSurfaceTriangles} surface triangles`],
          ["Shrunk / collapsed", `${r.numShrunk} / ${r.numCollapsed}`],
          ["Thickness", `${sig(r.minThickness)}–${sig(r.maxThickness)} mm of ${sig(r.plannedThickness)} planned`],
          ["Min scaled Jacobian", sig(r.minScaledJacobian)],
          ["Cap closed", r.capClosed ? "yes" : "no"],
        ],
        warnings: r.warnings,
      });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  /**
   * cad 3.19.0's Fit to CAD (meshio++'s `fitCad`) — the *analytic* counterpart
   * of `handlePromoteToBrep`: promotion SEWS the triangles into a B-rep, this
   * REPLACES them with exact faces (planes/spheres/cylinders/cones/tori,
   * fillets/blends/chamfers/threads, freeform B-splines where nothing else
   * fits). Same one-shot-export shape (the source keeps its mesh identity) and
   * the same `COMPARABLE_MESH_FORMATS` gate; it additionally needs a closed,
   * CONSISTENTLY WOUND skin and the full artifact's OpenCASCADE (a mesh that
   * fails to close throws upstream's own error, naming the open edges — the
   * Mesh Health report already showed them). Deliberately always a STEP and no
   * format/unit quick-picks: `fitCad` writes AP214 and takes the mesh's own
   * coordinates as-is, so there is nothing to choose. Unlike
   * `promptSaveAndWrite`'s generic "Exported to …" status, the final message
   * carries the fit's own report — `valid` in particular is the one thing the
   * user must not lose, since an invalid solid is still written and must be
   * stated as such (provider.handleFitMeshToCad, message-for-message).
   */
  private async handleFitMeshToCad(): Promise<void> {
    const doc = this.doc;
    if (!doc?.route) return;
    if (!COMPARABLE_MESH_FORMATS.has(doc.route.format)) {
      this.post({
        type: "error",
        message:
          doc.route.strategy === "three"
            ? displayOnlyMeshMessage(doc.route.format, "Fit to CAD")
            : "Fit to CAD requires an STL/OBJ/PLY/glTF source.",
      });
      return;
    }
    const meshFormat = doc.route.format as MeshParseFormat;

    const baseName = path.basename(doc.path).replace(/\.[^.]+$/, "");
    const savePath = await showSaveDialog({
      defaultPath: path.join(path.dirname(doc.path), `${baseName}.step`),
      filters: [{ name: "STEP", extensions: ["step"] }],
    });
    if (!savePath) return;

    try {
      const sourceBytes = await fs.readFile(doc.path);
      const result = await cadCompute.fitMeshToCad(
        sourceBytes,
        meshFormat,
        {},
        await this.gltfBuffers(meshFormat, sourceBytes)
      );
      await fs.writeFile(savePath, result.stepBytes);

      const r = result.report;
      const summary =
        `${r.numFaces} faces (${r.numPlane} plane, ${r.numCylinder} cylinder, ${r.numSphere} sphere, ` +
        `${r.numCone} cone, ${r.numTorus} torus), volume ratio ${r.volumeRatio === null ? "n/a" : r.volumeRatio.toFixed(4)}, ` +
        `max deviation ${r.maxDeviation.toExponential(2)}`;
      if (r.valid) {
        this.post({ type: "status", text: `Fitted to CAD: ${summary} — saved to ${savePath}` });
      } else {
        this.post({
          type: "error",
          message: `The fitted solid failed OpenCASCADE's B-rep check (${summary}) — written to ${savePath}, but inspect it before relying on it.`,
        });
      }
    } catch (err) {
      this.post({ type: "error", message: `Fit to CAD failed: ${(err as Error).message}` });
    }
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

  /**
   * MMG remesh's unused-path guard (provider remeshRequest): the output .med
   * AND its Parts sidecar must both be absent — checked before the worker runs
   * and again after, since remeshing can take minutes. A present file is never
   * overwritten; the user picks another name.
   */
  private async assertRemeshTargetsAbsent(savePath: string): Promise<void> {
    for (const target of [savePath, `${savePath}.parts.json`]) {
      try {
        await fs.stat(target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      throw new Error(`MMG always writes new files; choose an unused output path. Already exists: ${target}`);
    }
  }

  /**
   * Sibling files a meshio++ reader may need (XDMF's .h5, TetGen/Triangle/
   * EnSight/GiD stem siblings) — the node:fs twin of provider
   * resolveMeshioCompanionsFor. Missing siblings read as absent; any other
   * read failure propagates.
   */
  private async resolveMeshioCompanions(
    modelPath: string,
    format: string,
    bytes: Uint8Array
  ): Promise<MeshioCompanion[]> {
    const base = path.basename(modelPath);
    const primaryText = format === "xdmf" ? Buffer.from(bytes).toString("utf8") : undefined;
    const names = meshioCompanionCandidates(base, format, primaryText);
    const dir = path.dirname(modelPath);
    const resolved = await Promise.all(
      names.map(async (name): Promise<MeshioCompanion | undefined> => {
        try {
          return { name, bytes: new Uint8Array(await fs.readFile(path.join(dir, name))) };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw err;
        }
      })
    );
    return resolved.filter((c): c is MeshioCompanion => c !== undefined);
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
