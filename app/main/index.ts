/** KKSS Electron main entry. */
import { app, clipboard, dialog, ipcMain, Menu } from "electron";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { registerSchemes, installProtocolHandlers } from "./protocol";
import { createMainWindow, MainWindow, DEFAULT_ZOOM, ZOOM_PRESETS } from "./windows";
import { CadHost } from "./cadHost";
import { MeshHost } from "./mesh/meshHost";
import { FlowgraphController } from "../../mesh/src/flowgraphController";
import { installMenu } from "./menu";
import { modeForFile, modeForViewType } from "./router";
import { configurePicker } from "./services/quickPick";
import { configureAbout, showAbout } from "./services/about";
import { configureWhatsNew, checkForNewVersion } from "./services/whatsNew";
import { TerminalService } from "./services/terminal";
import { EditorService } from "./services/editor";
import { ChatService } from "./services/chat/chatService";
import { McpHub } from "./services/chat/mcpHub";
import { getSecret, setSecret } from "./services/chat/secrets";
import { MetaMcpServer, META_SERVER_KEYS, DEFAULT_META_SERVER_PORT } from "./services/metaServer/metaServer";
import { configureNotifications, handleToastButton, toast } from "./services/notifications";
import { stateStore } from "./services/stateStore";
import { __configureVscodeShim } from "./vscodeShim";
import { openMesh } from "../../mesh/src/meshExport";
import type { HomeToHost, Mode, Screen, ShellTabInfo, ShellToHost } from "./ipc";

// Must happen before app is ready.
registerSchemes();

let main: MainWindow | null = null;
/** One CadHost/MeshHost per open tab, keyed by that tab's id (windows.ts's Tab.id). */
const cadHosts = new Map<string, CadHost>();
const meshHosts = new Map<string, MeshHost>();
/** Shared, ref-counted across every open mesh tab — see meshHost.ts's header. */
let flowgraph: FlowgraphController | null = null;
let terminal: TerminalService | null = null;
let editor: EditorService | null = null;
let chat: ChatService | null = null;
let mcpHub: McpHub | null = null;
let metaServer: MetaMcpServer | null = null;

/** A file path passed on the command line (also used by the e2e smoke test). */
function cliFileArg(): string | undefined {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  return args.find((a) => !a.startsWith("-") && a !== "." && fsSync.existsSync(a) && fsSync.statSync(a).isFile());
}

function sendShell(message: unknown): void {
  main?.shell.webContents.send("shell:toWebview", message);
}

/** Persisted interface-scale (shared across launches). */
const UI_ZOOM_KEY = "uiZoom";

/** Applies an interface scale, persists it, and reflects it back to the shell picker. */
function setUiZoom(factor: number): void {
  if (!main) return;
  const applied = main.setZoom(factor);
  void stateStore.update(UI_ZOOM_KEY, applied);
  sendShell({ type: "zoom", factor: applied });
}

/** Steps to the adjacent zoom preset (dir +1 = larger, -1 = smaller). */
function stepUiZoom(dir: number): void {
  if (!main) return;
  const presets = ZOOM_PRESETS as readonly number[];
  // Nearest current preset, so stepping is stable even after a clamp.
  let i = 0;
  for (let k = 1; k < presets.length; k++) {
    if (Math.abs(presets[k] - main.zoom()) < Math.abs(presets[i] - main.zoom())) i = k;
  }
  const next = Math.min(presets.length - 1, Math.max(0, i + dir));
  setUiZoom(presets[next]);
}

/** The CadHost/MeshHost backing whichever tab is currently focused for `mode`. */
function activeCadHost(): CadHost | undefined {
  const id = main?.activeTabId("cad");
  return id ? cadHosts.get(id) : undefined;
}
function activeMeshHost(): MeshHost | undefined {
  const id = main?.activeTabId("mesh");
  return id ? meshHosts.get(id) : undefined;
}

/** Resyncs one mode's whole tab strip to the shell (open/close/focus/title). */
function syncTabs(mode: Mode): void {
  if (!main) return;
  const hosts = mode === "cad" ? cadHosts : meshHosts;
  const tabs: ShellTabInfo[] = main.tabs(mode).map((t) => {
    const file = hosts.get(t.id)?.currentFile;
    return { id: t.id, fileName: file ? path.basename(file) : null };
  });
  sendShell({ type: "tabs", mode, tabs, activeTabId: main.activeTabId(mode) });
}

// Shared across every tab of a mode — none of these close over a specific
// tab, so one object per mode is enough (see createTab()).
const cadHostHooks = {
  onOpenRequest: (fsPath: string) => openFile(fsPath),
  onTitle: () => syncTabs("cad"),
  // Pre → post sync: a mesh exported from CAD that post mode can display
  // (.mdpa, .vtk, …) opens in a NEW mesh tab — never silently replacing
  // whatever the user currently has focused there. The router gates this so
  // shared formats (.stl/.obj/.ply) and CAD-only outputs never jump.
  onMeshExported: (fsPath: string) => {
    if (!main || modeForFile(fsPath, main.mode()) !== "mesh") return;
    const tab = createTab("mesh");
    meshHosts.get(tab.id)?.openPath(path.resolve(fsPath));
    setScreen("mesh");
  },
};
const meshHostHooks = { onTitle: () => syncTabs("mesh") };

/** Creates a new (focused) tab for `mode`: its WebContentsView + Host. */
function createTab(mode: Mode) {
  if (!main) throw new Error("main window not ready");
  const tab = main.openTab(mode);
  if (mode === "cad") {
    cadHosts.set(tab.id, new CadHost(tab.view, path.join(__dirname, "cad-runtime"), cadHostHooks, tab.id));
  } else {
    if (!flowgraph) flowgraph = new FlowgraphController();
    meshHosts.set(tab.id, new MeshHost(tab.view, __dirname, meshHostHooks, flowgraph));
  }
  // Pipe webview console output through main for headless debugging/e2e.
  tab.view.webContents.on("console-message", (details) => {
    if (process.env.KKSS_E2E || details.level === "error" || details.level === "warning") {
      console.log(`[${mode}:console:${details.level}] ${details.message}`);
    }
  });
  main.setActiveTab(mode, tab.id);
  syncTabs(mode);
  return tab;
}

/** The focused tab's id for `mode`, creating a fresh (blank) tab if none is open. */
function ensureActiveTab(mode: Mode): string {
  const existing = main?.activeTabId(mode);
  return existing ?? createTab(mode).id;
}

/** File ▸ New [Mode] Tab / the tab strip's "+" button. */
function newTab(mode: Mode): void {
  createTab(mode);
  setScreen(mode);
}

/** ✕ on a tab. No dirty-prompt — cad/mesh sidecars autosave, same as any
 *  other document replace/close in this app (see CLAUDE.md's tabs invariant). */
function closeTab(mode: Mode, tabId: string): void {
  if (!main) return;
  const hosts = mode === "cad" ? cadHosts : meshHosts;
  hosts.get(tabId)?.dispose();
  hosts.delete(tabId);
  main.closeTab(mode, tabId);
  if (!main.activeTabId(mode)) {
    const remaining = main.tabs(mode);
    const sibling = remaining[remaining.length - 1];
    if (sibling) main.setActiveTab(mode, sibling.id);
  }
  syncTabs(mode);
}

/** Clicking a tab in the strip. */
function selectTab(mode: Mode, tabId: string): void {
  if (!main) return;
  main.setActiveTab(mode, tabId);
  syncTabs(mode);
}

/** Opens a file in the mode the router picks (active mode wins on overlap),
 *  replacing the focused tab's document — "+ New Tab" is the explicit way to
 *  open a second document instead. */
function openFile(fsPath: string, forcedMode?: Mode): void {
  if (!main) return;
  const resolved = path.resolve(fsPath);
  const mode = forcedMode ?? modeForFile(resolved, main.mode());
  if (!mode) {
    sendShell({ type: "toast", id: Date.now(), kind: "warning", text: `Unsupported file type: ${path.basename(resolved)}` });
    return;
  }
  const tabId = ensureActiveTab(mode);
  const host = mode === "cad" ? cadHosts.get(tabId) : meshHosts.get(tabId);
  host?.openPath(resolved);
  setScreen(mode);
}

/** Switches screens and keeps the shell's active-screen highlight in sync.
 *  Entering a mode screen guarantees it has at least one tab (creating a
 *  blank one if the user closed all of them), so the mode's viewer is never
 *  left literally empty. */
function setScreen(screen: Screen): void {
  if (!main) return;
  if (screen === "cad" || screen === "mesh") ensureActiveTab(screen);
  main.setScreen(screen);
  sendShell({ type: "screen", screen });
}

/** Shows/hides the shared terminal panel, attaching the pty session on first use. */
function toggleTerminal(): void {
  if (!main || !terminal) return;
  const { view } = main.toggleTerminal();
  terminal.attach(view.webContents);
}

/** Shows/hides the AI chat sidebar, attaching the chat service on first use. */
function toggleChat(): void {
  if (!main || !chat) return;
  const { view, visible } = main.toggleChat();
  chat.attach(view.webContents);
  if (visible) chat.ensureStarted();
}

/** Configured meta-server port (falls back to the default on an invalid value). */
function metaServerPort(): number {
  const value = Number(stateStore.get(META_SERVER_KEYS.port, DEFAULT_META_SERVER_PORT));
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_META_SERVER_PORT;
}

/** Returns the stored bearer token, generating and persisting one on first use. */
async function ensureMetaServerToken(): Promise<string> {
  let token = getSecret(META_SERVER_KEYS.token);
  if (!token) {
    token = randomUUID();
    await setSecret(META_SERVER_KEYS.token, token);
  }
  return token;
}

/** Persists the opt-in and starts/stops the listener (surfaces bind errors). */
async function setMetaServerEnabled(enabled: boolean): Promise<void> {
  if (!metaServer) return;
  await stateStore.update(META_SERVER_KEYS.enabled, enabled);
  if (!enabled) {
    await metaServer.disable();
    return;
  }
  await ensureMetaServerToken();
  try {
    await metaServer.enable();
    toast("info", `MCP server listening on ${metaServer.address()}`);
  } catch (error) {
    await stateStore.update(META_SERVER_KEYS.enabled, false);
    toast("error", `MCP server failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Copies the endpoint URL + bearer token for pasting into an external MCP client. */
async function copyMetaServerConfig(): Promise<void> {
  const token = await ensureMetaServerToken();
  const url = metaServer?.address() ?? `http://127.0.0.1:${metaServerPort()}/mcp`;
  clipboard.writeText(`${url}\nAuthorization: Bearer ${token}`);
  await dialog.showMessageBox({
    type: "info",
    title: "MCP Server Address Copied",
    message: "Endpoint + bearer token copied to the clipboard.",
    detail:
      `URL: ${url}\nHeader: Authorization: Bearer ${token}\n\n` +
      "These tools read and write files on disk and can run simulations. Only share this " +
      "address and token with a client you trust.",
  });
}

/** Rotates the bearer token, restarting the listener if it is running. */
async function regenerateMetaServerToken(): Promise<void> {
  await setSecret(META_SERVER_KEYS.token, randomUUID());
  if (metaServer?.isRunning()) {
    await metaServer.disable();
    await metaServer.enable();
  }
  toast("info", "MCP server token regenerated — update any connected clients.");
}

/** Settings live in the native menu bar — pop its submenu up (home + chat). */
function openSettingsMenu(): void {
  if (!main) return;
  const settings = Menu.getApplicationMenu()?.items.find((i) => i.label === "&Settings");
  settings?.submenu?.popup({ window: main.win });
}

app.whenReady().then(() => {
  installProtocolHandlers(__dirname);
  configurePicker(__dirname);
  configureAbout(__dirname);
  configureWhatsNew(__dirname);
  main = createMainWindow(__dirname, stateStore.get<number>(UI_ZOOM_KEY, DEFAULT_ZOOM) ?? DEFAULT_ZOOM);
  configureNotifications(sendShell);
  __configureVscodeShim({
    openWith: (fsPath, viewType) => openFile(fsPath, modeForViewType(viewType)),
    openTextDocument: (fsPath) => void editor?.openPath(fsPath),
  });

  for (const mode of ["cad", "mesh"] as Mode[]) {
    ipcMain.on(`${mode}:initialState`, (event) => {
      event.returnValue = { mode, theme: stateStore.get("sceneTheme", "auto") };
    });
  }

  // One starter tab per mode, mirroring the pre-tabs behavior of both mode
  // views existing (and loading their bundle) from app launch.
  createTab("cad");
  createTab("mesh");

  editor = new EditorService({
    webContents: () => main!.editor.webContents,
    getWindow: () => main!.win,
    showEditor: () => setScreen("editor"),
    onTitle: (fileName, dirty) => sendShell({ type: "title", view: "editor", fileName, dirty }),
  });

  // Closing the window is the one destructive path for an unsaved buffer —
  // screen switches only hide the editor view, so they need no guard.
  main.win.on("close", (event) => {
    if (!editor?.isDirty()) return;
    event.preventDefault();
    void editor.confirmClose();
  });

  terminal = new TerminalService(
    () => {
      const current = (main?.mode() === "cad" ? activeCadHost() : activeMeshHost())?.currentFile;
      return current ? path.dirname(current) : undefined;
    },
    () => {
      if (main?.terminalVisible()) toggleTerminal();
    }
  );

  // One McpManager owner, shared by the chat loop and the HTTP meta server, so
  // the three MCP child servers are spawned once (whichever front-end starts first).
  mcpHub = new McpHub(__dirname);

  metaServer = new MetaMcpServer({
    hub: mcpHub,
    version: app.getVersion(),
    port: metaServerPort,
    token: () => getSecret(META_SERVER_KEYS.token),
  });

  chat = new ChatService({
    hub: mcpHub,
    currentFiles: () => ({
      cad: [...cadHosts.values()].map((h) => h.currentFile).filter((f): f is string => !!f),
      mesh: [...meshHosts.values()].map((h) => h.currentFile).filter((f): f is string => !!f),
      activeCad: activeCadHost()?.currentFile,
      activeMesh: activeMeshHost()?.currentFile,
    }),
    openSettings: openSettingsMenu,
    onHide: () => {
      if (main?.chatVisible()) toggleChat();
    },
  });

  installMenu({
    main,
    activeCadHost,
    activeMeshHost,
    editor,
    setScreen,
    newTab,
    closeTab,
    toggleTerminal,
    toggleChat,
    zoom: {
      stepIn: () => stepUiZoom(1),
      stepOut: () => stepUiZoom(-1),
      reset: () => setUiZoom(DEFAULT_ZOOM),
    },
    metaServer: {
      enabled: () => stateStore.get(META_SERVER_KEYS.enabled, false) ?? false,
      setEnabled: (enabled) => void setMetaServerEnabled(enabled),
      copyConfig: () => void copyMetaServerConfig(),
      regenerateToken: () => void regenerateMetaServerToken(),
    },
  });

  // Honor the persisted opt-in on startup.
  if (stateStore.get(META_SERVER_KEYS.enabled, false)) void setMetaServerEnabled(true);

  ipcMain.on("home:toHost", (_event, raw) => {
    const msg = raw as HomeToHost;
    if (!main || msg.type !== "action") return;
    switch (msg.action) {
      case "preprocessing":
        setScreen("cad");
        break;
      case "postprocessing":
        setScreen("mesh");
        break;
      case "editor":
        void editor?.open();
        break;
      case "settings":
        openSettingsMenu();
        break;
      case "help":
        showAbout();
        break;
    }
  });

  ipcMain.on("shell:toHost", (_event, raw) => {
    const msg = raw as ShellToHost;
    if (!main) return;
    switch (msg.type) {
      case "shellReady":
        // The shell page may finish loading after a CLI file-open already ran
        // (or after a reload) — replay the current screen + tab strips + zoom.
        sendShell({ type: "screen", screen: main.screen() });
        syncTabs("cad");
        syncTabs("mesh");
        sendShell({ type: "zoom", factor: main.zoom() });
        break;
      case "setMode":
        setScreen(msg.mode);
        break;
      case "goHome":
        setScreen("home");
        break;
      case "toggleTerminal":
        toggleTerminal();
        break;
      case "toggleChat":
        toggleChat();
        break;
      case "editCurrentFile": {
        const host = main.mode() === "cad" ? activeCadHost() : activeMeshHost();
        if (host?.currentFile) void editor?.openPath(host.currentFile);
        else toast("warning", "No file open in the current mode — use Open… first.");
        break;
      }
      case "openFile": {
        if (main.mode() === "cad") {
          const tabId = ensureActiveTab("cad");
          void cadHosts.get(tabId)?.openFileDialog();
        } else {
          void openMesh(); // mesh/src/meshExport openMesh → dialog → openWith hook
        }
        break;
      }
      case "setZoom":
        setUiZoom(msg.factor);
        break;
      case "toastButton":
        handleToastButton(msg.id, msg.button);
        break;
      case "newTab":
        newTab(msg.mode);
        break;
      case "closeTab":
        closeTab(msg.mode, msg.tabId);
        break;
      case "selectTab":
        selectTab(msg.mode, msg.tabId);
        break;
    }
  });

  // Shows the "What's New" changelog once per version bump (silent on a fresh
  // install and under the e2e smoke test — see services/whatsNew.ts).
  checkForNewVersion();

  const fileArg = cliFileArg();
  if (fileArg) {
    // Give the views a beat to finish their first load; openPath reloads anyway.
    setTimeout(() => openFile(fileArg), 300);
  }
});

// Single teardown for the shared MCP manager + the HTTP meta server + the
// Flowgraph child process (the chat service only aborts its in-flight turn).
app.on("will-quit", () => {
  void metaServer?.dispose();
  void mcpHub?.dispose();
  flowgraph?.dispose();
});

app.on("window-all-closed", () => {
  app.quit();
});
