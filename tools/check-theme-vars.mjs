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
  "mesh/webview/design-system.css", // mesh 3.0.0's shared token/base layer
];
const themeFile = "app/renderer/theme/vscode-vars.css";
// mesh's style.css builds on --ds-* tokens that live only in design-system.css.
// The page links both (tools/webviewMarkup.ts), so a token style.css uses but
// design-system.css never defines would render as an unresolved color/radius.
const dsConsumer = "mesh/webview/style.css";
const dsDefiner = "mesh/webview/design-system.css";

// KKSS's own pages consume the same variables (they share kkss-ui.css and the
// Dark+ definitions), so they are held to the same rule — an undefined variable
// there renders as an unset property, i.e. silently transparent/inherited.
function ownStylesheets(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...ownStylesheets(rel));
    else if (entry.name.endsWith(".css") && rel !== "app/renderer/theme/vscode-vars.css") out.push(rel);
  }
  return out;
}
sources.push(...ownStylesheets("app/renderer"));

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

// Settings ▸ UI Theme: every theme-kind block (.vscode-light & co.) must
// redefine every colour variable :root defines, or that colour would silently
// stay Dark+ under a light theme. Font variables are theme-independent.
const blockRe = /(^|\n)([^{}\n]+)\{([^}]*)\}/g;
const blocks = [...theme.matchAll(blockRe)].map((m) => ({
  selector: m[2].trim(),
  vars: new Set([...m[3].matchAll(/(--vscode-[a-zA-Z-]+)\s*:/g)].map((v) => v[1])),
}));
const rootBlock = blocks.find((b) => b.selector === ":root");
const isFont = (v) => /font-(family|size)$/.test(v);
const rootColours = [...(rootBlock?.vars ?? [])].filter((v) => !isFont(v));
const kinds = blocks.filter((b) => /^\.vscode-/.test(b.selector));
if (kinds.length !== 3) {
  console.error(`check-theme-vars: expected 3 theme-kind blocks in ${themeFile}, found ${kinds.length}`);
  process.exit(1);
}
for (const kind of kinds) {
  const lacking = rootColours.filter((v) => !kind.vars.has(v));
  const extra = [...kind.vars].filter((v) => !rootBlock.vars.has(v) || isFont(v));
  if (lacking.length || extra.length) {
    console.error(
      `check-theme-vars: ${kind.selector} in ${themeFile} must define exactly :root's colour variables.` +
        (lacking.length ? `\n  missing: ${lacking.join(", ")}` : "") +
        (extra.length ? `\n  unexpected: ${extra.join(", ")}` : "")
    );
    process.exit(1);
  }
}

// A token written as var(--ds-x, <fallback>) still renders when design-system.css
// never defines it, so only the bare var(--ds-x) form is a hard failure. mesh
// 3.12.0's style.css uses var(--ds-border, var(--vscode-widget-border)) that way.
// Fallback-only misses are still reported, since they usually mean the two
// stylesheets have drifted and upstream should define the token.
const dsConsumerCss = fs.readFileSync(path.join(root, dsConsumer), "utf8");
const dsUsed = new Set();
const dsRequired = new Set();
for (const m of dsConsumerCss.matchAll(/var\(\s*(--ds-[a-zA-Z0-9-]+)\s*([,)])/g)) {
  dsUsed.add(m[1]);
  if (m[2] === ")") dsRequired.add(m[1]);
}
const dsDefined = new Set(
  [...fs.readFileSync(path.join(root, dsDefiner), "utf8").matchAll(/(--ds-[a-zA-Z0-9-]+)\s*:/g)].map(
    (m) => m[1]
  )
);
const dsMissing = [...dsRequired].filter((v) => !dsDefined.has(v)).sort();
if (dsMissing.length > 0) {
  console.error(
    `check-theme-vars: ${dsMissing.length} --ds-* token(s) used by ${dsConsumer} without a ` +
      `fallback are not defined in ${dsDefiner}:\n  ${dsMissing.join("\n  ")}`
  );
  process.exit(1);
}

const dsFallbackOnly = [...dsUsed].filter((v) => !dsDefined.has(v) && !dsRequired.has(v)).sort();
if (dsFallbackOnly.length > 0) {
  console.warn(
    `check-theme-vars: ${dsFallbackOnly.length} --ds-* token(s) used by ${dsConsumer} are ` +
      `undefined in ${dsDefiner} but supply a fallback (rendering is unaffected):\n  ` +
      dsFallbackOnly.join("\n  ")
  );
}

console.log(
  `check-theme-vars: OK (${used.size} --vscode-* variables, ${dsUsed.size} --ds-* tokens, all defined)`
);
