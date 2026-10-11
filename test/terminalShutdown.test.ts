import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_GRACE_MS, SHELL_KILL_MS, endShell } from "../app/main/services/terminalShutdown";

/** A shell that exits the moment `exitsOn` says a signal reached it. */
function fakeShell(exitsOn: (signal: string | undefined) => boolean) {
  let markExited = (): void => undefined;
  const exited = new Promise<void>((resolve) => {
    markExited = () => resolve();
  });
  const kill = vi.fn((signal?: "SIGHUP" | "SIGKILL") => {
    if (exitsOn(signal)) markExited();
  });
  return { kill, exited };
}

describe("endShell", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends SIGHUP only and resolves once the exit is observed", async () => {
    const shell = fakeShell((signal) => signal === "SIGHUP");
    const done = endShell(shell, "linux");
    expect(await done).toBe(true);
    expect(shell.kill.mock.calls).toEqual([["SIGHUP"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("escalates to SIGKILL only after the grace period runs out", async () => {
    const shell = fakeShell((signal) => signal === "SIGKILL");
    const done = endShell(shell, "linux");
    await vi.advanceTimersByTimeAsync(SHELL_GRACE_MS - 1);
    expect(shell.kill.mock.calls).toEqual([["SIGHUP"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toBe(true);
    expect(shell.kill.mock.calls).toEqual([["SIGHUP"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up after the SIGKILL window and leaves no timer behind", async () => {
    const shell = fakeShell(() => false);
    const done = endShell(shell, "linux");
    await vi.advanceTimersByTimeAsync(SHELL_GRACE_MS + SHELL_KILL_MS);
    expect(await done).toBe(false);
    expect(shell.kill.mock.calls).toEqual([["SIGHUP"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("on Windows calls kill() with no signal and never escalates", async () => {
    const shell = fakeShell(() => false);
    const done = endShell(shell, "win32");
    await vi.advanceTimersByTimeAsync(SHELL_GRACE_MS + SHELL_KILL_MS);
    expect(await done).toBe(false);
    expect(shell.kill.mock.calls).toEqual([[]]);
  });

  it("accepts an explicit grace period for callers with their own budget", async () => {
    const shell = fakeShell(() => false);
    const done = endShell(shell, "linux", { graceMs: 10, killMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    expect(await done).toBe(false);
    expect(shell.kill.mock.calls).toEqual([["SIGHUP"], ["SIGKILL"]]);
  });
});
