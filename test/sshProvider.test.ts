/**
 * The ssh provider against a runner that executes the generated remote command
 * with a local `sh -c` — so the real quoting, `ls`, `stat`, `cat`, and the
 * temp-file-plus-rename upload are all exercised, not mocked.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));

const { SshProvider, classifySshFailure } = await import("../app/main/services/cloud/providers/ssh");
import type { SshRunner } from "../app/main/services/cloud/providers/ssh";

const localSh: SshRunner = (_host, command, options = {}) =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const sink = options.stdoutFile ? fs.createWriteStream(options.stdoutFile) : undefined;
    child.stderr.on("data", (d) => (stderr += d));
    if (sink) child.stdout.pipe(sink);
    else child.stdout.on("data", (d) => (stdout += d));
    if (options.stdinFile) fs.createReadStream(options.stdinFile).pipe(child.stdin);
    else child.stdin.end();
    child.on("close", (code) => {
      if (sink) sink.end(() => resolve({ code: code ?? 1, stdout, stderr }));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });

let remote: string;
let local: string;
beforeEach(() => {
  remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kkss-ssh-remote-")));
  local = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-ssh-local-"));
});
afterEach(() => {
  fs.rmSync(remote, { recursive: true, force: true });
  fs.rmSync(local, { recursive: true, force: true });
});

describe("SshProvider", () => {
  it("lists a directory with folders first and stats a file with a mtime:size revision", async () => {
    fs.mkdirSync(path.join(remote, "sub dir"));
    fs.writeFileSync(path.join(remote, "it's.mdpa"), "12345");
    const provider = new SshProvider(localSh);
    const { files } = await provider.list(`box:${remote}`);
    expect(files.map((f) => f.name)).toEqual(["sub dir", "it's.mdpa"]);
    const stat = await provider.stat(files[1].id);
    expect(stat).toMatchObject({ name: "it's.mdpa", size: 5, isFolder: false });
    expect(stat.rev).toMatch(/^\d+:5$/);
    expect(stat.parentId).toBe(`box:${remote}`);
  });

  it("downloads bytes exactly and finds children (or reports them absent)", async () => {
    fs.writeFileSync(path.join(remote, "a.vtk"), Buffer.from([0, 1, 2, 255]));
    const provider = new SshProvider(localSh);
    const file = await provider.findChild(`box:${remote}`, "a.vtk");
    expect(file).toBeDefined();
    const dest = path.join(local, "a.vtk");
    await provider.download(file!, dest);
    expect([...fs.readFileSync(dest)]).toEqual([0, 1, 2, 255]);
    expect(await provider.findChild(`box:${remote}`, "missing.vtk")).toBeUndefined();
  });

  it("uploads atomically, keeps the file mode, and leaves no temp file behind", async () => {
    const target = path.join(remote, "m.mdpa");
    fs.writeFileSync(target, "old");
    fs.chmodSync(target, 0o640);
    const src = path.join(local, "m.mdpa");
    fs.writeFileSync(src, "brand new contents");
    const provider = new SshProvider(localSh);
    const written = await provider.upload(`box:${target}`, src);
    expect(fs.readFileSync(target, "utf8")).toBe("brand new contents");
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(remote)).toEqual(["m.mdpa"]);
    expect(written.size).toBe(18);
  });

  it("creates new children and idempotent folders", async () => {
    const src = path.join(local, "x.json");
    fs.writeFileSync(src, "{}");
    const provider = new SshProvider(localSh);
    const created = await provider.create(`box:${remote}`, "m.mdpa.parts.json", src);
    expect(created.name).toBe("m.mdpa.parts.json");
    const folder = await provider.ensureFolder(`box:${remote}`, "constant");
    expect(folder.isFolder).toBe(true);
    expect((await provider.ensureFolder(`box:${remote}`, "constant")).id).toBe(folder.id);
    await expect(provider.ensureFolder(`box:${remote}`, "m.mdpa.parts.json")).rejects.toMatchObject({ kind: "conflict" });
  });

  it("names a failure by what ssh said", async () => {
    const failing: SshRunner = async () => ({ code: 255, stdout: "", stderr: "me@box: Permission denied (publickey)." });
    await expect(new SshProvider(failing).stat("box:/x")).rejects.toMatchObject({ kind: "auth" });
    expect(classifySshFailure("ssh: Could not resolve hostname nope")).toBe("network");
    expect(classifySshFailure("ls: cannot access: No such file or directory")).toBe("notFound");
  });
});
