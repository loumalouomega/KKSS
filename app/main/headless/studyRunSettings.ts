/**
 * The Kratos runtime settings a headless run uses, read from a saved
 * `state.json` (never written) so the run sees the same interpreter, install
 * path, extra environment and thread/rank counts the plan was frozen with. A
 * plan whose frozen runtime differs from the one found here is refused by the
 * queue's own check ("Solver runtime settings changed after preview"), so a
 * headless run cannot silently run against another solver.
 */
import * as fs from "node:fs";
import { computeKratosEnv, defaultPythonPath, resolveKratosInstall } from "../../../mesh/src/problemtype/kratosEnv";
import { effective, entryById } from "../services/settings/registry";
import { externalProcessEnv } from "../services/childEnv";

export interface HeadlessEnvironment {
  python: string;
  threads: number;
  mpiRanks: number;
  env: NodeJS.ProcessEnv;
  bundledPython?: string;
  installPath?: string;
  extraEnv: Record<string, string>;
}

const read = <T>(settings: Record<string, unknown>, id: string): T => {
  const entry = entryById(id)!;
  return effective(entry, settings[entry.storeKey!]) as T;
};

/** Parses a saved state file; anything unreadable or not an object is "no settings", not an error. */
export function loadSettings(file: string | undefined): Record<string, unknown> {
  if (!file) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch { return {}; }
}

export function environmentFromSettings(
  settings: Record<string, unknown>,
  overrides: { python?: string },
  platform: NodeJS.Platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = fs.existsSync,
): HeadlessEnvironment {
  let installPath = read<string>(settings, "kratos.installPath");
  if (installPath) {
    const resolution = resolveKratosInstall(installPath, exists, platform);
    if (resolution.root) installPath = resolution.root;
  }
  const extraEnv = read<Record<string, string>>(settings, "kratos.extraEnv");
  return {
    python: overrides.python || read<string>(settings, "kratos.pythonPath") || defaultPythonPath(platform),
    threads: read<number>(settings, "kratos.threads"),
    mpiRanks: read<number>(settings, "kratos.mpiRanks"),
    env: { ...externalProcessEnv(baseEnv), ...computeKratosEnv({ platform, installPath, extraEnv, base: externalProcessEnv(baseEnv) }) },
    bundledPython: baseEnv.KKSS_KRATOS_PYTHON,
    installPath: installPath || undefined,
    extraEnv,
  };
}
