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
import { exportTargetsFor, EXPORT_EXTENSION, EXPORT_LABEL } from "../../cad/src/exportTargets";
import { parsePartsJson, serializePartsJson } from "../../cad/src/partsSidecar";
import { parseEditsJson, serializeEditsJson, type ParsedEdits } from "../../cad/src/editsSidecar";
import { parseMeshJson, serializeMeshJson, generateGeoScript } from "../../cad/src/meshOptionsSidecar";
import { DEFAULT_MESH_OPTIONS, applyStlPartSizeOverride, type MeshOptions } from "../../cad/src/meshOptions";
import { meshExportFormat } from "../../cad/src/meshExportFormats";
import type { EditOp } from "../../cad/src/editOps";
import type { ParamVariable } from "../../cad/src/editVariables";
import type { MeshGenerationInput } from "../../cad/src/gmshService";
import { cadCompute } from "./cadComputeClient";
import { toKkssUrl, allowRoot } from "./protocol";
import { showOpenDialog, showSaveDialog } from "./services/dialogs";
import { showQuickPick } from "./services/quickPick";

/** Debounce window for autosaving the parts/edits/mesh-options sidecars (provider.ts). */
const PARTS_SAVE_DEBOUNCE_MS = 500;

const BREP_FORMATS: ReadonlySet<CadFormat> = new Set(["step", "iges", "brep"]);
const CAD_OPEN_FILTER = {
  name: "CAD / Mesh",
  extensions: ["stl", "obj", "ply", "gltf", "glb", "step", "stp", "iges", "igs", "brep"],
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
  private currentEdits: EditOp[] = [];
  private currentVariables: ParamVariable[] = [];
  private currentParts: Part[] = [];
  private currentMeshOptions: MeshOptions | undefined;
  /** Guards stale async completions after the document changes. */
  private epoch = 0;

  constructor(
    private readonly view: WebContentsView,
    /** out/cad-runtime — the dist/-shaped WASM home the cad services expect. */
    private readonly runtimePath: string,
    private readonly hooks: CadHostHooks
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
    try {
      await Promise.all([
        writeParts(this.doc.path, this.currentParts),
        writeEdits(this.doc.path, this.currentEdits, this.currentVariables),
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

  private disposeSession(): void {
    this.epoch++;
    if (this.partsSaveTimer) clearTimeout(this.partsSaveTimer);
    if (this.editsSaveTimer) clearTimeout(this.editsSaveTimer);
    if (this.meshSaveTimer) clearTimeout(this.meshSaveTimer);
    this.partsSaveTimer = this.editsSaveTimer = this.meshSaveTimer = undefined;
    for (const p of this.pending.values()) p.reject(new Error("Document closed"));
    this.pending.clear();
    this.currentEdits = [];
    this.currentVariables = [];
    this.currentParts = [];
    this.currentMeshOptions = undefined;
  }

  /** (Re)tessellates a B-rep source with the current edits, or (re)loads a mesh. */
  private loadModel(): void {
    if (!this.doc?.route) return;
    if (this.doc.route.strategy === "three") {
      this.post({ type: "loadUrl", url: toKkssUrl(this.doc.path), format: this.doc.route.format });
    } else {
      void this.handleBRep(
        this.doc.path,
        this.doc.route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        this.currentEdits
      );
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
      void this.sendParts();
      void this.sendMeshOptions();
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
      if (doc.route && doc.route.strategy === "occt") this.loadModel();
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
        });
      } catch (err) {
        this.post({ type: "meshingError", message: (err as Error).message });
      }
      return;
    }

    if (msg.type === "meshingExport") {
      try {
        const input = await this.resolveMeshInput(msg.stl);
        if (!input) {
          this.post({ type: "meshingError", message: "No mesh geometry available: missing STL data." });
          return;
        }
        const { parts, options } = await this.resolveMeshPartsAndOptions(input, msg.options);
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

    if (msg.type === "saveSidecars") {
      void this.flushSidecars();
      return;
    }

    if (msg.type === "exportRequest") {
      if (doc.route) void this.handleExport(doc.path, doc.route);
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
      const { groups, edges, points, tree } = await cadCompute.loadBRep(this.runtimePath, bytes, format, ops);
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
        })),
        points: points.map((p) => ({
          position: encodeBuffer(new Float32Array(p.position)),
          pointId: p.pointId,
        })),
      });
      this.post({ type: "tree", root: tree });
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.post({ type: "error", message: `${format.toUpperCase()} error: ${(err as Error).message}` });
    }
  }

  private async sendParts(): Promise<void> {
    if (!this.doc) return;
    try {
      this.post({ type: "parts", parts: await readParts(this.doc.path) });
    } catch {
      this.post({ type: "parts", parts: [] });
    }
  }

  private async sendMeshOptions(): Promise<void> {
    if (!this.doc) return;
    this.post({ type: "meshingOptions", options: await readMeshOptions(this.doc.path) });
  }

  /** See provider.resolveMeshInput — B-rep re-exports to STEP so edits are baked. */
  private async resolveMeshInput(stl: string | undefined): Promise<MeshGenerationInput | undefined> {
    const doc = this.doc!;
    if (doc.route && doc.route.strategy === "occt") {
      const sourceBytes = await fs.readFile(doc.path);
      const stepBytes = await cadCompute.exportBRep(
        this.runtimePath,
        sourceBytes,
        doc.route.format as Extract<CadFormat, "step" | "iges" | "brep">,
        "step",
        this.currentEdits
      );
      return { kind: "brep", stepBytes };
    }
    if (!stl) return undefined;
    return { kind: "stl", stlBytes: Buffer.from(stl, "base64") };
  }

  /** See provider.resolveMeshPartsAndOptions. */
  private async resolveMeshPartsAndOptions(
    input: MeshGenerationInput,
    options: MeshOptions
  ): Promise<{ parts: Part[]; options: MeshOptions }> {
    const parts = await readParts(this.doc!.path);
    if (input.kind === "brep") return { parts, options };
    return { parts: [], options: applyStlPartSizeOverride(options, parts) };
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
            this.currentEdits
          );
        }
        // Mesh targets are serialized in the webview (it holds the Three.js
        // model) and relayed back via exportResult/exportError.
        const requestId = `${Date.now()}-${Math.random()}`;
        const result = await new Promise<{ data: string; binary: boolean }>((resolve, reject) => {
          this.pending.set(requestId, { resolve, reject });
          this.post({ type: "exportMesh", requestId, format: targetFormat });
        });
        return result.binary ? Buffer.from(result.data, "base64") : Buffer.from(result.data, "utf8");
      }
    );
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
