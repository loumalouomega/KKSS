/**
 * Main window: one BaseWindow hosting stacked WebContentsViews —
 * a slim shell toolbar (mode toggle, Open, title, toasts), the two mode views
 * (cad = CAD-Preview webview, mesh = MDPA/VTK webview), a full-window home
 * screen (main menu) shown on launch and via "Home", and a lazily created
 * bottom terminal panel shared by both modes. Views are toggled with
 * setVisible() so each mode keeps its loaded file, camera, and history
 * across switches.
 */
import { BaseWindow, WebContentsView } from "electron";
import * as path from "path";
import type { Mode, Screen } from "./ipc";

export const SHELL_HEIGHT = 40;
export const TERMINAL_HEIGHT = 280;

export interface MainWindow {
  win: BaseWindow;
  shell: WebContentsView;
  home: WebContentsView;
  views: Record<Mode, WebContentsView>;
  /** Last active mode — stays valid while the home screen is shown. */
  mode: () => Mode;
  screen: () => Screen;
  setScreen: (screen: Screen) => void;
  terminalVisible: () => boolean;
  /** Shows/hides the terminal panel, creating its view on first use. */
  toggleTerminal: () => { view: WebContentsView; visible: boolean };
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
  let terminal: WebContentsView | null = null;
  let terminalShown = false;

  const layout = () => {
    const { width, height } = win.getContentBounds();
    shell.setBounds({ x: 0, y: 0, width, height: SHELL_HEIGHT });
    const panel = terminalShown ? TERMINAL_HEIGHT : 0;
    const body = { x: 0, y: SHELL_HEIGHT, width, height: Math.max(0, height - SHELL_HEIGHT - panel) };
    views.cad.setBounds(body);
    views.mesh.setBounds(body);
    terminal?.setBounds({ x: 0, y: Math.max(SHELL_HEIGHT, height - panel), width, height: panel });
    home.setBounds({ x: 0, y: 0, width, height });
  };
  win.on("resize", layout);
  layout();

  const toggleTerminal = () => {
    if (!terminal) {
      terminal = new WebContentsView({
        webPreferences: {
          preload: path.join(outDir, "preload", "terminalPreload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      win.contentView.addChildView(terminal);
      win.contentView.addChildView(home); // keep the home screen topmost
      void terminal.webContents.loadURL("kkss://app/renderer/terminal/index.html");
    }
    terminalShown = !terminalShown;
    terminal.setVisible(terminalShown);
    layout();
    if (terminalShown) terminal.webContents.focus();
    return { view: terminal, visible: terminalShown };
  };

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

  return {
    win,
    shell,
    home,
    views,
    mode: () => currentMode,
    screen: () => currentScreen,
    setScreen,
    terminalVisible: () => terminalShown,
    toggleTerminal,
  };
}
