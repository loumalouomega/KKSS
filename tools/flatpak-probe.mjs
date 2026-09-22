#!/usr/bin/env node
/**
 * A reproducible, non-publishing Flatpak feasibility probe. It checks the
 * installed runtime/tooling and records the permissions the unpacked Electron
 * tree would require; it deliberately does not alter the repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return "unavailable"; } };
const report = {
  flatpak: run("flatpak", ["--version"]),
  runtimes: run("flatpak", ["list", "--runtime", "--columns=application,version,branch"]),
  unpackedOutput: existsSync(path.join(root, "out", "main.js")),
  nativeModule: existsSync(path.join(root, "node_modules", "node-pty")),
  wasmWorkers: ["out/cad-runtime", "out/mmgWorker.js", "out/meshio"].map(p => ({ path: p, present: existsSync(path.join(root, p)) })),
  requiredPermissions: ["--filesystem=home", "--filesystem=host", "--share=ipc", "--socket=x11", "--socket=wayland", "--device=dri", "--talk-name=org.freedesktop.Flatpak"],
  blockers: ["asar=false requires unpacked worker/WASM files", "node-pty needs a Flatpak-compatible native build", "external Kratos/uv/OpenFOAM launch needs a defined host boundary"],
};
console.log(JSON.stringify(report, null, 2));
console.log("Flatpak is a probe only; no bundle was published.");
