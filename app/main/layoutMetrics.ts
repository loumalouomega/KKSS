// The window's bounds arithmetic, kept free of Electron so it can be tested.
// windows.ts's layout() applies the result to the views; nothing else computes
// chrome sizes.

export interface Rect { x: number; y: number; width: number; height: number }

export interface LayoutInput {
  width: number;
  height: number;
  zoom: number;
  /** Fixed chrome sizes at zoom 1 (windows.ts constants). */
  shellHeight: number;
  tabStripHeight: number;
  terminalHeight: number;
  sidebarWidth: number;
  /** A mode screen (cad/mesh) is active, so its tab strip is reserved. */
  hasTabs: boolean;
  terminalShown: boolean;
  sidebarShown: boolean;
  /** Presentation mode: only the focused content keeps any bounds. */
  presentation: boolean;
}

export interface LayoutResult {
  chromeH: number;
  sidebar: number;
  bodyWidth: number;
  panel: number;
  shell: Rect;
  body: Rect;
  terminal: Rect;
  sidebarRect: Rect;
  home: Rect;
}

export function layoutMetrics(i: LayoutInput): LayoutResult {
  const z = (n: number) => Math.round(n * i.zoom);
  const pres = i.presentation;
  const shellH = pres ? 0 : z(i.shellHeight);
  const tabsH = !pres && i.hasTabs ? z(i.tabStripHeight) : 0;
  const chromeH = shellH + tabsH;
  const sidebar = !pres && i.sidebarShown ? Math.min(z(i.sidebarWidth), Math.floor(i.width / 2)) : 0;
  const bodyWidth = Math.max(0, i.width - sidebar);
  const panel = !pres && i.terminalShown ? z(i.terminalHeight) : 0;
  return {
    chromeH,
    sidebar,
    bodyWidth,
    panel,
    shell: { x: 0, y: 0, width: i.width, height: chromeH },
    body: { x: 0, y: chromeH, width: bodyWidth, height: Math.max(0, i.height - chromeH - panel) },
    terminal: { x: 0, y: Math.max(chromeH, i.height - panel), width: bodyWidth, height: panel },
    sidebarRect: { x: bodyWidth, y: chromeH, width: sidebar, height: Math.max(0, i.height - chromeH) },
    home: { x: 0, y: 0, width: bodyWidth, height: i.height },
  };
}
