import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePins, planInstall, solverPins, solverVersion, SolverRuntimeInstaller, type SolverInstallDeps } from "../app/main/services/workflows/solverRuntime";
import type { RuntimeReport } from "../app/main/services/workflows/environment";

const REQ = `# Python 3.12
kratos-mcp-server==0.9.0
mcp<2
KratosMultiphysics==10.4.3
KratosStructuralMechanicsApplication==10.4.3  # trailing comment
-r other.txt
`;

const report = (available: boolean): RuntimeReport => ({
  applications: [{ name: "KratosMultiphysics", available }, { name: "KratosMultiphysics.RANSApplication", available, ...(available ? {} : { reason: "boom" }) }],
  available, modes: [], capabilities: { threads: true, mpi: false },
  ...(available ? {} : { reason: "Install the missing applications." }),
});

describe("requirement pins", () => {
  it("keeps exact pins and drops comments, ranges and options", () => {
    expect(parsePins(REQ).map((p) => `${p.name}==${p.version}`)).toEqual([
      "kratos-mcp-server==0.9.0", "KratosMultiphysics==10.4.3", "KratosStructuralMechanicsApplication==10.4.3"]);
  });
  it("excludes the MCP server from the solver and names the version after the core package", () => {
    const pins = solverPins(REQ);
    expect(pins.map((p) => p.name)).toEqual(["KratosMultiphysics", "KratosStructuralMechanicsApplication"]);
    expect(solverVersion(pins)).toBe("10.4.3");
    expect(solverVersion([])).toBeUndefined();
  });
  it("parses the repository's own requirements.in", () => {
    const real = fs.readFileSync(path.join(__dirname, "..", "docker", "kratos", "requirements.in"), "utf8");
    const pins = solverPins(real);
    expect(solverVersion(pins)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.some((p) => p.name === "KratosRANSApplication")).toBe(true);
    expect(pins.some((p) => /mcp/i.test(p.name))).toBe(false);
  });
});

describe("install plan", () => {
  const pins = solverPins(REQ);
  it("uses the hash lock only on x64 Linux, where it was compiled", () => {
    const p = planInstall("linux", "x64", "/a/requirements.lock", pins);
    expect(p.mode).toBe("hash-locked");
    expect(p.args).toContain("--require-hashes");
    expect(p.generated).toBeUndefined();
  });
  it("installs plain pins elsewhere and says hashes are not verified", () => {
    for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["linux", "arm64"]] as const) {
      const p = planInstall(platform, arch, "/a/requirements.lock", pins);
      expect(p.mode).toBe("pinned");
      expect(p.args).not.toContain("--require-hashes");
      expect(p.generated?.text).toBe("KratosMultiphysics==10.4.3\nKratosStructuralMechanicsApplication==10.4.3\n");
      expect(p.note).toMatch(/not verified/);
    }
  });
  it("falls back to pins when the lock is absent", () => {
    expect(planInstall("linux", "x64", undefined, pins).mode).toBe("pinned");
  });
});

describe("SolverRuntimeInstaller", () => {
  let dir: string, assets: string, userData: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-solver-"));
    assets = path.join(dir, "assets"); userData = path.join(dir, "userData");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "requirements.in"), REQ);
    fs.writeFileSync(path.join(assets, "requirements.lock"), "# lock\n");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (over: Partial<SolverInstallDeps> & { calls?: string[][] } = {}, platform: NodeJS.Platform = "linux", arch = "x64") => {
    const calls = over.calls ?? [];
    const deps: SolverInstallDeps = {
      run: async (_cmd, args) => {
        calls.push(args);
        if (args[0] === "venv") { const py = path.join(args[args.length - 1], "bin", "python"); fs.mkdirSync(path.dirname(py), { recursive: true }); fs.writeFileSync(py, ""); }
        return "";
      },
      probe: async () => report(true),
      readText: (f) => fs.promises.readFile(f, "utf8"),
      ...over,
    };
    return { installer: new SolverRuntimeInstaller(userData, assets, platform, arch, deps), calls };
  };
  const signal = () => new AbortController().signal;

  it("creates the venv, installs the lock with hashes, verifies, and reports the interpreter", async () => {
    const { installer, calls } = make();
    const r = await installer.install("uv", signal());
    const directory = path.join(userData, "runtimes", "kratos-10.4.3");
    expect(r).toMatchObject({ directory, python: path.join(directory, "bin", "python"), version: "10.4.3", mode: "hash-locked", reused: false });
    expect(calls[0]).toEqual(["venv", "--python", "3.12", directory]);
    expect(calls[1].slice(0, 4)).toEqual(["pip", "install", "--python", r.python]);
    expect(calls[1]).toContain("--require-hashes");
  });
  it("writes a pinned requirements file on other platforms", async () => {
    const { installer, calls } = make({}, "darwin", "arm64");
    const r = await installer.install("uv", signal());
    expect(r.mode).toBe("pinned");
    const file = path.join(userData, "runtimes", "kratos-10.4.3", "requirements-solver.txt");
    expect(calls[1]).toContain(file);
    expect(fs.readFileSync(file, "utf8")).toContain("KratosMultiphysics==10.4.3");
  });
  it("removes everything it made when verification fails", async () => {
    const { installer } = make({ probe: async () => report(false) });
    await expect(installer.install("uv", signal())).rejects.toThrow(/failed verification.*RANSApplication/);
    expect(fs.existsSync(path.join(userData, "runtimes", "kratos-10.4.3"))).toBe(false);
  });
  it("removes everything when the installer command fails", async () => {
    const { installer } = make({ run: async (_c, args) => { if (args[0] === "pip") throw new Error("network down"); fs.mkdirSync(args[args.length - 1], { recursive: true }); return ""; } });
    await expect(installer.install("uv", signal())).rejects.toThrow(/network down/);
    expect(fs.existsSync(path.join(userData, "runtimes", "kratos-10.4.3"))).toBe(false);
  });
  it("reuses a verified runtime without downloading or upgrading", async () => {
    const first = make();
    await first.installer.install("uv", signal());
    const second = make();
    const r = await second.installer.install("uv", signal());
    expect(r).toMatchObject({ reused: true, mode: "existing" });
    expect(second.calls).toEqual([]);
  });
  it("rebuilds an earlier attempt that no longer verifies", async () => {
    const first = make();
    await first.installer.install("uv", signal());
    let probes = 0;
    const second = make({ probe: async () => report(probes++ > 0) });
    const r = await second.installer.install("uv", signal());
    expect(r.reused).toBe(false);
    expect(second.calls[0][0]).toBe("venv");
  });
  it("refuses a build without the pinned requirements", async () => {
    fs.rmSync(path.join(assets, "requirements.in"));
    const { installer } = make();
    await expect(installer.install("uv", signal())).rejects.toThrow(/requirements are missing/);
  });
  it("joins a second call instead of racing it", async () => {
    let venvs = 0;
    const { installer } = make({ run: async (_c, args) => { if (args[0] === "venv") { venvs++; const py = path.join(args[args.length - 1], "bin", "python"); fs.mkdirSync(path.dirname(py), { recursive: true }); fs.writeFileSync(py, ""); } await new Promise((r) => setTimeout(r, 10)); return ""; } });
    const [a, b] = await Promise.all([installer.install("uv", signal()), installer.install("uv", signal())]);
    expect(a).toBe(b);
    expect(venvs).toBe(1);
  });
});
