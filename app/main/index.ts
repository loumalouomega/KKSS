/** KKSS Electron main entry. */
import { app, clipboard, dialog, ipcMain, Menu } from "electron";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { registerSchemes, installProtocolHandlers } from "./protocol";
import { createMainWindow, MainWindow, DEFAULT_ZOOM, ZOOM_PRESETS } from "./windows";
import { CadHost } from "./cadHost";
import { MeshHost } from "./mesh/meshHost";
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
import type { HomeToHost, Mode, Screen, ShellToHost } from "./ipc";

// Must happen before app is ready.
registerSchemes();

let main: MainWindow | null = null;
let cadHost: CadHost | null = null;
let meshHost: MeshHost | null = null;
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

/** Opens a file in the mode the router picks (active mode wins on overlap). */
function openFile(fsPath: string, forcedMode?: Mode): void {
  if (!main || !cadHost || !meshHost) return;
  const resolved = path.resolve(fsPath);
  const mode = forcedMode ?? modeForFile(resolved, main.mode());
  if (!mode) {
    sendShell({ type: "toast", id: Date.now(), kind: "warning", text: `Unsupported file type: ${path.basename(resolved)}` });
    return;
  }
  if (mode === "cad") cadHost.openPath(resolved);
  else meshHost.openPath(resolved);
  setScreen(mode);
}

/** Switches screens and keeps the shell's active-screen highlight in sync. */
function setScreen(screen: Screen): void {
  main?.setScreen(screen);
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
    // Pipe webview console output through main for headless debugging/e2e.
    main.views[mode].webContents.on("console-message", (details) => {
      if (process.env.KKSS_E2E || details.level === "error" || details.level === "warning") {
        console.log(`[${mode}:console:${details.level}] ${details.message}`);
      }
    });
  }

  cadHost = new CadHost(main.views.cad, path.join(__dirname, "cad-runtime"), {
    onOpenRequest: (fsPath) => openFile(fsPath),
    onTitle: (fileName) => sendShell({ type: "title", view: "cad", fileName }),
    // Pre → post sync: a mesh exported from CAD that post mode can display
    // (.mdpa, .vtk, …) is opened straight into the mesh view. The router gates
    // this so shared formats (.stl/.obj/.ply) and CAD-only outputs never jump.
    onMeshExported: (fsPath) => {
      if (main && modeForFile(fsPath, main.mode()) === "mesh") openFile(fsPath, "mesh");
    },
  });

  meshHost = new MeshHost(main.views.mesh, __dirname, {
    onTitle: (fileName) => sendShell({ type: "title", view: "mesh", fileName }),
  });

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
      const current = main?.mode() === "cad" ? cadHost?.currentFile : meshHost?.currentFile;
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
    currentFiles: () => ({ cad: cadHost?.currentFile, mesh: meshHost?.currentFile }),
    openSettings: openSettingsMenu,
    onHide: () => {
      if (main?.chatVisible()) toggleChat();
    },
  });

  installMenu({
    main,
    cadHost,
    meshHost,
    editor,
    setScreen,
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
        // (or after a reload) — replay the current screen + titles.
        sendShell({ type: "screen", screen: main.screen() });
        sendShell({ type: "title", view: "cad", fileName: cadHost?.currentFile ? path.basename(cadHost.currentFile) : null });
        sendShell({ type: "title", view: "mesh", fileName: meshHost?.currentFile ? path.basename(meshHost.currentFile) : null });
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
        const current = main.mode() === "cad" ? cadHost?.currentFile : meshHost?.currentFile;
        if (current) void editor?.openPath(current);
        else toast("warning", "No file open in the current mode — use Open… first.");
        break;
      }
      case "openFile":
        if (main.mode() === "cad") void cadHost?.openFileDialog();
        else void openMesh(); // mesh/src/meshExport openMesh → dialog → openWith hook
        break;
      case "setZoom":
        setUiZoom(msg.factor);
        break;
      case "toastButton":
        handleToastButton(msg.id, msg.button);
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

// Single teardown for the shared MCP manager + the HTTP meta server (the chat
// service only aborts its in-flight turn).
app.on("will-quit", () => {
  void metaServer?.dispose();
  void mcpHub?.dispose();
});

app.on("window-all-closed", () => {
  app.quit();
});
