/** KKSS Electron main entry. */
import { app, clipboard, dialog, ipcMain, Menu } from "electron";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { registerSchemes, installProtocolHandlers } from "./protocol";
import { createMainWindow, MainWindow, DEFAULT_ZOOM, ZOOM_PRESETS, ViewCrash } from "./windows";
import { CadHost } from "./cadHost";
import { MeshHost, createMeshExtensionContext } from "./mesh/meshHost";
import { FlowgraphController } from "../../mesh/src/flowgraphController";
import { RunManager } from "../../mesh/src/runManager";
import { RecentMeshStore } from "../../mesh/src/recentMeshes";
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
import { latestResultFile } from "../../mesh/src/problemtype/runCore";
import { groupVtkFiles, findGroupForFile } from "../../mesh/src/parser/vtkFileGroup";
import { TIMELINE_EXTENSIONS } from "../../mesh/src/parser/meshFormats";
import type { HomeToHost, Mode, Screen, ShellTabInfo, ShellToHost } from "./ipc";

// Must happen before app is ready.
registerSchemes();

/**
 * Single-instance lock. A second launch must hand its file to the running app
 * and exit, never become a second app: two instances share one
 * userData/state.json, and because that store rewrites the file whole, the
 * loser's first settings write would silently discard everything the winner
 * had changed — including the safeStorage-encrypted API key and the MCP
 * meta-server's bearer token, which live in that same file.
 *
 * KKSS_ALLOW_MULTIPLE_INSTANCES=1 opts out. tools/e2eShared.mjs sets it because
 * the e2e harness relaunches the app many times in a row and SIGKILLs the
 * process tree between runs (a wedged GPU child must not survive); a lock left
 * behind by one of those kills would make every later launch quit on startup
 * and turn both `npm run smoke` and `npm run docs:screenshots` permanently red.
 * It is also the escape hatch for a developer who keeps KKSS open while running
 * them, since both share ~/.config/kkss.
 */
const gotInstanceLock =
  process.env.KKSS_ALLOW_MULTIPLE_INSTANCES === "1" || app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  // Lands in the e2e harness's captured output, so this failure diagnoses itself.
  console.error("KKSS is already running — handing the file argument to that instance.");
  app.quit();
}

/** A file to open once the window exists — a CLI argument, or a macOS
 *  `open-file` that arrived before the app was ready. */
let pendingOpen: string | undefined;

/** Opens `fsPath` now if the window is up, otherwise queues it for launch. */
function openFileWhenReady(fsPath: string): void {
  if (main) openFile(fsPath);
  else pendingOpen = fsPath;
}

// macOS: Finder "Open With", or a file dropped on the dock icon. This fires
// *before* app.whenReady(), so an early one has to be queued and flushed at
// the end of the ready block.
app.on("open-file", (event, fsPath) => {
  event.preventDefault();
  focusMainWindow();
  openFileWhenReady(fsPath);
});

// Windows/Linux: a second launch (file association, CLI, launcher) delivers its
// argv here instead of starting a second app.
app.on("second-instance", (_event, argv, workingDirectory) => {
  focusMainWindow();
  // A relative path must resolve against the *loser's* cwd, not ours.
  const fsPath = fileArgFrom(argv, workingDirectory);
  if (fsPath) openFileWhenReady(fsPath);
});

/** Brings the existing window forward — a forwarded open must be visible. */
function focusMainWindow(): void {
  if (!main) return;
  if (main.win.isMinimized()) main.win.restore();
  main.win.show();
  main.win.focus();
}

let main: MainWindow | null = null;
/** One CadHost/MeshHost per open tab, keyed by that tab's id (windows.ts's Tab.id). */
const cadHosts = new Map<string, CadHost>();
const meshHosts = new Map<string, MeshHost>();
/** Shared, ref-counted across every open mesh tab — see meshHost.ts's header. */
let flowgraph: FlowgraphController | null = null;
/** Shared across every open mesh tab — a solve outlives the tab that started
 *  it, so this is one registry for the app, disposed on will-quit. */
let runs: RunManager | null = null;
/** Shared across every open mesh tab (mesh 3.15.0). Backed only by globalState,
 *  so per-tab instances would share the list but each fire their own change
 *  events — one instance is the correct reading. Surfaced as File ▸ Open
 *  Recent, since the activity-bar view upstream reads it from is unreachable. */
let recents: RecentMeshStore | null = null;
let terminal: TerminalService | null = null;
let editor: EditorService | null = null;
let chat: ChatService | null = null;
let mcpHub: McpHub | null = null;
let metaServer: MetaMcpServer | null = null;

/**
 * The first real file path in an argv array — our own launch arguments, or the
 * argv a second instance forwards. Skips flags and the dev-mode "." app path.
 * The count-based slice is deliberate: in the dev layout the app can be started
 * as `electron out/main.js`, where argv[1] is a real file that must not be
 * opened as a document. `resolveFrom` is the cwd that argv came from, which for
 * a forwarded launch is the *other* process's working directory.
 */
function fileArgFrom(argv: string[], resolveFrom = process.cwd()): string | undefined {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const candidate = args.find((a) => {
    if (a.startsWith("-") || a === ".") return false;
    const full = path.resolve(resolveFrom, a);
    return fsSync.existsSync(full) && fsSync.statSync(full).isFile();
  });
  return candidate === undefined ? undefined : path.resolve(resolveFrom, candidate);
}

/** A file path passed on the command line (also used by the e2e smoke test). */
function cliFileArg(): string | undefined {
  return fileArgFrom(process.argv);
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

/**
 * Renderer-crash recovery. windows.ts reports a dead view; the policy lives
 * here because this module owns the host maps and so knows what to replay.
 *
 * Every view already self-heals on a reload through its own ready handshake —
 * the shell replays screen + tab strips + zoom on `shellReady`, the editor
 * replays `lastDoc` on `editorReady`, the terminal's `termReady` reuses the
 * still-running pty, the chat replays from its main-side transcript, and a
 * mode tab re-runs the provider handshake from `openPath`. So recovery is a
 * reload plus, for a mode tab, replaying the file.
 *
 * Bounded: a view that keeps dying must not become a reload loop. The counter
 * ages out, so an isolated crash months later still gets its retries.
 */
const MAX_VIEW_RECOVERIES = 2;
const RECOVERY_WINDOW_MS = 5 * 60_000;
const recoveries = new Map<string, { count: number; last: number }>();
/** Set once the app is on its way out — a teardown crash is not worth reviving. */
let quitting = false;
/** A toast for the shell itself has to wait for the shell to come back. */
let deferredShellToast: string | undefined;

function onViewCrash(crash: ViewCrash): void {
  if (quitting || !main) return;
  const key = crash.kind === "tab" ? `tab:${crash.mode}:${crash.tabId}` : crash.kind;
  const now = Date.now();
  const prev = recoveries.get(key);
  const count = prev && now - prev.last < RECOVERY_WINDOW_MS ? prev.count + 1 : 1;
  recoveries.set(key, { count, last: now });

  const label = crash.kind === "tab" ? (crash.mode === "cad" ? "CAD viewer" : "Mesh viewer") : `${crash.kind} view`;
  if (count > MAX_VIEW_RECOVERIES) {
    toast("error", `The ${label} keeps crashing (${crash.reason}). Your files on disk are untouched.`);
    return;
  }
  recoverView(crash, label);
}

function recoverView(crash: ViewCrash, label: string): void {
  if (!main) return;
  if (crash.kind === "tab") {
    const { mode, tabId } = crash;
    if (!mode || !tabId) return;
    const host = mode === "cad" ? cadHosts.get(tabId) : meshHosts.get(tabId);
    if (!host) return; // the tab was closed on the way here
    const file = host.currentFile;
    if (file) {
      // openPath() reloads the view itself, and its disposeSession() is what
      // rejects the pending promises a crash would otherwise leak forever —
      // so never also call reloadView here, or the two reloads race.
      host.openPath(file);
      toast("warning", `${label} crashed — reloaded ${path.basename(file)}.`);
    } else {
      main.reloadView(crash);
      toast("warning", `${label} crashed — reloaded.`);
    }
    return;
  }

  main.reloadView(crash);
  switch (crash.kind) {
    case "shell":
      // The toast renderer *is* the shell, so hold the message until it is back
      // (replayed from the shellReady handshake below).
      deferredShellToast = "Toolbar reloaded after a crash.";
      break;
    case "editor":
      if (editor?.notifyRendererGone()) {
        toast("warning", "Text editor crashed — reloaded from disk; unsaved changes were lost.");
      } else {
        toast("warning", "Text editor crashed — reloaded.");
      }
      break;
    case "terminal":
      toast("info", "Terminal panel reloaded — the shell session is still running (scrollback lost).");
      break;
    case "chat":
      toast("info", "Chat panel reloaded — the conversation is intact.");
      break;
    case "home":
      toast("info", "Home screen reloaded.");
      break;
  }
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

// cadHostHooks closes over no specific tab, so one object serves every cad tab.
// meshHostHooks does (onReveal has to focus *this* tab), so it is a factory.
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
const meshHostHooks = (tabId: string) => ({
  onTitle: () => syncTabs("mesh"),
  // A provider called WebviewPanel.reveal() — mesh 3.8.0's "open latest
  // results" jumps an already-open preview to the newest step rather than
  // opening a duplicate, so bring that tab to the front.
  onReveal: () => {
    if (!main) return;
    main.setActiveTab("mesh", tabId);
    setScreen("mesh");
    syncTabs("mesh");
  },
});

/** Creates a new (focused) tab for `mode`: its WebContentsView + Host. */
function createTab(mode: Mode) {
  if (!main) throw new Error("main window not ready");
  const tab = main.openTab(mode);
  if (mode === "cad") {
    cadHosts.set(tab.id, new CadHost(tab.view, path.join(__dirname, "cad-runtime"), cadHostHooks, tab.id));
  } else {
    if (!flowgraph) flowgraph = new FlowgraphController();
    if (!runs) {
      // Mirrors extension.ts activate(): construct once, restore adopted run
      // sidecars, dispose on quit.
      runs = new RunManager(createMeshExtensionContext(__dirname));
      runs.restore();
    }
    if (!recents) {
      // Same rule, and the same mirror of extension.ts activate(): construct
      // once, sync the context key, dispose on quit.
      recents = new RecentMeshStore(createMeshExtensionContext(__dirname));
      recents.syncContext();
    }
    meshHosts.set(
      tab.id,
      new MeshHost(tab.view, __dirname, meshHostHooks(tab.id), flowgraph, runs, recents)
    );
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

/**
 * "kratos.vtk.openLatestResults" — the only path behind mesh's
 * PtController.openResults() since 3.8.0. Ports extension.ts's handler: if any
 * open mesh tab is already showing this case's series, jump *that* tab to the
 * newest step rather than opening a duplicate; otherwise open the latest file
 * in a new tab. `excludeNewest` is set for a run that did not finish cleanly,
 * whose final step may be truncated (the vtk writer has no atomic rename).
 */
function openLatestResults(caseDir: string, options?: { excludeNewest?: boolean }): void {
  const outDir = path.join(caseDir, "vtk_output");
  let names: string[] = [];
  try {
    names = fsSync.readdirSync(outDir);
  } catch {
    /* reported below */
  }
  const latest = latestResultFile(names, { excludeNewest: options?.excludeNewest });
  if (!latest) {
    toast(
      "info",
      "No results in vtk_output/ yet — run the case first (results appear as the solver writes steps)."
    );
    return;
  }
  const groups = groupVtkFiles(names, TIMELINE_EXTENSIONS);
  for (const host of meshHosts.values()) {
    for (const open of host.openPanelPaths()) {
      if (path.dirname(open) !== outDir) continue;
      if (!findGroupForFile(groups, path.basename(open))) continue;
      if (host.revealLatestFrame(open)) return;
    }
  }
  // No tab is showing it — open in a NEW mesh tab, matching the pre → post
  // sync rule that results never replace what the user has focused.
  const tab = createTab("mesh");
  meshHosts.get(tab.id)?.openPath(path.join(outDir, latest.fileName));
  setScreen("mesh");
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
    toast("warning", `Unsupported file type: ${path.basename(resolved)}`);
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
  // The lock loser is on its way out (app.quit() before ready does not
  // reliably suppress this handler) — it must not build a second app.
  if (!gotInstanceLock) return;
  installProtocolHandlers(__dirname);
  configurePicker(__dirname);
  configureAbout(__dirname);
  configureWhatsNew(__dirname);
  main = createMainWindow(__dirname, stateStore.get<number>(UI_ZOOM_KEY, DEFAULT_ZOOM) ?? DEFAULT_ZOOM, {
    onViewCrash,
  });
  configureNotifications(sendShell);
  __configureVscodeShim({
    openWith: (fsPath, viewType) => openFile(fsPath, modeForViewType(viewType)),
    openTextDocument: (fsPath) => void editor?.openPath(fsPath),
    openLatestResults,
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

  const menuDeps: Parameters<typeof installMenu>[0] = {
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
    recentMeshes: {
      list: () => recents?.list() ?? [],
      open: (fsPath) => openFile(fsPath, "mesh"),
      clear: () => recents?.clear(),
    },
    metaServer: {
      enabled: () => stateStore.get(META_SERVER_KEYS.enabled, false) ?? false,
      setEnabled: (enabled) => void setMetaServerEnabled(enabled),
      copyConfig: () => void copyMetaServerConfig(),
      regenerateToken: () => void regenerateMetaServerToken(),
    },
  };
  installMenu(menuDeps);
  // An Electron menu is static once built, so the Open Recent submenu only
  // tracks the store by rebuilding the whole template. `record()` fires once
  // per file open and `clear()` once per click, so this is not a hot path.
  recents?.onDidChange(() => installMenu(menuDeps));

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
        if (deferredShellToast) {
          toast("warning", deferredShellToast);
          deferredShellToast = undefined;
        }
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

  // One deferred-open path for both sources: the command line, and any macOS
  // `open-file` that landed before the window existed.
  const fileArg = cliFileArg() ?? pendingOpen;
  pendingOpen = undefined;
  if (fileArg) {
    // Give the views a beat to finish their first load; openPath reloads anyway.
    setTimeout(() => openFile(fileArg), 300);
  }
});

// Single teardown for the shared MCP manager + the HTTP meta server + the
// Flowgraph child process (the chat service only aborts its in-flight turn).
// A renderer dying during teardown is not worth reviving.
app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  quitting = true;
  // First, because `will-quit` cannot await: the store's last-chance
  // synchronous write, so a setting changed a moment ago survives the quit.
  stateStore.flushSync();
  void metaServer?.dispose();
  void mcpHub?.dispose();
  flowgraph?.dispose();
  // Stops live solves (or detaches them, per kratos.run.stopOnWindowClose) so
  // a spawned child isn't re-parented to init with a broken stdout pipe.
  runs?.dispose();
  recents?.dispose();
});

app.on("window-all-closed", () => {
  app.quit();
});
