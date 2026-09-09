/** App-local uv bootstrap. No installation occurs during discovery. */
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatServerStatus } from "../../ipc";

export const UV_VERSION = "0.12.10";
export type StartupFailure = NonNullable<ChatServerStatus["failure"]>;
export class RuntimeFailure extends Error {
  constructor(public readonly failure: StartupFailure, message: string) { super(message); }
}
export interface RuntimeCommand { command: string; args: string[] }
export interface RuntimeDeps {
  run(command: string, args: string[], options: { signal: AbortSignal; timeout: number; env?: NodeJS.ProcessEnv }): Promise<string>;
  download(url: string, signal: AbortSignal): Promise<string>;
}

/** Bounded diagnostics, with process-tree termination for installer children. */
export function runRuntimeCommand(command: string, args: string[], options: {
  signal: AbortSignal; timeout: number; env?: NodeJS.ProcessEnv;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = spawn(command, args, {
      env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, detached: process.platform !== "win32",
    });
    let output = "";
    let failure: Error | undefined;
    const collect = (data: Buffer) => { output = (output + data.toString()).slice(-8192); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const stop = (error: Error) => {
      failure = error;
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => child.kill());
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const abort = () => stop(new Error("Kratos setup cancelled."));
    const timer = setTimeout(() => stop(new RuntimeFailure("timeout", "Kratos setup timed out. Retry when the network is available.")), options.timeout);
    options.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener("abort", abort); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}: ${output}`));
      else resolve(output.trim());
    });
    if (options.signal.aborted) abort();
  });
}

export function classifyStartupFailure(error: unknown, stderr = ""): RuntimeFailure {
  if (error instanceof RuntimeFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  const detail = `${message}\n${stderr}`.slice(-8192);
  if (/EACCES|EPERM|ENOEXEC/.test(detail)) return new RuntimeFailure("runtime", "The uv executable could not run. Check its permissions or reinstall uv.");
  if (/no solution found|no matching distribution|could not find a version|not found in the package registry|requires-python|ModuleNotFoundError|ImportError/i.test(detail)) {
    return new RuntimeFailure("package", `The Kratos package could not be resolved. ${detail.slice(-600)}`);
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|certificate verify failed|failed to (?:download|fetch)|dns error|network is unreachable/i.test(detail)) {
    return new RuntimeFailure("network", `Kratos setup could not reach its download service. ${detail.slice(-600)}`);
  }
  if (/timed?\s*out|timeout/i.test(detail)) return new RuntimeFailure("timeout", "Kratos startup timed out. Check your connection and retry.");
  return new RuntimeFailure("unknown", `Kratos startup failed: ${detail.trim().slice(-600)}`);
}

export class KratosRuntime {
  readonly directory: string;
  constructor(userData: string, private readonly platform = process.platform, private readonly deps: RuntimeDeps = {
    run: runRuntimeCommand,
    download: async (url, signal) => {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
      if (!response.ok) throw new RuntimeFailure("network", `uv installer download failed (HTTP ${response.status}).`);
      const text = await response.text();
      if (text.length > 2_000_000) throw new RuntimeFailure("installation", "uv installer exceeded the download size limit.");
      return text;
    },
  }) {
    this.directory = path.join(userData, "runtimes", "uv");
  }

  private async probe(command: string, signal: AbortSignal): Promise<void> {
    const version = await this.deps.run(command, ["--version"], { signal, timeout: 5000 });
    if (!/^uv(?:x)?\s+\d+\./m.test(version)) throw new RuntimeFailure("runtime", "The uv executable returned an unexpected version response.");
  }

  async discover(signal: AbortSignal): Promise<RuntimeCommand> {
    const exe = this.platform === "win32" ? ".exe" : "";
    const candidates = [
      { command: path.join(this.directory, `uv${exe}`), args: ["tool", "run"] },
      { command: `uvx${exe}`, args: [] },
      { command: `uv${exe}`, args: ["tool", "run"] },
    ];
    let broken: unknown;
    for (const candidate of candidates) {
      signal.throwIfAborted();
      try { await this.probe(candidate.command, signal); return candidate; }
      catch (error) {
        signal.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") broken = error;
      }
    }
    if (broken) throw new RuntimeFailure("runtime", `uv was found but could not run: ${String(broken).slice(-400)}`);
    throw new RuntimeFailure("missing-runtime", "uv is not installed or is not on PATH. Install uv for KKSS to enable Kratos tools.");
  }

  async install(signal: AbortSignal): Promise<void> {
    const parent = path.dirname(this.directory);
    await fs.mkdir(parent, { recursive: true });
    const staging = await fs.mkdtemp(path.join(parent, "uv-install-"));
    try {
      const windows = this.platform === "win32";
      const filename = windows ? "install.ps1" : "install.sh";
      const script = path.join(staging, filename);
      const destination = path.join(staging, "bin");
      const text = await this.deps.download(`https://astral.sh/uv/${UV_VERSION}/${filename}`, signal);
      signal.throwIfAborted();
      await fs.writeFile(script, text);
      await this.deps.run(windows ? "powershell.exe" : "sh", windows
        ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
        : [script], {
        signal, timeout: 5 * 60_000,
        env: { ...process.env, UV_UNMANAGED_INSTALL: destination, UV_NO_MODIFY_PATH: "1" },
      });
      await this.probe(path.join(destination, windows ? "uv.exe" : "uv"), signal);
      signal.throwIfAborted();
      // The installer never touches a working runtime; promotion happens only
      // after verification. Preserve any previous directory if promotion fails.
      const backup = path.join(staging, "previous");
      let saved = false;
      try { await fs.rename(this.directory, backup); saved = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await fs.rename(destination, this.directory); }
      catch (error) { if (saved) await fs.rename(backup, this.directory); throw error; }
    } catch (error) {
      if (signal.aborted) throw error;
      const classified = classifyStartupFailure(error);
      throw classified.failure === "unknown" ? new RuntimeFailure("installation", classified.message) : classified;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
}
