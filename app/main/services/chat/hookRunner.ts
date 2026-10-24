/**
 * Runs one hook command: JSON on stdin, exit code + bounded output back.
 *
 * Shaped after `kratosRuntime.runRuntimeCommand` (detached process group, the
 * whole tree killed on timeout/abort, capped output) with two differences a hook
 * needs: it **resolves** with the exit code instead of rejecting on non-zero —
 * the exit code *is* the answer — and it keeps a set of live children so
 * `killAll()` can stop them without a signal.
 *
 * `killAll()` exists because `ChatService.flushSync()` runs at `will-quit`
 * *before* the abort listener fires, and `settleTurn()` awaits the turn: a hook
 * that outlived the app, or one a Stop could not interrupt, would hang quit.
 *
 * The command is spawned directly (never through a shell) with the environment
 * the caller passes — `hooksStore.ts` gives it the MCP SDK's minimal one, not
 * `process.env`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { HOOK_OUTPUT_CHARS, type HookRunResult } from "./hooks";

export interface HookRunSpec {
  command: string;
  args: string[];
  timeoutMs: number;
}

export interface HookRunOptions {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

/** The seam `HookEngine` takes, so tests can substitute a fake. */
export interface HookExecutor {
  run(spec: HookRunSpec, stdin: string, options: HookRunOptions): Promise<HookRunResult>;
  killAll(): void;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

export class HookRunner implements HookExecutor {
  private readonly live = new Set<ChildProcess>();
  /** Children `killAll()` stopped, so their result reads as cancelled, not as a crash. */
  private readonly shutDown = new WeakSet<ChildProcess>();

  run(spec: HookRunSpec, stdin: string, options: HookRunOptions): Promise<HookRunResult> {
    return new Promise((resolve) => {
      const result: HookRunResult = { code: null, stdout: "", stderr: "", timedOut: false, aborted: false };
      if (options.signal?.aborted) { resolve({ ...result, aborted: true }); return; }
      let child: ChildProcess;
      try {
        child = spawn(spec.command, spec.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        resolve({ ...result, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      this.live.add(child);
      let settled = false;
      const finish = (patch: Partial<HookRunResult>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.live.delete(child);
        resolve({ ...result, ...patch, aborted: result.aborted || this.shutDown.has(child) });
      };
      const collect = (key: "stdout" | "stderr") => (data: Buffer): void => {
        if (result[key].length < HOOK_OUTPUT_CHARS) result[key] = (result[key] + data.toString()).slice(0, HOOK_OUTPUT_CHARS);
      };
      child.stdout?.on("data", collect("stdout"));
      child.stderr?.on("data", collect("stderr"));
      const onAbort = (): void => { result.aborted = true; killTree(child); };
      const timer = setTimeout(() => { result.timedOut = true; killTree(child); }, spec.timeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => finish({ error: error.message }));
      child.once("close", (code) => finish({ code }));
      // A hook that never reads its input closes the pipe early; that is its right.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
    });
  }

  killAll(): void {
    for (const child of this.live) {
      this.shutDown.add(child);
      killTree(child);
    }
  }
}
