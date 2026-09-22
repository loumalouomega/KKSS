/**
 * Settings ▸ Kratos → the environment delta for the assistant's Kratos MCP
 * server. Reuses mesh's own vscode-free resolver and env builder
 * (mesh/src/problemtype/kratosEnv.ts), so a Kratos install configured once
 * reaches both the problemtype Run button (via the shim's getConfiguration)
 * and the chat's Kratos tools the same way.
 *
 * `kratos.pythonPath` is deliberately NOT applied here: the MCP server runs in
 * uvx's own isolated environment, and pointing it at another interpreter would
 * change what `kratos-mcp-server@<pinned>` resolves against.
 */
import * as fs from "node:fs";
import { computeKratosEnv, resolveKratosInstall } from "../../../../mesh/src/problemtype/kratosEnv";
import { stateStore } from "../stateStore";
import { effective, entryById } from "./registry";

function read<T>(id: string): T {
  const entry = entryById(id)!;
  return effective(entry, stateStore.get(entry.storeKey!)) as T;
}

/** The delta to spread over `process.env` (never a full environment). */
export function kratosEnvDelta(): Record<string, string> {
  let installPath = read<string>("kratos.installPath");
  if (installPath) {
    // Same resolution the Run button does: a source checkout's bin/<config>.
    const resolution = resolveKratosInstall(installPath, fs.existsSync, process.platform);
    if (resolution.root) installPath = resolution.root;
  }
  return computeKratosEnv({
    platform: process.platform,
    installPath,
    extraEnv: read<Record<string, string>>("kratos.extraEnv"),
    base: process.env,
  });
}

/** Why the configured install does not look like Kratos, for the Settings row. */
export function kratosInstallProblem(): string | undefined {
  const installPath = read<string>("kratos.installPath");
  if (!installPath) return undefined;
  return resolveKratosInstall(installPath, fs.existsSync, process.platform).problem;
}
