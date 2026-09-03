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
  // Shared token/base layer style.css builds on (mesh 3.0.0's design system).
  // Must be linked before style.css — see tools/webviewMarkup.ts.
  ["mesh/media/design-system.css", "npm run package --prefix mesh"],
  ["mesh/dist/mmgWorker.js", "npm run package --prefix mesh"],
  ["mesh/dist/mmg-core.wasm", "npm run package --prefix mesh"],
  ["cad/dist/opencascade.wasm.wasm", "npm run build --prefix cad"],
  ["cad/dist/gmsh-core.wasm", "npm run build --prefix cad"],
  // Stdio MCP servers spawned by the chat sidebar (app/main/services/chat/).
  ["cad/dist/mcp-server.js", "npm run build --prefix cad"],
  ["mesh/dist/mcpServer.js", "npm run package --prefix mesh"],
  // Flowgraph static server + its served assets (flowgraphController.ts).
  ["mesh/dist/flowgraphServer.js", "npm run package --prefix mesh"],
  ["mesh/dist/flowgraph", "npm run package --prefix mesh"],
  // meshio++ WASM tree backing the extended mesh formats (meshio.ts).
  ["mesh/dist/meshio/src/index.mjs", "npm run package --prefix mesh"],
  // fTetWild, cad 1.5.0's fourth WASM kernel (ftetwildService.ts). Not staged
  // into cad/dist by its own build — copied straight from cad's node_modules.
  ["cad/node_modules/float-tetwild-wasm/index.js", "npm ci --prefix cad"],
  // cad 1.3.0 moved OCCT/Gmsh/meshio++/fTetWild into a forked child process;
  // dist/mcp-server.js reaches them only through it (kernelClient.ts forks
  // `<extensionPath>/dist/kernel-worker.js`, and extensionPath for the chat
  // sidebar's copy is out/cad-runtime — see services/chat/mcpManager.ts).
  ["cad/dist/kernel-worker.js", "npm run build --prefix cad"],
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

// Same reason for gmsh-wasm: its ESM entry pulls in gmsh-core.mjs's top-level
// await, which esbuild cannot bundle into a CJS output. The .cjs entry uses a
// synchronous require("worker_threads") instead (see cad/src/gmshService.ts and
// cad's CLAUDE.md). cad marks the package external and ships it in node_modules;
// KKSS ships no node_modules, so it bundles the .cjs build directly — restoring
// what cad's own createRequire(...) resolution did before it switched to a
// static import.
const gmshAlias = {
  "@loumalouomega/gmsh-wasm": path.join(
    __dirname,
    "cad/node_modules/@loumalouomega/gmsh-wasm/dist/gmsh.cjs"
  ),
};

// cad/src/meshioService.ts loads meshio++ with a bare `await import(...)` and
// no directory fallback (unlike mesh's own loader, which ends at
// `__dirname/meshio`). KKSS ships no node_modules, so that specifier is
// redirected to a shim that resolves the copied out/meshio/ tree — see
// app/main/cadMeshioLoader.ts. Only the bare specifier is rewritten; mesh's
// loader builds its path at runtime and is unaffected.
const meshioAlias = {
  "@meshioplusplus/wasm": path.join(__dirname, "app/main/cadMeshioLoader.ts"),
};

// cad 1.5.0's fourth WASM kernel (ftetwildService.ts, behind mesh repair and
// mesh→B-rep promotion). ESM-only with a top-level await in its threaded glue,
// which esbuild cannot emit into a cjs bundle at all — so unlike meshio++ this
// is a hard build error, not just a packaged-install one. Same fix:
// app/main/cadFtetwildLoader.ts resolves the copied out/ftetwild/ tree.
const ftetwildAlias = {
  "float-tetwild-wasm": path.join(__dirname, "app/main/cadFtetwildLoader.ts"),
};

/** @type {import('esbuild').BuildOptions} */
const mainConfig = {
  entryPoints: ["app/main/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "out/main.js",
  // node-pty is the app's only native module: kept external and shipped as
  // node_modules/node-pty in the package (see electron-builder.yml files).
  // @meshioplusplus/wasm is external too (mirroring mesh's own esbuild.js): the
  // bundled meshio.ts has a `require.resolve("@meshioplusplus/wasm/package.json")`
  // literal esbuild would try to resolve at build time (this repo has no such
  // module), and its ESM-only glue must never be inlined. At runtime meshio.ts
  // falls back to `__dirname/meshio`, i.e. the out/meshio/ tree copied below.
  external: ["electron", "node-pty", "@meshioplusplus/wasm", "@meshioplusplus/wasm/*"],
  // `vscode` (imported by the reused mesh host modules) resolves to our shim.
  alias: { ...mmgAlias, ...gmshAlias, vscode: path.join(__dirname, "app/main/vscodeShim.ts") },
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
  // gmshService.ts (bundled into this worker) imports gmsh-wasm — force its
  // CJS build so the top-level await in the ESM entry never reaches this CJS
  // bundle. meshioService.ts's bare @meshioplusplus/wasm import and
  // ftetwildService.ts's float-tetwild-wasm import are redirected to the
  // out/meshio/ and out/ftetwild/ resolver shims (see the aliases above).
  alias: { ...gmshAlias, ...meshioAlias, ...ftetwildAlias },
  // gmsh-core.cjs's emscripten runtime has a `require("ws")` in its Node
  // WebSocket-socket branch — dead code for mesh generation (no networking) and
  // ws isn't even a declared dep. Keep it external so it never has to resolve.
  external: ["ws"],
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
    "app/preload/whatsNewPreload.ts",
    "app/preload/terminalPreload.ts",
    "app/preload/editorPreload.ts",
    "app/preload/chatPreload.ts",
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
    "app/renderer/whatsnew/whatsnew.ts",
    "app/renderer/terminal/terminal.ts",
    "app/renderer/editor/editor.ts",
    "app/renderer/chat/chat.ts",
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
    // design-system.css defines the --ds-* tokens style.css resolves; the
    // generated page links it first (tools/webviewMarkup.ts).
    ["mesh/media/design-system.css", out("renderer/mesh/design-system.css")],
    ["mesh/media/style.css", out("renderer/mesh/style.css")],
    // KKSS-only overrides, linked last: the app has a native menu bar, so the
    // webview's own in-flow menubar is emitted (main.ts queries its nodes) but
    // hidden.
    ["app/renderer/theme/mesh-overrides.css", out("renderer/mesh/mesh-overrides.css")],
    // MMG worker pair must sit next to out/main.js (mmgWorkerClient resolves
    // the worker via __dirname; the wasm is fed by configureMmg at startup).
    ["mesh/dist/mmgWorker.js", out("mmgWorker.js")],
    ["mesh/dist/mmg-core.wasm", out("mmg-core.wasm")],
    // OCCT + Gmsh WASM in the dist/-shaped layout the cad services expect
    // (extensionPath = out/cad-runtime).
    ["cad/dist/opencascade.wasm.wasm", out("cad-runtime/dist/opencascade.wasm.wasm")],
    ["cad/dist/gmsh-core.wasm", out("cad-runtime/dist/gmsh-core.wasm")],
    // Stdio MCP servers for the chat sidebar. cad's sits beside its WASM so
    // its extensionPath (= dirname/..) resolves to out/cad-runtime; mesh's
    // sits beside out/mmg-core.wasm (it reads __dirname/mmg-core.wasm).
    ["cad/dist/mcp-server.js", out("cad-runtime/dist/mcp-server.js")],
    // Since cad 1.3.0 every OCCT/Gmsh/meshio++/fTetWild call from that server
    // goes through a forked child, which kernelClient.ts looks up as
    // `<extensionPath>/dist/kernel-worker.js` — i.e. right here.
    ["cad/dist/kernel-worker.js", out("cad-runtime/dist/kernel-worker.js")],
    ["mesh/dist/mcpServer.js", out("mcpServer.js")],
    // Flowgraph static server must sit next to out/main.js (flowgraphController
    // resolves both it and out/flowgraph/ via __dirname); its served assets
    // (public/views/LICENSE/vscode-bridge.js) are copied as a tree below.
    ["mesh/dist/flowgraphServer.js", out("flowgraphServer.js")],
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
    ["app/renderer/whatsnew/whatsnew.html", out("renderer/whatsnew/whatsnew.html")],
    ["app/renderer/whatsnew/whatsnew.css", out("renderer/whatsnew/whatsnew.css")],
    // Read by services/whatsNew.ts (__dirname/CHANGELOG.md) to populate the
    // "What's New" dialog — the repo-root file, copied verbatim.
    ["CHANGELOG.md", out("CHANGELOG.md")],
    ["app/renderer/terminal/index.html", out("renderer/terminal/index.html")],
    ["app/renderer/terminal/terminal.css", out("renderer/terminal/terminal.css")],
    ["node_modules/@xterm/xterm/css/xterm.css", out("renderer/terminal/xterm.css")],
    ["app/renderer/editor/index.html", out("renderer/editor/index.html")],
    ["app/renderer/editor/editor.css", out("renderer/editor/editor.css")],
    ["app/renderer/chat/index.html", out("renderer/chat/index.html")],
    ["app/renderer/chat/chat.css", out("renderer/chat/chat.css")],
  ];
  for (const [srcRel, dst] of copies) {
    const src = path.join(__dirname, srcRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // Flowgraph's served assets (public/views/LICENSE/vscode-bridge.js) are a
  // directory tree, not a single file — mirrored verbatim next to out/main.js.
  fs.cpSync(path.join(__dirname, "mesh/dist/flowgraph"), out("flowgraph"), { recursive: true });
  // meshio++ (@meshioplusplus/wasm) is another verbatim tree: meshio.ts loads
  // it via a runtime dynamic import of out/meshio/src/index.mjs + locateFile
  // pointing at out/meshio/dist/*.wasm (its packageDir() __dirname fallback).
  // One copy beside out/main.js serves both the mesh host and out/mcpServer.js.
  fs.cpSync(path.join(__dirname, "mesh/dist/meshio"), out("meshio"), { recursive: true });
  // float-tetwild-wasm, cad's fourth WASM kernel. Unlike the two trees above,
  // the submodule's own build does not stage it into dist/ (it stays a plain
  // node_modules dependency there), so it is copied straight from cad's
  // node_modules — index.js + dist/, i.e. the package's own `files` list.
  // Resolved at runtime by app/main/cadFtetwildLoader.ts's `__dirname/ftetwild`.
  fs.cpSync(path.join(__dirname, "cad/node_modules/float-tetwild-wasm"), out("ftetwild"), {
    recursive: true,
  });
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
