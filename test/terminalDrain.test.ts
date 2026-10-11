/**
 * TerminalService.drain(): quit must not finish while a shell's exit is still
 * undelivered, or node-pty's native exit callback can run into a torn-down
 * environment and abort the process. These pin the wait, the SIGKILL escalation
 * and the no-op case, against a fake pty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pty from "node-pty";
import { electronStub } from "./stubs/electron";
import { TerminalService } from "../app/main/services/terminal";

vi.mock("electron", async () => {
  const { electronStub } = await import("./stubs/electron");
  return { app: electronStub.app, ipcMain: electronStub.ipcMain };
});

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

vi.mock("../app/main/services/stateStore", () => ({
  stateStore: { get: () => undefined },
}));

/** A pty whose exit the test controls. `onExit` listeners fire on `exit()`. */
function fakePty() {
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  const proc = {
    onData: vi.fn(),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.push(listener);
      return { dispose() {} };
    }),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  };
  return { proc, exit: () => exitListeners.forEach((listener) => listener({ exitCode: 0 })) };
}

/** Attaches a panel and spawns a shell the way the renderer's termReady does. */
function spawnShell(service: TerminalService, proc: ReturnType<typeof fakePty>["proc"]) {
  vi.mocked(pty.spawn).mockReturnValue(proc as never);
  const panel = { isDestroyed: () => false, send: vi.fn() };
  service.attach(panel as never);
  electronStub.post("term:toHost", panel, { type: "termReady", cols: 80, rows: 24 });
  return panel;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.mocked(pty.spawn).mockReset();
});

describe("TerminalService.drain", () => {
  it("is a no-op when no shell is running", async () => {
    const service = new TerminalService(() => undefined, () => undefined);
    expect(service.hasLiveShell()).toBe(false);
    await expect(service.drain()).resolves.toBeUndefined();
  });

  it("waits for the shell's exit before resolving, then reports no live shell", async () => {
    const service = new TerminalService(() => undefined, () => undefined);
    const { proc, exit } = fakePty();
    spawnShell(service, proc);
    expect(service.hasLiveShell()).toBe(true);

    let drained = false;
    const draining = service.drain().then(() => { drained = true; });
    await tick();
    expect(proc.kill).toHaveBeenCalledWith();
    expect(drained).toBe(false); // the exit has not been delivered yet

    exit();
    await draining;
    expect(drained).toBe(true);
    expect(service.hasLiveShell()).toBe(false);
  });

  it("escalates to SIGKILL when a shell ignores SIGHUP, and still resolves", async () => {
    const service = new TerminalService(() => undefined, () => undefined);
    const { proc, exit } = fakePty();
    spawnShell(service, proc);

    const draining = service.drain(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(proc.kill).toHaveBeenNthCalledWith(1);
    expect(proc.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    exit();
    await draining;
    expect(service.hasLiveShell()).toBe(false);
  });
});
