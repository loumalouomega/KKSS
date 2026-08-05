/**
 * Main window: one BaseWindow hosting stacked WebContentsViews —
 * a slim shell toolbar (mode toggle, Open, title, toasts, tab strip), the two
 * mode screens (cad = CAD-Preview webview, mesh = MDPA/VTK webview), a
 * full-window home screen (main menu) shown on launch and via "Home", plus
 * two lazily created panels shared by both modes: a bottom terminal and a
 * right-hand AI chat sidebar.
 *
 * Each mode screen can hold several open documents ("tabs"), each its own
 * `WebContentsView` — one full copy of the submodule's webview bundle per
 * tab, exactly like the terminal/chat panels' lazy-create-then-setVisible
 * precedent, just N-of-a-kind instead of one singleton. Only the active
 * mode's active tab is ever visible/bounded; every other tab (same mode or
 * the other one) stays hidden with its camera/history/scroll state intact —
 * nothing reloads on a tab switch. The tab strip itself is plain DOM inside
 * the `shell` WebContentsView (which already spans the window's full width),
 * not a view of its own.
 */
import { BaseWindow, WebContentsView } from "electron";
import * as path from "path";
import type { Mode, Screen } from "./ipc";

export const SHELL_HEIGHT = 40;
export const TAB_STRIP_HEIGHT = 34;
export const TERMINAL_HEIGHT = 280;
export const CHAT_WIDTH = 360;

/** Discrete interface-scale steps offered by the shell's zoom picker. */
export const ZOOM_PRESETS = [0.75, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const DEFAULT_ZOOM = 1;
const ZOOM_MIN = ZOOM_PRESETS[0];
const ZOOM_MAX = ZOOM_PRESETS[ZOOM_PRESETS.length - 1];
const clampZoom = (f: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, f));

/** One open document within a mode screen. */
export interface Tab {
  id: string;
  view: WebContentsView;
}

export interface MainWindow {
  win: BaseWindow;
  shell: WebContentsView;
  home: WebContentsView;
  editor: WebContentsView;
  /** Open tabs for `mode`, in creation order. */
  tabs: (mode: Mode) => readonly Tab[];
  /** The focused tab within `mode`'s screen, if any are open. */
  activeTabId: (mode: Mode) => string | undefined;
  /** Creates a new (hidden) tab and its WebContentsView; does not focus it. */
  openTab: (mode: Mode) => Tab;
  /** Destroys a tab's WebContentsView. If it was focused, the caller must
   *  setActiveTab a sibling (or leave the mode with none open). */
  closeTab: (mode: Mode, tabId: string) => void;
  /** Focuses a tab — the only one of its mode left visible/bounded. */
  setActiveTab: (mode: Mode, tabId: string) => void;
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

  const tabs: Record<Mode, Tab[]> = { cad: [], mesh: [] };
  const activeTab: Record<Mode, string | undefined> = { cad: undefined, mesh: undefined };
  let nextTabId = 1;

  const findTab = (mode: Mode, id: string): Tab | undefined => tabs[mode].find((t) => t.id === id);

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
  win.contentView.addChildView(editor);
  win.contentView.addChildView(home); // topmost so far: covers shell + editor

  let currentMode: Mode = "cad";
  let currentScreen: Screen = "home";
  let terminal: WebContentsView | null = null;
  let terminalShown = false;
  let chat: WebContentsView | null = null;
  let chatShown = false;
  // setZoomFactor scales each view's *content* but not its bounds, so the fixed
  // chrome (shell bar, tab strip, terminal, chat) must scale in lockstep or it
  // would clip.
  let currentZoom = clampZoom(initialZoom);

  const layout = () => {
    const { width, height } = win.getContentBounds();
    const shellH = Math.round(SHELL_HEIGHT * currentZoom);
    // The tab strip is DOM painted inside `shell`'s own page, so its height is
    // reserved by growing `shell`'s bounds, not by a view of its own — only
    // while a mode screen (which actually has tabs) is active.
    const tabsH =
      currentScreen === "cad" || currentScreen === "mesh" ? Math.round(TAB_STRIP_HEIGHT * currentZoom) : 0;
    const chromeH = shellH + tabsH;
    shell.setBounds({ x: 0, y: 0, width, height: chromeH });
    const sidebar = chatShown ? Math.min(Math.round(CHAT_WIDTH * currentZoom), Math.floor(width / 2)) : 0;
    const bodyWidth = Math.max(0, width - sidebar);
    const panel = terminalShown ? Math.round(TERMINAL_HEIGHT * currentZoom) : 0;
    const body = { x: 0, y: chromeH, width: bodyWidth, height: Math.max(0, height - chromeH - panel) };
    // Only the focused tab of each mode ever needs real bounds — every other
    // tab (same mode or the other one) is hidden via setVisible(false).
    const activeCad = activeTab.cad ? findTab("cad", activeTab.cad) : undefined;
    const activeMesh = activeTab.mesh ? findTab("mesh", activeTab.mesh) : undefined;
    activeCad?.view.setBounds(body);
    activeMesh?.view.setBounds(body);
    editor.setBounds(body);
    terminal?.setBounds({ x: 0, y: Math.max(chromeH, height - panel), width: bodyWidth, height: panel });
    chat?.setBounds({ x: bodyWidth, y: chromeH, width: sidebar, height: Math.max(0, height - chromeH) });
    home.setBounds({ x: 0, y: 0, width, height });
  };
  win.on("resize", layout);

  // Electron resets a view's zoom to 1 on every navigation, so reassert it once
  // each page commits (mode-tab views reload on file open). Applied to every
  // tab view in openTab() below and to the lazily created terminal/chat views
  // in their factories.
  const trackZoom = (view: WebContentsView) =>
    view.webContents.on("did-finish-load", () => view.webContents.setZoomFactor(currentZoom));
  for (const v of [shell, home, editor]) trackZoom(v);

  const applyTabVisibility = () => {
    for (const mode of ["cad", "mesh"] as const) {
      const active = activeTab[mode];
      for (const t of tabs[mode]) t.view.setVisible(currentScreen === mode && t.id === active);
    }
  };

  const openTab = (mode: Mode): Tab => {
    const view = makeView(mode);
    const tab: Tab = { id: `${mode}-${nextTabId++}`, view };
    tabs[mode].push(tab);
    win.contentView.addChildView(view);
    win.contentView.addChildView(home); // keep the home screen topmost
    trackZoom(view);
    view.setVisible(false); // shown only once focused, via setActiveTab
    void view.webContents.loadURL(`kkss://app/renderer/${mode}/index.html`);
    return tab;
  };

  const closeTab = (mode: Mode, tabId: string): void => {
    const idx = tabs[mode].findIndex((t) => t.id === tabId);
    if (idx < 0) return;
    const [tab] = tabs[mode].splice(idx, 1);
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (activeTab[mode] === tabId) {
      activeTab[mode] = undefined;
      applyTabVisibility();
    }
  };

  const setActiveTab = (mode: Mode, tabId: string): void => {
    if (!findTab(mode, tabId)) return;
    activeTab[mode] = tabId;
    applyTabVisibility();
    layout();
  };

  // No tabs are seeded here — index.ts creates the initial cad/mesh tab (and
  // constructs their CadHost/MeshHost in the same step) right after this
  // constructor returns, so a tab's view and its host are never split across
  // two owners mid-construction.
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
    applyTabVisibility();
    // The tab strip's reserved height only applies to cad/mesh screens (see
    // layout()), so switching to/from them must re-run it.
    layout();
    if (screen === "editor") editor.webContents.focus();
  };
  setScreen("home");

  const setZoom = (factor: number): number => {
    currentZoom = clampZoom(factor);
    const live: (WebContentsView | null)[] = [
      shell,
      home,
      editor,
      ...tabs.cad.map((t) => t.view),
      ...tabs.mesh.map((t) => t.view),
      terminal,
      chat,
    ];
    for (const v of live) if (v) v.webContents.setZoomFactor(currentZoom);
    layout();
    return currentZoom;
  };

  void shell.webContents.loadURL("kkss://app/renderer/shell/index.html");
  void home.webContents.loadURL("kkss://app/renderer/home/index.html");
  void editor.webContents.loadURL("kkss://app/renderer/editor/index.html");

  return {
    win,
    shell,
    home,
    editor,
    tabs: (mode) => tabs[mode],
    activeTabId: (mode) => activeTab[mode],
    openTab,
    closeTab,
    setActiveTab,
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
