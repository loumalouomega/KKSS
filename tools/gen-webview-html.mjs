// Bundles tools/webviewMarkup.ts (which imports the submodules' vscode-free
// markup modules) and runs it to emit the per-mode webview HTML pages.
import * as esbuild from "esbuild";
import { execFileSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, "out", "tools", "webviewMarkup.cjs");

await esbuild.build({
  entryPoints: [path.join(root, "tools", "webviewMarkup.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile,
  logLevel: "silent",
});

execFileSync(process.execPath, [outfile], { cwd: root, stdio: "inherit" });
