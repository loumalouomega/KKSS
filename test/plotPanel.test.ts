import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const state = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() });
    destroyed = false;
    loadURL = vi.fn(async () => {});
    show = vi.fn();
    constructor(readonly options: any) { super(); state.windows.push(this); }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit("closed"); }
  }
  return { BrowserWindow: Window, ipcMain: new EventEmitter() };
});
vi.mock("../app/main/services/appearance", () => ({ windowBackground: () => "#222222" }));
vi.mock("../app/main/services/notifications", () => ({ toast: vi.fn() }));
const { ipcMain } = await import("electron");
const { createPlotPanel } = await import("../app/main/services/plotPanel");

beforeEach(() => { state.windows.length = 0; (ipcMain as unknown as EventEmitter).removeAllListeners(); });

it("hosts only the trusted generated plotting page with an isolated preload", async () => {
  const panel = createPlotPanel("Plots"), win = state.windows[0];
  expect(win.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, additionalArguments: ["--kkss-channel=plots"] });
  expect(win.options.webPreferences.preload).toMatch(/preload[/\\]viewPreload\.js$/);
  panel.webview.html = '<script src="https://untrusted.invalid/script.js"></script>';
  expect(win.loadURL).toHaveBeenCalledWith("kkss://app/renderer/mesh/plots.html");
  expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: "deny" });
  const preventDefault = vi.fn();
  win.webContents.emit("will-navigate", { preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  panel.dispose();
});

it("isolates messages by sender and disposes listeners/controller with the window", async () => {
  const first = createPlotPanel("First"), second = createPlotPanel("Second");
  const [a,b] = state.windows, receiveA = vi.fn(), receiveB = vi.fn(), dispose = vi.fn();
  first.webview.onDidReceiveMessage(receiveA); second.webview.onDidReceiveMessage(receiveB);
  first.onDidDispose(dispose);
  ipcMain.emit("plots:toHost", { sender: b.webContents }, { type: "plotReady" });
  expect(receiveA).not.toHaveBeenCalled(); expect(receiveB).toHaveBeenCalledOnce();
  const event = { sender: a.webContents, returnValue: undefined };
  ipcMain.emit("plots:initialState", event); expect(event.returnValue).toEqual({});
  await first.webview.postMessage({ type: "plotResult" });
  expect(a.webContents.send).toHaveBeenCalledWith("plots:toWebview", { type: "plotResult" });
  first.dispose(); expect(dispose).toHaveBeenCalledOnce();
  expect(ipcMain.listenerCount("plots:toHost")).toBe(1);
  expect(await first.webview.postMessage({ type: "plotResult" })).toBe(false);
  second.dispose(); expect(ipcMain.listenerCount("plots:toHost")).toBe(0);
  expect(ipcMain.listenerCount("plots:initialState")).toBe(0);
});
