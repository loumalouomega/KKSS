import { describe, expect, it } from "vitest";
import { layoutMetrics, type LayoutInput } from "../app/main/layoutMetrics";

const base: LayoutInput = {
  width: 1360, height: 860, zoom: 1,
  shellHeight: 40, tabStripHeight: 34, terminalHeight: 280, sidebarWidth: 360,
  hasTabs: true, terminalShown: false, sidebarShown: false, presentation: false,
};

describe("layoutMetrics", () => {
  it("reserves the shell bar and tab strip above the body", () => {
    const m = layoutMetrics(base);
    expect(m.chromeH).toBe(74);
    expect(m.shell).toEqual({ x: 0, y: 0, width: 1360, height: 74 });
    expect(m.body).toEqual({ x: 0, y: 74, width: 1360, height: 786 });
  });
  it("drops the tab strip off mode screens", () => {
    expect(layoutMetrics({ ...base, hasTabs: false }).chromeH).toBe(40);
  });
  it("splits the window between body, terminal and sidebar", () => {
    const m = layoutMetrics({ ...base, terminalShown: true, sidebarShown: true });
    expect(m.sidebar).toBe(360);
    expect(m.body.width).toBe(1000);
    expect(m.body.height).toBe(860 - 74 - 280);
    expect(m.terminal).toEqual({ x: 0, y: 580, width: 1000, height: 280 });
    expect(m.sidebarRect).toEqual({ x: 1000, y: 74, width: 360, height: 786 });
  });
  it("scales chrome with zoom and caps the sidebar at half the window", () => {
    const m = layoutMetrics({ ...base, zoom: 1.5, width: 600, sidebarShown: true });
    expect(m.chromeH).toBe(60 + 51);
    expect(m.sidebar).toBe(300);
  });
  it("gives the whole window to the viewer in presentation mode", () => {
    const m = layoutMetrics({ ...base, terminalShown: true, sidebarShown: true, presentation: true });
    expect(m.chromeH).toBe(0);
    expect(m.sidebar).toBe(0);
    expect(m.panel).toBe(0);
    expect(m.body).toEqual({ x: 0, y: 0, width: 1360, height: 860 });
    expect(m.shell.height).toBe(0);
    expect(m.terminal.height).toBe(0);
  });
  it("never produces a negative size in a tiny window", () => {
    const m = layoutMetrics({ ...base, width: 100, height: 100, terminalShown: true, sidebarShown: true });
    for (const r of [m.shell, m.body, m.terminal, m.sidebarRect, m.home])
      for (const v of Object.values(r)) expect(v).toBeGreaterThanOrEqual(0);
  });
});
