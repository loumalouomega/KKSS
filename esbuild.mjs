// Bundles the KKSS Electron app: main process, compute worker, preloads, and
// shell renderer — and copies the submodule-built webview bundles + WASM
// binaries into out/. esbuild owns all emit; `tsc` is type-check only
// (same convention as the cad/ and mesh/ submodules).
import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");
const out = (...p) => path.join(__dirname, "out", ...p);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));

// ---- Preflight: the app consumes artifacts built inside the submodules ------
const required = [
  ["cad/media/viewer.js", "npm run build --prefix cad"],
  ["cad/media/viewer.css", "npm run build --prefix cad"],
  ["mesh/media/webview.js", "npm run package --prefix mesh"],
  ["mesh/media/style.css", "npm run package --prefix mesh"],
  ["mesh/dist/mmgWorker.js", "npm run package --prefix mesh"],
  ["mesh/dist/mmg-core.wasm", "npm run package --prefix mesh"],
  ["cad/dist/opencascade.wasm.wasm", "npm run build --prefix cad"],
  ["cad/dist/gmsh-core.wasm", "npm run build --prefix cad"],
];
for (const [rel, fix] of required) {
  if (!fs.existsSync(path.join(__dirname, rel))) {
    console.error(
      `esbuild: missing submodule artifact "${rel}".\n` +
        `Run "npm run submodules:install" once, then "${fix}" (or just "npm run build").`
    );
    process.exit(1);
  }
}

/**
 * Same plugin as cad/esbuild.mjs: intercepts `.wasm` imports (opencascade.js)
 * and resolves the binary path at runtime relative to the bundle. The compute
 * worker lives at out/cadCompute.worker.js and the WASM under
 * out/cad-runtime/dist/ (the `dist/`-shaped layout occtService expects).
 */
const wasmPathPlugin = {
  name: "wasm-path",
  setup(build) {
    build.onLoad({ filter: /\.wasm$/ }, () => ({
      contents: `module.exports = require("path").join(__dirname, "cad-runtime", "dist", "opencascade.wasm.wasm");`,
      loader: "js",
    }));
  },
};

/** Restores a real `import.meta.url` for bundled ESM deps (see cad/esbuild.mjs). */
const importMetaShim = {
  banner: {
    js: `const import_meta_url = require("url").pathToFileURL(__filename).href;`,
  },
  define: { "import.meta.url": "import_meta_url" },
};

// Force the CJS build of mmg-wasm, same as mesh/esbuild.js: the ESM entry's
// import.meta.url-based wasm lookup breaks inside a CJS bundle.
const mmgAlias = {
  "@loumalouomega/mmg-wasm": path.join(
    __dirname,
    "mesh/node_modules/@loumalouomega/mmg-wasm/dist/mmg.cjs"
  ),
};

/** @type {import('esbuild').BuildOptions} */
const mainConfig = {
  entryPoints: ["app/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "out/main.js",
  external: ["electron"],
  // `vscode` (imported by the reused mesh host modules) resolves to our shim.
  alias: { ...mmgAlias, vscode: path.join(__dirname, "app/main/vscodeShim.ts") },
  ...importMetaShim,
  define: {
    ...importMetaShim.define,
    // The About dialog's author line, straight from package.json.
    __KKSS_AUTHOR__: JSON.stringify(pkg.author),
  },
  sourcemap: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const cadWorkerConfig = {
  entryPoints: ["app/main/cadCompute.worker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "out/cadCompute.worker.js",
  plugins: [wasmPathPlugin],
  ...importMetaShim,
  sourcemap: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const preloadConfig = {
  entryPoints: [
    "app/preload/viewPreload.ts",
    "app/preload/shellPreload.ts",
    "app/preload/pickerPreload.ts",
    "app/preload/homePreload.ts",
    "app/preload/aboutPreload.ts",
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: "out/preload",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const shellRendererConfig = {
  entryPoints: [
    "app/renderer/shell/shell.ts",
    "app/renderer/picker/picker.ts",
    "app/renderer/home/home.ts",
    "app/renderer/about/about.ts",
  ],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2021",
  outdir: "out/renderer",
  outbase: "app/renderer",
  sourcemap: true,
  logLevel: "info",
};

/** The acquireVsCodeApi shim loaded by both webview pages before the bundle. */
const shimConfigs = ["cad", "mesh"].map((mode) => ({
  entryPoints: ["app/renderer/view/shim.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2021",
  outfile: `out/renderer/${mode}/shim.js`,
  sourcemap: false,
  logLevel: "silent",
}));

function copyArtifacts() {
  const copies = [
    // Submodule webview bundles + styles, untouched.
    ["cad/media/viewer.js", out("renderer/cad/viewer.js")],
    ["cad/media/viewer.css", out("renderer/cad/viewer.css")],
    ["mesh/media/webview.js", out("renderer/mesh/webview.js")],
    ["mesh/media/style.css", out("renderer/mesh/style.css")],
    // MMG worker pair must sit next to out/main.js (mmgWorkerClient resolves
    // the worker via __dirname; the wasm is fed by configureMmg at startup).
    ["mesh/dist/mmgWorker.js", out("mmgWorker.js")],
    ["mesh/dist/mmg-core.wasm", out("mmg-core.wasm")],
    // OCCT + Gmsh WASM in the dist/-shaped layout the cad services expect
    // (extensionPath = out/cad-runtime).
    ["cad/dist/opencascade.wasm.wasm", out("cad-runtime/dist/opencascade.wasm.wasm")],
    ["cad/dist/gmsh-core.wasm", out("cad-runtime/dist/gmsh-core.wasm")],
    // Static app assets.
    ["icons/app/icon-256.png", out("icon.png")], // Linux window/taskbar icon
    ["app/renderer/theme/vscode-vars.css", out("renderer/theme/vscode-vars.css")],
    ["app/renderer/shell/index.html", out("renderer/shell/index.html")],
    ["app/renderer/shell/shell.css", out("renderer/shell/shell.css")],
    ["app/renderer/picker/picker.html", out("renderer/picker/picker.html")],
    ["app/renderer/picker/picker.css", out("renderer/picker/picker.css")],
    ["app/renderer/home/index.html", out("renderer/home/index.html")],
    ["app/renderer/home/home.css", out("renderer/home/home.css")],
    ["app/renderer/about/about.html", out("renderer/about/about.html")],
    ["app/renderer/about/about.css", out("renderer/about/about.css")],
  ];
  for (const [srcRel, dst] of copies) {
    const src = path.join(__dirname, srcRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  console.log(`Copied ${copies.length} artifacts into out/`);
}

const configs = [
  mainConfig,
  cadWorkerConfig,
  preloadConfig,
  shellRendererConfig,
  ...shimConfigs,
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  copyArtifacts();
  console.log("esbuild: watching…");
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  copyArtifacts();
}
