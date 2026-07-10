// Guard: every --vscode-* CSS variable referenced by the submodules' webview
// stylesheets must be defined in app/renderer/theme/vscode-vars.css, since the
// Electron pages have no VS Code to inject them. Fails the build on a miss so
// a submodule update can't silently drop theming.
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const sources = [
  "cad/media/viewer.css",
  "mesh/webview/style.css", // source of media/style.css (mesh/media is gitignored)
];
const themeFile = "app/renderer/theme/vscode-vars.css";

const used = new Set();
for (const rel of sources) {
  const css = fs.readFileSync(path.join(root, rel), "utf8");
  for (const m of css.matchAll(/var\((--vscode-[a-zA-Z-]+)/g)) used.add(m[1]);
}

const theme = fs.readFileSync(path.join(root, themeFile), "utf8");
const defined = new Set([...theme.matchAll(/(--vscode-[a-zA-Z-]+)\s*:/g)].map((m) => m[1]));

const missing = [...used].filter((v) => !defined.has(v)).sort();
if (missing.length > 0) {
  console.error(
    `check-theme-vars: ${missing.length} --vscode-* variable(s) used by the submodule ` +
      `stylesheets are not defined in ${themeFile}:\n  ${missing.join("\n  ")}`
  );
  process.exit(1);
}
console.log(`check-theme-vars: OK (${used.size} variables, all defined)`);
