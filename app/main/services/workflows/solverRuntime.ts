/**
 * App-managed Kratos solver runtime (roadmap item 18). A user-initiated install
 * creates `<userData>/runtimes/kratos-<version>`, a uv virtual environment built
 * from the same pinned requirements the `-kratos` Docker image uses, verifies the
 * applications the environment probe checks, and only then lets the caller point
 * `kratos.pythonPath` at it. The bootstrap's rules hold: nothing on PATH or in a
 * shell profile changes, no administrator rights, no automatic upgrades, and a
 * failed install removes what it made and leaves every setting untouched.
 *
 * The pure half (requirement parsing, the install plan) is here too so it can be
 * tested without a network; every effect goes through `SolverInstallDeps`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RuntimeFailure, runRuntimeCommand } from "../chat/kratosRuntime";
import { probePython, type RuntimeReport } from "./environment";
import { externalProcessEnv } from "../childEnv";

/** The applications the probe imports after an install; the Dockerfile's import check names the same set. */
export const SOLVER_APPLICATIONS: readonly string[] = [
  "KratosMultiphysics",
  "KratosMultiphysics.StructuralMechanicsApplication",
  "KratosMultiphysics.FluidDynamicsApplication",
  "KratosMultiphysics.ConvectionDiffusionApplication",
  "KratosMultiphysics.CompressiblePotentialFlowApplication",
  "KratosMultiphysics.ShallowWaterApplication",
  "KratosMultiphysics.RANSApplication",
  "KratosMultiphysics.LinearSolversApplication",
];

export const SOLVER_PYTHON = "3.12";
/** Only these are the solver; the MCP server and its client library belong to the assistant's own runtime. */
const NOT_SOLVER = new Set(["kratos-mcp-server", "mcp"]);

/** `name==version` pins of a requirements.in; comments, blanks, options and ranges are dropped. */
export function parsePins(text: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9.+!_-]*)$/.exec(line);
    if (m) out.push({ name: m[1], version: m[2] });
  }
  return out;
}

/** The Kratos pins of the solver, minus the MCP server. */
export function solverPins(requirementsIn: string): { name: string; version: string }[] {
  return parsePins(requirementsIn).filter((p) => !NOT_SOLVER.has(p.name.toLowerCase()));
}

/** The version the install directory is named after: the pinned core package's. */
export function solverVersion(pins: { name: string; version: string }[]): string | undefined {
  return pins.find((p) => p.name === "KratosMultiphysics")?.version;
}

export interface InstallPlan {
  mode: "hash-locked" | "pinned";
  /** Arguments after `uv pip install --python <py>`. */
  args: string[];
  /** Text to write beside the venv when the mode installs from a generated file. */
  generated?: { file: string; text: string };
  note: string;
}

/**
 * The lock is a hash-verified `uv pip compile` for CPython 3.12 on x86-64 glibc
 * Linux, so only that platform installs from it. Elsewhere the same pins install
 * without hash verification — a weaker guarantee that the caller must say aloud.
 */
export function planInstall(platform: NodeJS.Platform, arch: string, lockPath: string | undefined, pins: { name: string; version: string }[]): InstallPlan {
  if (platform === "linux" && arch === "x64" && lockPath) {
    return { mode: "hash-locked", args: ["--only-binary", ":all:", "--require-hashes", "-r", lockPath], note: "Every package is verified against the pinned hashes." };
  }
  return {
    mode: "pinned",
    args: ["--only-binary", ":all:", "-r", "requirements-solver.txt"],
    generated: { file: "requirements-solver.txt", text: pins.map((p) => `${p.name}==${p.version}`).join("\n") + "\n" },
    note: "Versions are pinned but package hashes are not verified on this platform.",
  };
}

const venvPython = (venv: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");

export interface SolverInstallDeps {
  run: typeof runRuntimeCommand;
  probe: (python: string, env: NodeJS.ProcessEnv) => Promise<RuntimeReport>;
  readText: (file: string) => Promise<string>;
}

export interface SolverInstallResult {
  python: string;
  directory: string;
  version: string;
  mode: InstallPlan["mode"] | "existing";
  note: string;
  /** True when a verified runtime was already there and nothing was downloaded. */
  reused: boolean;
}

export class SolverRuntimeInstaller {
  private inFlight?: Promise<SolverInstallResult>;
  constructor(
    private readonly userData: string,
    /** Directory holding the staged `requirements.in` and `requirements.lock`. */
    private readonly assets: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly arch: string = process.arch,
    private readonly deps: SolverInstallDeps = {
      run: runRuntimeCommand,
      probe: (python, env) => probePython(python, [], [...SOLVER_APPLICATIONS], env),
      readText: (file) => fs.readFile(file, "utf8"),
    },
  ) {}

  /** One install at a time; a second call joins the first rather than racing it. */
  install(uv: string, signal: AbortSignal): Promise<SolverInstallResult> {
    this.inFlight ??= this.run(uv, signal).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async run(uv: string, signal: AbortSignal): Promise<SolverInstallResult> {
    const requirements = await this.deps.readText(path.join(this.assets, "requirements.in")).catch(() => {
      throw new RuntimeFailure("installation", "The pinned Kratos requirements are missing from this build.");
    });
    const pins = solverPins(requirements);
    const version = solverVersion(pins);
    if (!version) throw new RuntimeFailure("installation", "The pinned requirements do not name KratosMultiphysics.");
    const directory = path.join(this.userData, "runtimes", `kratos-${version}`);
    const python = venvPython(directory, this.platform);
    const env = externalProcessEnv(process.env);

    // A verified runtime from an earlier install is reused, never rebuilt or upgraded.
    if (await this.exists(python)) {
      const existing = await this.deps.probe(python, env);
      if (existing.available) return { python, directory, version, mode: "existing", note: "An earlier install was verified and left unchanged.", reused: true };
      await fs.rm(directory, { recursive: true, force: true }); // an unusable earlier attempt: start clean
    }

    const lock = path.join(this.assets, "requirements.lock");
    const plan = planInstall(this.platform, this.arch, (await this.exists(lock)) ? lock : undefined, pins);
    try {
      await fs.rm(directory, { recursive: true, force: true }); // never build over leftovers
      await fs.mkdir(path.dirname(directory), { recursive: true });
      await this.deps.run(uv, ["venv", "--python", SOLVER_PYTHON, directory], { signal, timeout: 15 * 60_000, env });
      if (plan.generated) await fs.writeFile(path.join(directory, plan.generated.file), plan.generated.text);
      const args = plan.generated ? plan.args.map((a) => (a === plan.generated!.file ? path.join(directory, a) : a)) : plan.args;
      await this.deps.run(uv, ["pip", "install", "--python", python, ...args], { signal, timeout: 45 * 60_000, env });
      signal.throwIfAborted();
      const report = await this.deps.probe(python, env);
      if (!report.available) {
        const missing = report.applications.filter((a) => !a.available).map((a) => a.name).join(", ");
        throw new RuntimeFailure("installation", `The installed runtime failed verification${missing ? `: ${missing} could not be imported` : ""}. ${report.reason ?? ""}`.trim());
      }
      return { python, directory, version, mode: plan.mode, note: plan.note, reused: false };
    } catch (error) {
      // Nothing half-made stays behind, and no setting was touched.
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private exists(file: string): Promise<boolean> {
    return fs.stat(file).then(() => true, () => false);
  }
}
