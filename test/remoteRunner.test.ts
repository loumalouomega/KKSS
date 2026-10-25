import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));
const { RemoteRunner } = await import("../app/main/services/workflows/remoteRunner");
import type { SshRunner } from "../app/main/services/cloud/providers/ssh";
import { launchCommand, remoteRunScript } from "../app/main/services/cloud/providerCore/sshCore";
import type { Task } from "../app/main/services/workflows/contracts";

const localSh: SshRunner = (_h, command, options = {}) =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const sink = options.stdoutFile ? fs.createWriteStream(options.stdoutFile) : undefined;
    if (sink) child.stdout.pipe(sink); else child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (options.stdinFile) fs.createReadStream(options.stdinFile).pipe(child.stdin); else child.stdin.end();
    child.on("close", (code) => { if (sink) sink.end(() => resolve({ code: code ?? 1, stdout, stderr })); else resolve({ code: code ?? 1, stdout, stderr }); });
  });
const wait = async (f: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await f()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error("timeout"); };

const task = { id: "t1", studyId: "s1", runId: "r1", kind: "solve" } as unknown as Task;
let remote: string, input: string, local: string;
const mk = (argv: string[], ssh: SshRunner = localSh) =>
  new RemoteRunner("h", ssh, () => ({ inputDir: input, remoteDir: path.join(remote, "run"), argv, localDir: local, root: local }), (ms) => new Promise((r) => setTimeout(r, ms)));

beforeEach(() => {
  remote = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-rr-remote-"));
  local = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-rr-local-"));
  input = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-rr-input-"));
  fs.writeFileSync(path.join(input, "a.txt"), "x");
});

describe("RemoteRunner", () => {
  it("launches, uploads inputs and reports a terminal receipt without claiming convergence", async () => {
    const r = mk(["sh", "-c", "cat a.txt"]);
    expect((await r.dispatch(task, {} as never)).state).toBe("running");
    await wait(async () => (await r.lookup(task, {} as never))?.state === "succeeded");
    expect(fs.readFileSync(path.join(remote, "run/stdout.log"), "utf8")).toBe("x");
    expect((await r.lookup(task, {} as never))?.message).toMatch(/convergence is not established/);
  });
  it("downloads checksum-verified outputs, skipping inputs, and retries after a failed download", async () => {
    const r = mk(["sh", "-c", "mkdir vtk_output && echo field > vtk_output/a.vtk"]);
    await r.dispatch(task, {} as never);
    await wait(async () => (await r.lookup(task, {} as never))?.state === "succeeded");
    const receipt = (await r.lookup(task, {} as never))!;
    expect(receipt.artifacts.map((a) => a.reference.path).sort()).toEqual(["stdout.log", "vtk_output/a.vtk"]);
    expect(receipt.artifacts.every((a) => a.ownerId === "r1")).toBe(true);
    expect(fs.readFileSync(path.join(local, "vtk_output/a.vtk"), "utf8")).toBe("field\n");
    expect(fs.existsSync(path.join(local, "a.txt"))).toBe(false);
    const flaky: SshRunner = (h, c, o) => c.startsWith("cat --") && c.includes("a.vtk") ? Promise.resolve({ code: 255, stdout: "", stderr: "reset" }) : localSh(h, c, o);
    fs.rmSync(path.join(local, "vtk_output"), { recursive: true });
    const broken = await mk(["true"], flaky).lookup(task, {} as never);
    expect(broken?.state).toBe("uncertain");
  });
  it("validates host python, Kratos import and thread count", async () => {
    const t = { ...task, args: { threads: 4096 } } as unknown as Task;
    const errors = await mk(["python3", "x"]).validate(t, {} as never);
    expect(errors.join()).toMatch(/threads|Kratos|unreachable/);
  });
  it("records a failing exit as failed", async () => {
    const r = mk(["sh", "-c", "exit 3"]);
    await r.dispatch(task, {} as never);
    await wait(async () => (await r.lookup(task, {} as never))?.state === "failed");
  });
  it("cancels the process group", async () => {
    const r = mk(["sleep", "30"]);
    await r.dispatch(task, {} as never);
    await wait(async () => (await r.lookup(task, {} as never))?.state === "running");
    expect((await r.cancel(task, {} as never)).state).toBe("cancelled");
  });
  it("throws (⇒ uncertain) when the launch outcome is unknown, but fails cleanly before it", async () => {
    const dropLaunch: SshRunner = (h, c, o) => c.includes("setsid") ? Promise.resolve({ code: 255, stdout: "", stderr: "connection reset" }) : localSh(h, c, o);
    await expect(mk(["true"], dropLaunch).dispatch(task, {} as never)).rejects.toThrow(/unknown/);
    const dropUpload: SshRunner = () => Promise.resolve({ code: 255, stdout: "", stderr: "denied" });
    expect((await mk(["true"], dropUpload).dispatch(task, {} as never)).state).toBe("failed");
  });
  it("rejects a receipt for another owner and reports a vanished process as uncertain", async () => {
    const r = mk(["true"]);
    fs.mkdirSync(path.join(remote, "run"), { recursive: true });
    fs.writeFileSync(path.join(remote, "run/receipt.json"), JSON.stringify({ version: 1, requestId: "t1", ownerId: "other", state: "running", pid: 99999999 }));
    await expect(r.lookup(task, {} as never)).rejects.toThrow(/does not match/);
    fs.writeFileSync(path.join(remote, "run/receipt.json"), JSON.stringify({ version: 1, requestId: "t1", ownerId: "s1", state: "running", pid: 4194303 }));
    expect((await r.lookup(task, {} as never))?.state).toBe("uncertain");
  });
});

describe("remote script builders", () => {
  it("refuses unsafe ids and env names, and quotes the launch directory", () => {
    expect(() => remoteRunScript({ dir: "d", requestId: "a'b", ownerId: "o", argv: ["x"] })).toThrow();
    expect(() => remoteRunScript({ dir: "d", requestId: "a", ownerId: "o", argv: ["x"], env: { "A;B": "1" } })).toThrow();
    expect(launchCommand("a b'c")).toContain(`'a b'\\''c'`);
  });
});

describe("remoteRunScript with a relative run directory", () => {
  it("writes the log and terminal receipt under the run directory, not under input/", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-relrun-"));
    try {
      fs.mkdirSync(path.join(home, "kkss-runs/r1/input"), { recursive: true });
      fs.writeFileSync(path.join(home, "kkss-runs/r1/run.sh"), remoteRunScript({ dir: "kkss-runs/r1", requestId: "q", ownerId: "o", argv: ["true"] }));
      const run = spawnSync("sh", ["kkss-runs/r1/run.sh"], { cwd: home });
      expect(run.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(path.join(home, "kkss-runs/r1/receipt.json"), "utf8")).state).toBe("succeeded");
      expect(fs.existsSync(path.join(home, "kkss-runs/r1/stdout.log"))).toBe(true);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
