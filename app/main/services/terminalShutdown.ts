/**
 * Ends the embedded terminal's shell during quit. Electron-free: terminal.ts
 * supplies the node-pty handle and the platform, and this module owns the
 * signals and the bounded waits.
 *
 * Quit has to observe the shell's exit before Electron tears down, because
 * node-pty reports exits from a native callback with no exception guard (see
 * terminal.ts). Both waits are bounded so a stuck shell can delay quit but
 * never block it.
 */

/** How long a shell gets to exit after SIGHUP before it is killed. */
export const SHELL_GRACE_MS = 1500;
/** How long a SIGKILL'd shell gets to be reaped before quit goes on anyway. */
export const SHELL_KILL_MS = 1000;

export interface ShellHandle {
  /** POSIX signal. Windows has no signals, so there `kill()` is called bare. */
  kill(signal?: "SIGHUP" | "SIGKILL"): void;
  /** Settles once the shell's exit has been observed. Never rejects. */
  readonly exited: Promise<void>;
}

/** Resolves `true` if `exited` settles within `ms`, `false` otherwise. */
function within(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Asks the shell to exit and waits, boundedly. Resolves `true` once the exit
 * has been observed, `false` if even SIGKILL left it unreaped. Never rejects.
 */
export async function endShell(
  shell: ShellHandle,
  platform: NodeJS.Platform,
  { graceMs = SHELL_GRACE_MS, killMs = SHELL_KILL_MS } = {}
): Promise<boolean> {
  if (platform === "win32") {
    shell.kill();
    return within(shell.exited, graceMs);
  }
  shell.kill("SIGHUP");
  if (await within(shell.exited, graceMs)) return true;
  shell.kill("SIGKILL");
  return within(shell.exited, killMs);
}
