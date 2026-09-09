import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KratosRuntime, RuntimeFailure, UV_VERSION, classifyStartupFailure, runRuntimeCommand } from "../app/main/services/chat/kratosRuntime";
import type { RuntimeDeps } from "../app/main/services/chat/kratosRuntime";
import { kratosStatusView } from "../app/renderer/chat/serverStatus";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
const missing = () => Object.assign(new Error("not found"), { code: "ENOENT" });
const signal = () => new AbortController().signal;
async function harness(platform: NodeJS.Platform = "linux") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kkss runtime spaces "));
  dirs.push(dir);
  const run = vi.fn<RuntimeDeps["run"]>().mockResolvedValue(`uv ${UV_VERSION}`);
  const download = vi.fn<RuntimeDeps["download"]>().mockResolvedValue("official installer");
  return { dir, run, download, runtime: new KratosRuntime(dir, platform, { run, download }) };
}

describe("Kratos runtime discovery", () => {
  it("prefers the app runtime, then uvx, then uv tool run", async () => {
    const { runtime, run } = await harness();
    expect(await runtime.discover(signal())).toEqual({ command: path.join(runtime.directory, "uv"), args: ["tool", "run"] });
    run.mockRejectedValueOnce(missing());
    expect(await runtime.discover(signal())).toEqual({ command: "uvx", args: [] });
    run.mockRejectedValueOnce(missing()).mockRejectedValueOnce(missing());
    expect(await runtime.discover(signal())).toEqual({ command: "uv", args: ["tool", "run"] });
  });
  it("separates missing from unusable executables and never installs on discovery", async () => {
    const { runtime, run, download } = await harness();
    run.mockRejectedValue(missing());
    await expect(runtime.discover(signal())).rejects.toMatchObject({ failure: "missing-runtime" });
    run.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(runtime.discover(signal())).rejects.toMatchObject({ failure: "runtime" });
    expect(download).not.toHaveBeenCalled();
  });
  it("rejects executables with an unexpected version response", async () => {
    const { runtime, run } = await harness();
    run.mockResolvedValue("not uv");
    await expect(runtime.discover(signal())).rejects.toMatchObject({ failure: "runtime" });
  });
});

describe("app-local installer", () => {
  it.each(["linux", "darwin", "win32"] as const)("uses fixed arguments and verifies before promotion on %s", async (platform) => {
    const { runtime, run, download } = await harness(platform);
    run.mockImplementation(async (_command, args, options) => {
      if (args[0] !== "--version") {
        const bin = options.env!.UV_UNMANAGED_INSTALL!;
        expect(options.env!.UV_NO_MODIFY_PATH).toBe("1");
        await fs.mkdir(bin);
        await fs.writeFile(path.join(bin, platform === "win32" ? "uv.exe" : "uv"), "binary");
      }
      return `uv ${UV_VERSION}`;
    });
    await runtime.install(signal());
    expect(download.mock.calls[0][0]).toBe(`https://astral.sh/uv/${UV_VERSION}/install.${platform === "win32" ? "ps1" : "sh"}`);
    expect(run.mock.calls[0][0]).toBe(platform === "win32" ? "powershell.exe" : "sh");
    expect(run.mock.calls[0][1][run.mock.calls[0][1].length - 1]).toContain("runtime spaces");
    expect(await fs.readdir(path.dirname(runtime.directory))).toEqual(["uv"]);
    expect(await fs.readFile(path.join(runtime.directory, platform === "win32" ? "uv.exe" : "uv"), "utf8")).toBe("binary");
  });
  it.each(["download", "execution", "verification", "timeout"])("cleans staging and preserves existing runtime on %s failure", async (stage) => {
    const { runtime, run, download } = await harness();
    await fs.mkdir(runtime.directory, { recursive: true });
    await fs.writeFile(path.join(runtime.directory, "uv"), "original");
    if (stage === "download") download.mockRejectedValue(new Error("failed to download"));
    else if (stage === "verification") run.mockResolvedValueOnce("installed").mockRejectedValueOnce(new Error("bad binary"));
    else run.mockRejectedValue(stage === "timeout" ? new RuntimeFailure("timeout", "timed out") : new Error("installer failed"));
    await expect(runtime.install(signal())).rejects.toThrow();
    expect(await fs.readdir(path.dirname(runtime.directory))).toEqual(["uv"]);
    expect(await fs.readFile(path.join(runtime.directory, "uv"), "utf8")).toBe("original");
  });
  it("aborts without promoting a runtime", async () => {
    const { runtime, download } = await harness();
    const abort = new AbortController();
    download.mockImplementation(async () => { abort.abort(); return "script"; });
    await expect(runtime.install(abort.signal)).rejects.toThrow();
    expect(await fs.readdir(path.dirname(runtime.directory))).toEqual([]);
  });
});

describe("bounded subprocesses", () => {
  it("terminates a timed-out child and preserves arguments with spaces", async () => {
    expect(await runRuntimeCommand(process.execPath, ["-e", "console.log(process.argv[1])", "a path with spaces"], { signal: signal(), timeout: 5000 })).toBe("a path with spaces");
    await expect(runRuntimeCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: signal(), timeout: 30 })).rejects.toMatchObject({ failure: "timeout" });
  });
  it("terminates on cancellation", async () => {
    const abort = new AbortController();
    const pending = runRuntimeCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: abort.signal, timeout: 5000 });
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});

describe("failure reporting", () => {
  it.each([
    ["EAI_AGAIN", "network"], ["No solution found", "package"], ["request timed out", "timeout"],
    ["ENOEXEC", "runtime"], ["unexpected exit", "unknown"],
  ])("classifies %s conservatively", (message, category) => {
    expect(classifyStartupFailure(new Error(message)).failure).toBe(category);
  });
  it("prioritizes a final Python dependency error over earlier download warnings", () => {
    expect(classifyStartupFailure(new Error("connection closed"),
      "failed to download on first attempt\nModuleNotFoundError: mcp.server.fastmcp").failure).toBe("package");
  });
  it("shows install only for runtime failures, retry for other failures, and hides ready status", () => {
    const base = { key: "kratos" as const, name: "Kratos", state: "unavailable" as const };
    expect(kratosStatusView([{ ...base, failure: "missing-runtime" }])?.action).toBe("installKratosRuntime");
    expect(kratosStatusView([{ ...base, failure: "unknown" }])).toMatchObject({ action: "retryKratos", text: expect.stringContaining("unavailable") });
    expect(kratosStatusView([{ ...base, state: "starting", phase: "installing" }])).toEqual({ action: null, text: "Installing uv for KKSS…" });
    expect(kratosStatusView([{ ...base, state: "ready" }])).toBeNull();
  });
});
