import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import * as pty from "node-pty";
import { TerminalService } from "../app/main/services/terminal";

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  ipcMain: { on: vi.fn() },
  WebContents: class {},
}));
vi.mock("../app/main/services/stateStore", () => ({ stateStore: { get: () => undefined } }));
vi.mock("node-pty", () => ({ spawn: vi.fn() }));

/** A pty whose exit the test controls; `onKill` decides when (if ever) it exits. */
function fakePty(onKill: (exit: (exitCode: number) => void) => void = () => undefined) {
  let listener: ((event: { exitCode: number }) => void) | undefined;
  const exit = (exitCode: number) => listener?.({ exitCode });
  return {
    onData: vi.fn(),
    onExit: vi.fn((cb: (event: { exitCode: number }) => void) => {
      listener = cb;
    }),
    kill: vi.fn(() => onKill(exit)),
    write: vi.fn(),
    resize: vi.fn(),
    exit,
  };
}

/** Builds a service attached to a fake panel, and starts its shell the way the renderer does. */
function startShell(proc: ReturnType<typeof fakePty>) {
  vi.mocked(pty.spawn).mockReturnValue(proc as unknown as pty.IPty);
  const service = new TerminalService(() => undefined, () => undefined);
  const calls = vi.mocked(ipcMain.on).mock.calls;
  const handler = calls[calls.length - 1][1] as (event: unknown, raw: unknown) => void;
  const webContents = { isDestroyed: () => false, send: vi.fn() };
  service.attach(webContents as never);
  handler({ sender: webContents }, { type: "termReady", cols: 80, rows: 24 });
  return { service, webContents };
}

describe("TerminalService shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("with no shell running, shutdown resolves without signalling anything", async () => {
    const service = new TerminalService(() => undefined, () => undefined);
    expect(service.hasLiveShell()).toBe(false);
    await expect(service.shutdown()).resolves.toBeUndefined();
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it("waits for the shell to exit, then reports the exit to the panel", async () => {
    const proc = fakePty((exit) => setTimeout(() => exit(0), 5));
    const { service, webContents } = startShell(proc);
    expect(service.hasLiveShell()).toBe(true);

    await service.shutdown();

    expect(proc.kill).toHaveBeenCalledWith("SIGHUP");
    expect(service.hasLiveShell()).toBe(false);
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", { type: "exit", code: 0 });
  });

  it("contains a failing exit notice, so the native exit callback never throws", async () => {
    const proc = fakePty();
    const { service, webContents } = startShell(proc);
    webContents.send.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pending = service.shutdown();
    expect(proc.kill).toHaveBeenCalledWith("SIGHUP");
    expect(() => proc.exit(0)).not.toThrow();

    await expect(pending).resolves.toBeUndefined();
    expect(service.hasLiveShell()).toBe(false);
    expect(consoleError).toHaveBeenCalledWith("Terminal exit notice failed", expect.any(Error));
    consoleError.mockRestore();
  });

  it("a shell that exits on its own stops counting as live", () => {
    const proc = fakePty();
    const { service, webContents } = startShell(proc);

    proc.exit(0);

    expect(service.hasLiveShell()).toBe(false);
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", { type: "exit", code: 0 });
  });
});
