/**
 * Main window: one BaseWindow hosting three WebContentsViews —
 * a slim always-visible shell toolbar (mode toggle, Open, title, toasts) and
 * the two mode views (cad = CAD-Preview webview, mesh = MDPA/VTK webview).
 * Both mode views are created at startup and toggled with setVisible() so
 * each keeps its loaded file, camera, and history across switches.
 */
import { BaseWindow, WebContentsView } from "electron";
import * as path from "path";
import type { Mode } from "./ipc";

export const SHELL_HEIGHT = 40;

export interface MainWindow {
  win: BaseWindow;
  shell: WebContentsView;
  views: Record<Mode, WebContentsView>;
  mode: () => Mode;
  setMode: (mode: Mode) => void;
}

export function createMainWindow(outDir: string): MainWindow {
  const win = new BaseWindow({
    width: 1360,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "KKSS — Keep Kratos Simple Stupid",
    backgroundColor: "#1e1e1e",
    // Window/taskbar icon (Linux; Windows/macOS use the packaged icon).
    icon: path.join(outDir, "icon.png"),
  });

  const shell = new WebContentsView({
    webPreferences: {
      preload: path.join(outDir, "preload", "shellPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const makeView = (mode: Mode) =>
    new WebContentsView({
      webPreferences: {
        preload: path.join(outDir, "preload", "viewPreload.js"),
        additionalArguments: [`--kkss-channel=${mode}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
      },
    });

  const views: Record<Mode, WebContentsView> = { cad: makeView("cad"), mesh: makeView("mesh") };

  win.contentView.addChildView(shell);
  win.contentView.addChildView(views.cad);
  win.contentView.addChildView(views.mesh);

  let current: Mode = "cad";

  const layout = () => {
    const { width, height } = win.getContentBounds();
    shell.setBounds({ x: 0, y: 0, width, height: SHELL_HEIGHT });
    const body = { x: 0, y: SHELL_HEIGHT, width, height: Math.max(0, height - SHELL_HEIGHT) };
    views.cad.setBounds(body);
    views.mesh.setBounds(body);
  };
  win.on("resize", layout);
  layout();

  const setMode = (mode: Mode) => {
    current = mode;
    views.cad.setVisible(mode === "cad");
    views.mesh.setVisible(mode === "mesh");
  };
  setMode("cad");

  void shell.webContents.loadURL("kkss://app/renderer/shell/index.html");
  void views.cad.webContents.loadURL("kkss://app/renderer/cad/index.html");
  void views.mesh.webContents.loadURL("kkss://app/renderer/mesh/index.html");

  return { win, shell, views, mode: () => current, setMode };
}
