import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain } from "electron";
import * as pty from "node-pty";
import { MAX_TERMINALS, TerminalService } from "../app/main/services/terminal";

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

/** Builds a service attached to a fake panel, and starts its first shell the way the renderer does. */
function startShell(proc: ReturnType<typeof fakePty>) {
  vi.mocked(pty.spawn).mockReturnValue(proc as unknown as pty.IPty);
  const service = new TerminalService(() => undefined, () => undefined);
  const calls = vi.mocked(ipcMain.on).mock.calls;
  const handler = calls[calls.length - 1][1] as (event: unknown, raw: unknown) => void;
  const webContents = { isDestroyed: () => false, send: vi.fn() };
  service.attach(webContents as never);
  const post = (raw: unknown) => handler({ sender: webContents }, raw);
  post({ type: "termReady", cols: 80, rows: 24 });
  return { service, webContents, post };
}

const last = <T,>(a: T[]): T => a[a.length - 1];

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
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", { type: "exit", id: 1, code: 0 });
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
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", { type: "exit", id: 1, code: 0 });
  });
});

describe("TerminalService sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers termReady with the session list, titled by the shell", () => {
    const { webContents } = startShell(fakePty());
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", {
      type: "sessions",
      sessions: [{ id: 1, title: expect.any(String), exited: false, scrollback: "" }],
    });
  });

  it("opens independent terminals and routes input by id", () => {
    const first = fakePty();
    const { post, webContents } = startShell(first);
    const second = fakePty();
    vi.mocked(pty.spawn).mockReturnValue(second as unknown as pty.IPty);

    post({ type: "create", cols: 100, rows: 30 });
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", {
      type: "created",
      session: expect.objectContaining({ id: 2, exited: false }),
    });
    expect(last(vi.mocked(pty.spawn).mock.calls)?.[2]).toMatchObject({ cols: 100, rows: 30 });

    post({ type: "input", id: 2, data: "ls\n" });
    post({ type: "input", id: 1, data: "pwd\n" });
    expect(second.write).toHaveBeenCalledWith("ls\n");
    expect(first.write).toHaveBeenCalledWith("pwd\n");
    expect(second.write).toHaveBeenCalledTimes(1);

    post({ type: "resize", id: 1, cols: 90, rows: 20 });
    expect(first.resize).toHaveBeenCalledWith(90, 20);
    expect(second.resize).not.toHaveBeenCalled();
  });

  it("tags output and exits with the session id, and keeps scrollback for a reloaded panel", () => {
    const proc = fakePty();
    const { post, webContents } = startShell(proc);
    const onData = proc.onData.mock.calls[0][0] as (d: string) => void;
    onData("hello");
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", { type: "data", id: 1, data: "hello" });

    webContents.send.mockClear();
    post({ type: "termReady", cols: 80, rows: 24 });
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", {
      type: "sessions",
      sessions: [expect.objectContaining({ id: 1, scrollback: "hello", exited: false })],
    });
    expect(pty.spawn).toHaveBeenCalledTimes(1); // a reload reattaches, it never respawns
  });

  it("stops at the terminal cap", () => {
    const { post } = startShell(fakePty());
    for (let i = 0; i < 20; i++) {
      vi.mocked(pty.spawn).mockReturnValue(fakePty() as unknown as pty.IPty);
      post({ type: "create", cols: 80, rows: 24 });
    }
    expect(vi.mocked(pty.spawn).mock.calls.length).toBe(MAX_TERMINALS);
  });

  it("closing one terminal ends only that shell and says so", async () => {
    const first = fakePty();
    const { post, webContents, service } = startShell(first);
    const second = fakePty((exit) => setTimeout(() => exit(0), 1));
    vi.mocked(pty.spawn).mockReturnValue(second as unknown as pty.IPty);
    post({ type: "create", cols: 80, rows: 24 });

    post({ type: "close", id: 2 });
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", { type: "closed", id: 2 });
    expect(second.kill).toHaveBeenCalledWith("SIGHUP");
    expect(first.kill).not.toHaveBeenCalled();
    // The closed shell is still reaped before quit may proceed.
    await service.shutdown();
    expect(webContents.send).not.toHaveBeenCalledWith("term:toWebview", { type: "exit", id: 2, code: 0 });
  });

  it("restarting an exited terminal reuses its id", () => {
    const first = fakePty();
    const { post, webContents } = startShell(first);
    first.exit(1);
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", { type: "exit", id: 1, code: 1 });
    vi.mocked(pty.spawn).mockReturnValue(fakePty() as unknown as pty.IPty);
    post({ type: "restart", id: 1 });
    expect(pty.spawn).toHaveBeenCalledTimes(2);
    expect(last(vi.mocked(pty.spawn).mock.calls)?.[1]).toEqual([]);
  });

  it("a restart request for a live terminal does nothing", () => {
    const { post } = startShell(fakePty());
    post({ type: "restart", id: 1 });
    expect(pty.spawn).toHaveBeenCalledTimes(1);
  });

  it("shutdown signals every live shell, concurrently", async () => {
    const a = fakePty((exit) => setTimeout(() => exit(0), 5));
    const { post, service } = startShell(a);
    const b = fakePty((exit) => setTimeout(() => exit(0), 5));
    vi.mocked(pty.spawn).mockReturnValue(b as unknown as pty.IPty);
    post({ type: "create", cols: 80, rows: 24 });
    expect(service.hasLiveShell()).toBe(true);

    await service.shutdown();

    expect(a.kill).toHaveBeenCalledWith("SIGHUP");
    expect(b.kill).toHaveBeenCalledWith("SIGHUP");
    expect(service.hasLiveShell()).toBe(false);
  });

  it("dispose kills every shell", () => {
    const a = fakePty();
    const { post, service } = startShell(a);
    const b = fakePty();
    vi.mocked(pty.spawn).mockReturnValue(b as unknown as pty.IPty);
    post({ type: "create", cols: 80, rows: 24 });
    service.dispose();
    expect(a.kill).toHaveBeenCalled();
    expect(b.kill).toHaveBeenCalled();
  });

  it("ignores messages from anything but the attached panel", () => {
    const { service } = startShell(fakePty());
    const calls = vi.mocked(ipcMain.on).mock.calls;
    (calls[calls.length - 1][1] as (e: unknown, r: unknown) => void)({ sender: {} }, { type: "create", cols: 80, rows: 24 });
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(service.hasLiveShell()).toBe(true);
  });
});

describe("TerminalService remote shells", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens `ssh -t <host>` in a NEW terminal and leaves the local shell running", async () => {
    const first = fakePty();
    const { service, webContents } = startShell(first);
    vi.mocked(pty.spawn).mockReturnValue(fakePty() as unknown as pty.IPty);

    await service.openRemote("me@buildbox");

    expect(first.kill).not.toHaveBeenCalled();
    const call = last(vi.mocked(pty.spawn).mock.calls);
    expect(call[0]).toBe("ssh");
    expect(call[1]).toEqual(["-t", "me@buildbox"]);
    expect(webContents.send).toHaveBeenCalledWith("term:toWebview", {
      type: "created",
      session: expect.objectContaining({ id: 2, title: "ssh me@buildbox" }),
    });
  });

  it("a remote requested before the panel is up becomes the first terminal", async () => {
    vi.mocked(pty.spawn).mockReturnValue(fakePty() as unknown as pty.IPty);
    const service = new TerminalService(() => undefined, () => undefined);
    const handler = last(vi.mocked(ipcMain.on).mock.calls)[1] as (e: unknown, r: unknown) => void;
    const webContents = { isDestroyed: () => false, send: vi.fn() };
    service.attach(webContents as never);
    await service.openRemote("buildbox");
    expect(pty.spawn).not.toHaveBeenCalled();

    handler({ sender: webContents }, { type: "termReady", cols: 80, rows: 24 });

    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pty.spawn).mock.calls[0][0]).toBe("ssh");
  });

  it("refuses a host that ssh would read as an option", async () => {
    const { service } = startShell(fakePty());
    vi.mocked(pty.spawn).mockClear();
    await service.openRemote("-oProxyCommand=evil");
    expect(pty.spawn).not.toHaveBeenCalled();
  });
});
