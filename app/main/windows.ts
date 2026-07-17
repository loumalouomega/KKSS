/**
 * Main window: one BaseWindow hosting stacked WebContentsViews —
 * a slim shell toolbar (mode toggle, Open, title, toasts), the two mode views
 * (cad = CAD-Preview webview, mesh = MDPA/VTK webview), a full-window home
 * screen (main menu) shown on launch and via "Home", plus two lazily created
 * panels shared by both modes: a bottom terminal and a right-hand AI chat
 * sidebar. Views are toggled with
 * setVisible() so each mode keeps its loaded file, camera, and history
 * across switches.
 */
import { BaseWindow, WebContentsView } from "electron";
import * as path from "path";
import type { Mode, Screen } from "./ipc";

export const SHELL_HEIGHT = 40;
export const TERMINAL_HEIGHT = 280;
export const CHAT_WIDTH = 360;

/** Discrete interface-scale steps offered by the shell's zoom picker. */
export const ZOOM_PRESETS = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const DEFAULT_ZOOM = 1;
const ZOOM_MIN = ZOOM_PRESETS[0];
const ZOOM_MAX = ZOOM_PRESETS[ZOOM_PRESETS.length - 1];
const clampZoom = (f: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, f));

export interface MainWindow {
  win: BaseWindow;
  shell: WebContentsView;
  home: WebContentsView;
  editor: WebContentsView;
  views: Record<Mode, WebContentsView>;
  /** Last active mode — stays valid while the home screen is shown. */
  mode: () => Mode;
  screen: () => Screen;
  setScreen: (screen: Screen) => void;
  terminalVisible: () => boolean;
  /** Shows/hides the terminal panel, creating its view on first use. */
  toggleTerminal: () => { view: WebContentsView; visible: boolean };
  chatVisible: () => boolean;
  /** Shows/hides the chat sidebar, creating its view on first use. */
  toggleChat: () => { view: WebContentsView; visible: boolean };
  /** Current interface scale (applied to every view + the chrome bounds). */
  zoom: () => number;
  /** Scales every view's content and the chrome constants; clamped to presets. */
  setZoom: (factor: number) => number;
}

export function createMainWindow(outDir: string, initialZoom = DEFAULT_ZOOM): MainWindow {
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

  const editor = new WebContentsView({
    webPreferences: {
      preload: path.join(outDir, "preload", "editorPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.contentView.addChildView(shell);
  win.contentView.addChildView(views.cad);
  win.contentView.addChildView(views.mesh);
  win.contentView.addChildView(editor);
  win.contentView.addChildView(home); // last = topmost: covers shell + modes

  let currentMode: Mode = "cad";
  let currentScreen: Screen = "home";
  let terminal: WebContentsView | null = null;
  let terminalShown = false;
  let chat: WebContentsView | null = null;
  let chatShown = false;
  // setZoomFactor scales each view's *content* but not its bounds, so the fixed
  // chrome (shell bar, terminal, chat) must scale in lockstep or it would clip.
  let currentZoom = clampZoom(initialZoom);

  const layout = () => {
    const { width, height } = win.getContentBounds();
    const shellH = Math.round(SHELL_HEIGHT * currentZoom);
    shell.setBounds({ x: 0, y: 0, width, height: shellH });
    const sidebar = chatShown ? Math.min(Math.round(CHAT_WIDTH * currentZoom), Math.floor(width / 2)) : 0;
    const bodyWidth = Math.max(0, width - sidebar);
    const panel = terminalShown ? Math.round(TERMINAL_HEIGHT * currentZoom) : 0;
    const body = { x: 0, y: shellH, width: bodyWidth, height: Math.max(0, height - shellH - panel) };
    views.cad.setBounds(body);
    views.mesh.setBounds(body);
    editor.setBounds(body);
    terminal?.setBounds({ x: 0, y: Math.max(shellH, height - panel), width: bodyWidth, height: panel });
    chat?.setBounds({ x: bodyWidth, y: shellH, width: sidebar, height: Math.max(0, height - shellH) });
    home.setBounds({ x: 0, y: 0, width, height });
  };
  win.on("resize", layout);

  // Electron resets a view's zoom to 1 on every navigation, so reassert it once
  // each page commits (the mode views reload on file open). Applied to lazily
  // created views (terminal, chat) in their factories below.
  const trackZoom = (view: WebContentsView) =>
    view.webContents.on("did-finish-load", () => view.webContents.setZoomFactor(currentZoom));
  for (const v of [shell, home, editor, views.cad, views.mesh]) trackZoom(v);

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
      trackZoom(terminal);
      void terminal.webContents.loadURL("kkss://app/renderer/terminal/index.html");
    }
    terminalShown = !terminalShown;
    terminal.setVisible(terminalShown);
    layout();
    if (terminalShown) terminal.webContents.focus();
    return { view: terminal, visible: terminalShown };
  };

  const toggleChat = () => {
    if (!chat) {
      chat = new WebContentsView({
        webPreferences: {
          preload: path.join(outDir, "preload", "chatPreload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      win.contentView.addChildView(chat);
      win.contentView.addChildView(home); // keep the home screen topmost
      trackZoom(chat);
      void chat.webContents.loadURL("kkss://app/renderer/chat/index.html");
    }
    chatShown = !chatShown;
    chat.setVisible(chatShown);
    layout();
    if (chatShown) chat.webContents.focus();
    return { view: chat, visible: chatShown };
  };

  const setScreen = (screen: Screen) => {
    currentScreen = screen;
    if (screen === "cad" || screen === "mesh") currentMode = screen;
    home.setVisible(screen === "home");
    editor.setVisible(screen === "editor");
    views.cad.setVisible(screen === "cad");
    views.mesh.setVisible(screen === "mesh");
    if (screen === "editor") editor.webContents.focus();
  };
  setScreen("home");

  const setZoom = (factor: number): number => {
    currentZoom = clampZoom(factor);
    const live = [shell, home, editor, views.cad, views.mesh, terminal, chat];
    for (const v of live) if (v) v.webContents.setZoomFactor(currentZoom);
    layout();
    return currentZoom;
  };

  void shell.webContents.loadURL("kkss://app/renderer/shell/index.html");
  void home.webContents.loadURL("kkss://app/renderer/home/index.html");
  void editor.webContents.loadURL("kkss://app/renderer/editor/index.html");
  void views.cad.webContents.loadURL("kkss://app/renderer/cad/index.html");
  void views.mesh.webContents.loadURL("kkss://app/renderer/mesh/index.html");

  return {
    win,
    shell,
    home,
    editor,
    views,
    mode: () => currentMode,
    screen: () => currentScreen,
    setScreen,
    terminalVisible: () => terminalShown,
    toggleTerminal,
    chatVisible: () => chatShown,
    toggleChat,
    zoom: () => currentZoom,
    setZoom,
  };
}
