/**
 * Main window: one BaseWindow hosting four WebContentsViews —
 * a slim shell toolbar (mode toggle, Open, title, toasts), the two mode views
 * (cad = CAD-Preview webview, mesh = MDPA/VTK webview), and a full-window
 * home screen (main menu) shown on launch and via "Home". All views are
 * created at startup and toggled with setVisible() so each mode keeps its
 * loaded file, camera, and history across switches.
 */
import { BaseWindow, WebContentsView } from "electron";
import * as path from "path";
import type { Mode, Screen } from "./ipc";

export const SHELL_HEIGHT = 40;

export interface MainWindow {
  win: BaseWindow;
  shell: WebContentsView;
  home: WebContentsView;
  views: Record<Mode, WebContentsView>;
  /** Last active mode — stays valid while the home screen is shown. */
  mode: () => Mode;
  screen: () => Screen;
  setScreen: (screen: Screen) => void;
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

  const home = new WebContentsView({
    webPreferences: {
      preload: path.join(outDir, "preload", "homePreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.contentView.addChildView(shell);
  win.contentView.addChildView(views.cad);
  win.contentView.addChildView(views.mesh);
  win.contentView.addChildView(home); // last = topmost: covers shell + modes

  let currentMode: Mode = "cad";
  let currentScreen: Screen = "home";

  const layout = () => {
    const { width, height } = win.getContentBounds();
    shell.setBounds({ x: 0, y: 0, width, height: SHELL_HEIGHT });
    const body = { x: 0, y: SHELL_HEIGHT, width, height: Math.max(0, height - SHELL_HEIGHT) };
    views.cad.setBounds(body);
    views.mesh.setBounds(body);
    home.setBounds({ x: 0, y: 0, width, height });
  };
  win.on("resize", layout);
  layout();

  const setScreen = (screen: Screen) => {
    currentScreen = screen;
    if (screen !== "home") currentMode = screen;
    home.setVisible(screen === "home");
    views.cad.setVisible(screen === "cad");
    views.mesh.setVisible(screen === "mesh");
  };
  setScreen("home");

  void shell.webContents.loadURL("kkss://app/renderer/shell/index.html");
  void home.webContents.loadURL("kkss://app/renderer/home/index.html");
  void views.cad.webContents.loadURL("kkss://app/renderer/cad/index.html");
  void views.mesh.webContents.loadURL("kkss://app/renderer/mesh/index.html");

  return { win, shell, home, views, mode: () => currentMode, screen: () => currentScreen, setScreen };
}
