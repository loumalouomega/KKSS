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
 */
import { ipcMain, WebContentsView } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscodeTypes from "vscode";
import { MdpaEditorProvider } from "../../../mesh/src/mdpaEditorProvider";
import { VtkEditorProvider } from "../../../mesh/src/vtkEditorProvider";
import type { MenuMessage } from "../../../mesh/src/meshExport";
import { configureMmg } from "../../../mesh/src/parser/remesh";
import { configureMmgRunner } from "../../../mesh/src/parser/operations";
import { runMmgInWorker } from "../../../mesh/src/mmgWorkerClient";
import { Uri } from "../vscodeShim";
import { stateStore } from "../services/stateStore";

const DUMMY_TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose() {} }),
} as unknown as vscodeTypes.CancellationToken;

type MessageHandler = (msg: unknown) => void;

/** Fake vscode.WebviewPanel over our WebContentsView + mesh:* IPC channel. */
class FakeWebviewPanel {
  readonly active = true;
  readonly visible = true;
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
    private readonly hooks: MeshHostHooks
  ) {
    // MMG wiring, mirroring mesh/src/extension.ts activate().
    configureMmgRunner(runMmgInWorker);
    try {
      configureMmg({ wasmBinary: fs.readFileSync(path.join(outDir, "mmg-core.wasm")) });
    } catch {
      /* dev layout without the copied wasm */
    }

    const context = {
      extensionUri: Uri.file(outDir),
      extensionPath: outDir,
      globalState: {
        get: <T>(key: string, defaultValue?: T) => stateStore.get(key, defaultValue),
        update: (key: string, value: unknown) => stateStore.update(key, value),
      },
      subscriptions: [],
    } as unknown as vscodeTypes.ExtensionContext;

    this.mdpaProvider = new MdpaEditorProvider(context);
    this.vtkProvider = new VtkEditorProvider(context);

    ipcMain.on("mesh:toHost", (event, msg: { type?: string }) => {
      if (event.sender !== view.webContents) return;
      if (process.env.KKSS_E2E) console.log(`[mesh] webview → host: ${msg?.type}`);
      this.dispatch(msg);
    });
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

  /** Posts a panel-level command message to the active preview (extension.ts postToActive). */
  postToActive(message: unknown): void {
    this.mdpaProvider.postToActive(message);
    this.vtkProvider.postToActive(message);
  }

  private resolveProviderFor(fsPath: string): void {
    const panel = new FakeWebviewPanel(this.view);
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
