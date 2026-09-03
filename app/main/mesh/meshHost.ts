/**
 * Mesh mode host — reuses the submodule's MdpaEditorProvider and
 * VtkEditorProvider classes UNMODIFIED. Their `vscode` import is satisfied by
 * app/main/vscodeShim.ts (esbuild alias); this file supplies the remaining two
 * fakes they touch: an ExtensionContext (globalState → stateStore) and a
 * WebviewPanel wrapping our WebContentsView + IPC channel.
 *
 * MMG wiring mirrors mesh/src/extension.ts activate(): worker runner +
 * wasmBinary handed to the loader (mmgWorker.js/mmg-core.wasm sit next to
 * out/main.js — the __dirname contract in mmgWorkerClient.ts).
 *
 * The Flowgraph problemtype's shared FlowgraphController (also mirroring
 * extension.ts activate()) forks flowgraphServer.js — it too sits next to
 * out/main.js, alongside the flowgraph/ asset tree it serves (see
 * flowgraphController.ts's __dirname-relative lookups). It is ref-counted and
 * genuinely shared across every open mesh tab (each tab = one MeshHost, one
 * MdpaEditorProvider), constructed once by index.ts and injected here rather
 * than one-per-instance — and is torn down on will-quit so the child process
 * doesn't outlive the app.
 *
 * mesh 3.8.0's RunManager follows the exact same ownership rule (its own header
 * says so): a solve outlives the tab that started it, so it is constructed once
 * by index.ts, injected into every MeshHost, and disposed on will-quit. It is
 * the one thing here that needs `context.workspaceState`, which is why the fake
 * ExtensionContext below has two mementos rather than one.
 */
import { ipcMain, WebContentsView } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscodeTypes from "vscode";
import { MdpaEditorProvider } from "../../../mesh/src/mdpaEditorProvider";
import { VtkEditorProvider } from "../../../mesh/src/vtkEditorProvider";
import { FlowgraphController } from "../../../mesh/src/flowgraphController";
import type { RunManager } from "../../../mesh/src/runManager";
import type { MenuMessage } from "../../../mesh/src/meshExport";
import { configureMmg } from "../../../mesh/src/parser/remesh";
import { configureMmgRunner } from "../../../mesh/src/parser/operations";
import { runMmgInWorker } from "../../../mesh/src/mmgWorkerClient";
import { Uri } from "../vscodeShim";
import { stateStore } from "../services/stateStore";

/**
 * The fake ExtensionContext the submodule's host-side classes take. Exported
 * because index.ts needs one to construct the shared RunManager before any
 * MeshHost exists; both mementos delegate to the same stateStore, so building
 * it more than once is inert.
 */
export function createMeshExtensionContext(outDir: string): vscodeTypes.ExtensionContext {
  return {
    extensionUri: Uri.file(outDir),
    extensionPath: outDir,
    globalState: {
      get: <T>(key: string, defaultValue?: T) => stateStore.get(key, defaultValue),
      update: (key: string, value: unknown) => stateStore.update(key, value),
    },
    // RunManager keeps its run-sidecar index here. KKSS opens files rather than
    // folders, so it has no per-workspace scope to separate this from
    // globalState — both resolve to the same stateStore, namespaced so a
    // workspace key can never collide with a global one.
    workspaceState: {
      get: <T>(key: string, defaultValue?: T) => stateStore.get(`workspace.${key}`, defaultValue),
      update: (key: string, value: unknown) => stateStore.update(`workspace.${key}`, value),
    },
    subscriptions: [],
  } as unknown as vscodeTypes.ExtensionContext;
}

const DUMMY_TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscodeTypes.CancellationToken;

type MessageHandler = (msg: unknown) => void;

/** Fake vscode.WebviewPanel over our WebContentsView + mesh:* IPC channel. */
class FakeWebviewPanel {
  readonly active = true;
  readonly visible = true;
  /**
   * KKSS has one visible view per mode, so there is no editor column to name.
   * vtkEditorProvider.revealLatestFrame() reads this and calls reveal(); the
   * tab is already on screen whenever it is the focused one, so revealing is
   * the app-level "focus this tab", handled by the host below.
   */
  readonly viewColumn = 1;
  private revealCb: (() => void) | undefined;
  private disposeCbs: Array<() => void> = [];
  private handler: MessageHandler | undefined;
  private buffered: unknown[] = [];

  readonly webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri: (uri: unknown) => unknown;
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (cb: MessageHandler) => { dispose(): void };
  };

  constructor(private readonly view: WebContentsView) {
    const panel = this;
    this.webview = {
      options: {},
      // The provider assigns its getHtml() output here; our page is already
      // loaded (build-time generated with the same markup), so it's inert.
      html: "",
      cspSource: "kkss:",
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => {
        if (process.env.KKSS_E2E) {
          const t = (message as { type?: string })?.type;
          console.log(`[mesh] host → webview: ${t}`);
        }
        panel.view.webContents.send("mesh:toWebview", message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: MessageHandler) => {
        panel.handler = cb;
        const pending = panel.buffered;
        panel.buffered = [];
        for (const msg of pending) cb(msg);
        return {
          dispose() {
            if (panel.handler === cb) panel.handler = undefined;
          },
        };
      },
    };
  }

  /** Route an inbound webview message to the provider's subscription. */
  deliver(msg: unknown): void {
    if (this.handler) this.handler(msg);
    else this.buffered.push(msg);
  }

  /** Set by MeshHost so a provider-initiated reveal focuses this tab. */
  onReveal(cb: () => void): void {
    this.revealCb = cb;
  }

  reveal(_viewColumn?: unknown, _preserveFocus?: boolean): void {
    this.revealCb?.();
  }

  onDidChangeViewState(_cb: unknown): { dispose(): void } {
    // Single always-active panel per mode; view-state never changes.
    return { dispose() {} };
  }

  onDidDispose(cb: () => void): { dispose(): void } {
    this.disposeCbs.push(cb);
    return { dispose() {} };
  }

  dispose(): void {
    const cbs = this.disposeCbs;
    this.disposeCbs = [];
    for (const cb of cbs) cb();
  }
}

export interface MeshHostHooks {
  onTitle(fileName: string | null): void;
  /** Bring this tab to the front (a provider called WebviewPanel.reveal()). */
  onReveal(): void;
}

export class MeshHost {
  private readonly mdpaProvider: MdpaEditorProvider;
  private readonly vtkProvider: VtkEditorProvider;
  private currentPanel: FakeWebviewPanel | undefined;
  private currentPath: string | undefined;
  private pendingOpen: string | undefined;

  constructor(
    private readonly view: WebContentsView,
    outDir: string,
    private readonly hooks: MeshHostHooks,
    /** Shared, ref-counted across every open mesh tab — see the file header. */
    flowgraph: FlowgraphController,
    /** Shared across every open mesh tab — a run outlives its tab. */
    runs: RunManager
  ) {
    // MMG wiring, mirroring mesh/src/extension.ts activate().
    configureMmgRunner(runMmgInWorker);
    try {
      configureMmg({ wasmBinary: fs.readFileSync(path.join(outDir, "mmg-core.wasm")) });
    } catch {
      /* dev layout without the copied wasm */
    }

    const context = createMeshExtensionContext(outDir);

    this.mdpaProvider = new MdpaEditorProvider(context, flowgraph, runs);
    this.vtkProvider = new VtkEditorProvider(context);

    ipcMain.on("mesh:toHost", (event, msg: { type?: string }) => {
      if (event.sender !== view.webContents) return;
      if (process.env.KKSS_E2E) console.log(`[mesh] webview → host: ${msg?.type}`);
      this.dispatch(msg);
    });
  }

  /** Tab closed — disposes this tab's panel/provider state. The shared
   *  FlowgraphController and the WebContentsView are the caller's to tear
   *  down (index.ts / windows.ts's closeTab). */
  dispose(): void {
    this.currentPanel?.dispose();
    this.currentPanel = undefined;
  }

  get currentFile(): string | undefined {
    return this.currentPath;
  }

  private dispatch(msg: { type?: string }): void {
    if (msg?.type === "ready" && this.pendingOpen) {
      // Fresh page load for a newly opened document: resolve the provider
      // now (it subscribes onDidReceiveMessage), then deliver "ready" so its
      // parse/discover flow starts — same order as resolveCustomEditor.
      const fsPath = this.pendingOpen;
      this.pendingOpen = undefined;
      this.resolveProviderFor(fsPath);
    }
    if (this.currentPanel) {
      this.currentPanel.deliver(msg);
    } else if (msg?.type === "ready") {
      this.view.webContents.send("mesh:toWebview", {
        type: "error",
        message: "No file open — use Open… in the toolbar or File ▸ Open.",
      });
    }
  }

  /** Opens `fsPath` in the mesh view (replaces any current document). */
  openPath(fsPath: string): void {
    this.currentPanel?.dispose(); // fires the provider's onDidDispose cleanup
    this.currentPanel = undefined;
    this.currentPath = fsPath;
    this.pendingOpen = fsPath;
    this.hooks.onTitle(path.basename(fsPath));
    this.view.webContents.reload();
  }

  /** Routes a File-menu / palette action to the active provider (extension.ts dispatchMenu). */
  dispatchMenu(msg: MenuMessage): boolean {
    return this.mdpaProvider.dispatchMenu(msg) || this.vtkProvider.dispatchMenu(msg);
  }

  /** File ▸ Reload from disk (mesh 3.2.0's kratos.mesh.reload / Ctrl+Alt+R). */
  dispatchReload(): boolean {
    return this.mdpaProvider.dispatchReload() || this.vtkProvider.dispatchReload();
  }

  /**
   * Routes a Problemtype case action to the mdpa provider (extension.ts's
   * `dispatchCase`, backing kratos.case.generate/run/stop/openResults). Not
   * `postToActive` — these are host-side actions, not webview messages.
   */
  dispatchCase(action: Parameters<MdpaEditorProvider["dispatchCase"]>[0]): boolean {
    return this.mdpaProvider.dispatchCase(action);
  }

  /** Paths this tab's VTK provider currently has open (extension.ts openPanelPaths). */
  openPanelPaths(): string[] {
    return this.vtkProvider.openPanelPaths();
  }

  /**
   * mesh 3.8.0's "kratos.vtk.openLatestResults": if this tab already shows a
   * file from `caseDir`, jump it to the latest complete step rather than
   * opening a duplicate. Returns false when this tab is not the right one.
   */
  revealLatestFrame(fsPath: string): boolean {
    return this.vtkProvider.revealLatestFrame(fsPath);
  }

  /** Posts a panel-level command message to the active preview (extension.ts postToActive). */
  postToActive(message: unknown): void {
    this.mdpaProvider.postToActive(message);
    this.vtkProvider.postToActive(message);
  }

  private resolveProviderFor(fsPath: string): void {
    const panel = new FakeWebviewPanel(this.view);
    panel.onReveal(() => this.hooks.onReveal());
    this.currentPanel = panel;
    const isMdpa = path.extname(fsPath).toLowerCase() === ".mdpa";
    const provider = isMdpa ? this.mdpaProvider : this.vtkProvider;
    const document = { uri: Uri.file(fsPath), dispose() {} };
    provider.resolveCustomEditor(
      document as never,
      panel as unknown as vscodeTypes.WebviewPanel,
      DUMMY_TOKEN
    );
  }
}
