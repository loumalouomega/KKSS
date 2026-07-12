/** KKSS Electron main entry. */
import { app, ipcMain } from "electron";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { registerSchemes, installProtocolHandlers } from "./protocol";
import { createMainWindow, MainWindow } from "./windows";
import { CadHost } from "./cadHost";
import { MeshHost } from "./mesh/meshHost";
import { installMenu } from "./menu";
import { modeForFile, modeForViewType } from "./router";
import { configurePicker } from "./services/quickPick";
import { configureAbout, showAbout } from "./services/about";
import { TerminalService } from "./services/terminal";
import { EditorService } from "./services/editor";
import { configureNotifications, handleToastButton } from "./services/notifications";
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

/** A file path passed on the command line (also used by the e2e smoke test). */
function cliFileArg(): string | undefined {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  return args.find((a) => !a.startsWith("-") && a !== "." && fsSync.existsSync(a) && fsSync.statSync(a).isFile());
}

function sendShell(message: unknown): void {
  main?.shell.webContents.send("shell:toWebview", message);
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

app.whenReady().then(() => {
  installProtocolHandlers(__dirname);
  configurePicker(__dirname);
  configureAbout(__dirname);
  main = createMainWindow(__dirname);
  configureNotifications(sendShell);
  __configureVscodeShim({
    openWith: (fsPath, viewType) => openFile(fsPath, modeForViewType(viewType)),
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

  installMenu({ main, cadHost, meshHost, editor, setScreen, toggleTerminal });

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
      case "openFile":
        if (main.mode() === "cad") void cadHost?.openFileDialog();
        else void openMesh(); // mesh/src/meshExport openMesh → dialog → openWith hook
        break;
      case "toastButton":
        handleToastButton(msg.id, msg.button);
        break;
    }
  });

  const fileArg = cliFileArg();
  if (fileArg) {
    // Give the views a beat to finish their first load; openPath reloads anyway.
    setTimeout(() => openFile(fileArg), 300);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
