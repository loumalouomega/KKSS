import { expect, it, vi } from "vitest";

const { win, construct } = vi.hoisted(() => {
  const win = {
    webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
    on: vi.fn(), loadURL: vi.fn(async (_url: string) => {}),
    isDestroyed: vi.fn(() => false), show: vi.fn(), close: vi.fn(),
  };
  const construct = vi.fn(function () { return win; });
  return { win, construct };
});
vi.mock("electron", () => ({ BrowserWindow: construct }));
vi.mock("node:fs", () => ({ readFileSync: () => ":root{--vscode-editor-background:#1e1e1e}" }));
vi.mock("../app/main/services/appearance", () => ({
  currentAppearance: () => ({ kind: "vscode-dark" }), windowBackground: () => "#1e1e1e",
}));
vi.mock("../app/main/services/notifications", () => ({ toast: vi.fn() }));

import { createStaticReportPanel } from "../app/main/services/staticReport";

it("shows themed upstream HTML without scripts, Node, preload, popups or navigation", async () => {
  const panel = createStaticReportPanel("Export report");
  const html = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"></head><body>&lt;file&gt;</body></html>';
  panel.webview.html = html;
  expect(panel.webview.html).toBe(html);
  expect(construct).toHaveBeenCalledWith(expect.objectContaining({
    show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false },
  }));
  const url = win.loadURL.mock.calls[0][0] as unknown as string;
  const served = decodeURIComponent(url.split(",").slice(1).join(","));
  expect(served).toContain("default-src 'none'");
  expect(served).toContain('--vscode-editor-background');
  expect(served).toContain('<body class="vscode-dark">&lt;file&gt;');
  expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
  const preventDefault = vi.fn();
  win.webContents.on.mock.calls[0][1]({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(win.show).toHaveBeenCalledOnce());
});
