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
  ["mesh/dist/streamlineWorker.js", "npm run package --prefix mesh"],
  ["mesh/dist/plotWorker.js", "npm run package --prefix mesh"],
  ["mesh/media/plots.js", "npm run package --prefix mesh"],
  ["mesh/media/plots.css", "npm run package --prefix mesh"],
  ["mesh/media/plotly/plotly.min.js", "npm run package --prefix mesh"],
  ["mesh/media/plotly/LICENSE", "npm run package --prefix mesh"],
  ["mesh/dist/mmg-core.wasm", "npm run package --prefix mesh"],
  ["cad/dist/opencascade.wasm.wasm", "npm run build --prefix cad"],
  ["cad/dist/gmsh-core.wasm", "npm run build --prefix cad"],
  // cad 2.7.0's bundled starter meshing presets (cad/esbuild.mjs copyMeshPresets).
  ["cad/dist/mesh-presets/starter-presets.json", "npm run build --prefix cad"],
  // fTetWild, staged by cad 3.6.0's own build (scripts/runtimeAssets.mjs) and
  // resolved at runtime by cad's `runtimePackage.ts`.
  ["cad/dist/ftetwild/index.js", "npm run build --prefix cad"],
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
const wasmPathPlugin = (relativePath) => ({
  name: "wasm-path",
  setup(build) {
    build.onLoad({ filter: /\.wasm$/ }, () => ({
      contents: `module.exports = require("path").join(__dirname, ${JSON.stringify(relativePath)});`,
      loader: "js",
    }));
  },
});

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

// cad 3.6.0 replaced both bare package imports with its own
// `runtimePackage.ts`, which resolves the installed package first and then a
// STAGED tree beside the bundle (`<dir>/meshio`, `<dir>/ftetwild`) or two levels
// above it — i.e. exactly KKSS's `out/meshio` and `out/ftetwild`, for the
// interactive worker (out/cadCompute.worker.js) and the MCP kernel
// (out/cad-runtime/dist/kernel-worker.js) alike. So the aliases KKSS used to
// interpose (app/main/cadMeshioLoader.ts, app/main/cadFtetwildLoader.ts) are
// gone, and neither bare specifier is ever bundled. What still matters is the
// `import.meta.url` shim above: the lookup is anchored to the bundle's own
// file, which in a cjs bundle only works with that shim.

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
  // @meshioplusplus/wasm stays external (mirroring mesh's own esbuild.js): the
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
  plugins: [wasmPathPlugin("cad-runtime/dist/opencascade.wasm.wasm")],
  // gmshService.ts (bundled into this worker) imports gmsh-wasm — force its
  // CJS build so the top-level await in the ESM entry never reaches this CJS
  // bundle. meshio++ and fTetWild need no alias at all: cad 3.6.0 resolves both
  // from the staged out/meshio/ and out/ftetwild/ trees through its own
  // runtimePackage.ts (see the note above).
  alias: { ...gmshAlias },
  // gmsh-core.cjs's emscripten runtime has a `require("ws")` in its Node
  // WebSocket-socket branch — dead code for mesh generation (no networking) and
  // ws isn't even a declared dep. Keep it external so it never has to resolve.
  external: ["ws"],
  ...importMetaShim,
  sourcemap: true,
  logLevel: "info",
};

// The upstream worker leaves its WASM packages external for VS Code's
// node_modules. Bundle the unchanged entry with the same loaders as the UI
// worker; the MCP server forks it beside the OCCT/Gmsh binaries.
const cadMcpWorkerConfig = {
  ...cadWorkerConfig,
  entryPoints: ["cad/src/kernelWorker.ts"],
  outfile: "out/cad-runtime/dist/kernel-worker.js",
  plugins: [wasmPathPlugin("opencascade.wasm.wasm")],
  external: ["ws", "playwright"],
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
    "app/preload/jobsPreload.ts",
    "app/preload/settingsPreload.ts",
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
    "app/renderer/jobs/jobs.ts",
    "app/renderer/settings/settings.ts",
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
    // render_snapshot serves the same CAD webview bundle from the MCP
    // extension root (`out/cad-runtime/media`) in a headless browser.
    ["cad/media/viewer.js", out("cad-runtime/media/viewer.js")],
    ["cad/media/viewer.css", out("cad-runtime/media/viewer.css")],
    ["mesh/media/webview.js", out("renderer/mesh/webview.js")],
    ["mesh/media/plots.js", out("renderer/mesh/plots.js")],
    ["mesh/media/plots.css", out("renderer/mesh/plots.css")],
    ["mesh/media/plotly/plotly.min.js", out("renderer/mesh/plotly/plotly.min.js")],
    ["mesh/media/plotly/LICENSE", out("renderer/mesh/plotly/LICENSE")],
    ["mesh/dist/plotWorker.js", out("plotWorker.js")],
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
    // mesh 4.21.0 traces streamlines off the host thread. Its client resolves
    // this entry beside the main bundle, exactly like the MMG worker.
    ["mesh/dist/streamlineWorker.js", out("streamlineWorker.js")],
    ["mesh/dist/mmg-core.wasm", out("mmg-core.wasm")],
    // OCCT + Gmsh WASM in the dist/-shaped layout the cad services expect
    // (extensionPath = out/cad-runtime).
    ["cad/dist/opencascade.wasm.wasm", out("cad-runtime/dist/opencascade.wasm.wasm")],
    ["cad/dist/gmsh-core.wasm", out("cad-runtime/dist/gmsh-core.wasm")],
    // cad 2.3.0's bundled starter macro library — same <extensionPath>/dist/…
    // convention as the WASM binaries above (bundledMacrosPath/getOcct both
    // join extensionPath the same way).
    [
      "cad/dist/macros/starter-library.json",
      out("cad-runtime/dist/macros/starter-library.json"),
    ],
    // cad 2.7.0's bundled starter meshing presets — same <extensionPath>/dist/…
    // convention (bundledMeshPresetsPath), and also what the chat sidebar's
    // cad MCP server reads for list/apply_mesh_preset.
    [
      "cad/dist/mesh-presets/starter-presets.json",
      out("cad-runtime/dist/mesh-presets/starter-presets.json"),
    ],
    // Stdio MCP servers for the chat sidebar. cad's sits beside its WASM so
    // its extensionPath (= dirname/..) resolves to out/cad-runtime; mesh's
    // sits beside out/mmg-core.wasm (it reads __dirname/mmg-core.wasm).
    ["cad/dist/mcp-server.js", out("cad-runtime/dist/mcp-server.js")],
    // kernel-worker.js is built by cadMcpWorkerConfig, never overwritten by
    // the upstream artifact whose external packages do not ship here.
    ["mesh/dist/mcpServer.js", out("mcpServer.js")],
    // Flowgraph static server must sit next to out/main.js (flowgraphController
    // resolves both it and out/flowgraph/ via __dirname); its served assets
    // (public/views/LICENSE/vscode-bridge.js) are copied as a tree below.
    ["mesh/dist/flowgraphServer.js", out("flowgraphServer.js")],
    // Static app assets.
    ["icons/app/icon-256.png", out("icon.png")], // Linux window/taskbar icon
    ["app/renderer/theme/vscode-vars.css", out("renderer/theme/vscode-vars.css")],
    ["app/renderer/theme/kkss-ui.css", out("renderer/theme/kkss-ui.css")],
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
    ["app/renderer/jobs/index.html", out("renderer/jobs/index.html")],
    ["app/renderer/jobs/jobs.css", out("renderer/jobs/jobs.css")],
    ["app/renderer/chat/index.html", out("renderer/chat/index.html")],
    ["app/renderer/settings/index.html", out("renderer/settings/index.html")],
    ["app/renderer/settings/settings.css", out("renderer/settings/settings.css")],
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
  // One copy beside out/main.js serves the mesh host, out/mcpServer.js AND
  // cad's own `runtimePackage.ts` staged-layout lookup (cad 3.6.0 resolves an
  // installed package first, then `<bundle dir>/meshio`, then two levels up),
  // so CAD and the mesh viewer share ONE tested version. Both WASM variants
  // must be in that tree: the main process auto-selects the threaded one.
  fs.cpSync(path.join(__dirname, "mesh/dist/meshio"), out("meshio"), { recursive: true });
  // float-tetwild-wasm, cad's fourth WASM kernel. Since cad 3.6.0 the
  // submodule's own build stages it into dist/ftetwild (scripts/runtimeAssets.mjs
  // is also what its .vsix checker verifies), so KKSS copies cad's staged tree
  // rather than reaching into cad/node_modules. Resolved at runtime by cad's
  // `runtimePackage.ts` from the same staged-layout lookup as meshio++.
  fs.cpSync(path.join(__dirname, "cad/dist/ftetwild"), out("ftetwild"), { recursive: true });
  // mesh 4.8.0's experimental VTK-wasm renderer runtime (roadmap item 18):
  // the hash-verified, eval-free patched glue, its .wasm and both licence
  // notices, staged by mesh's production build. Served from beside the mesh
  // page, which imports vtkWebAssembly.mjs from this directory and points
  // locateFile at the .wasm next to it.
  //
  // Optional on purpose: mesh only prepares the runtime when it is missing, so
  // an offline build or an explicit KRATOS_VTK_WASM=skip produces none — and
  // must still build. The renderer setting then falls back to vtk.js with a
  // status line (app/main/mesh/rendererPage.ts), which is the documented
  // behaviour for an installation without the runtime. Hence a warning, not a
  // preflight entry in `required` above.
  const vtkWasm = path.join(__dirname, "mesh/media/vtk-wasm");
  if (fs.existsSync(vtkWasm)) {
    fs.cpSync(vtkWasm, out("renderer/mesh/vtk-wasm"), { recursive: true });
  } else {
    console.warn(
      "esbuild: mesh/media/vtk-wasm/ absent — the experimental VTK-wasm renderer will fall back to vtk.js.\n" +
        "  Run `npm run vtkwasm:prepare --prefix mesh` to prepare the runtime, or set KRATOS_VTK_WASM=skip to accept the fallback."
    );
  }
  console.log(`Copied ${copies.length} artifacts into out/`);
}

const configs = [
  mainConfig,
  cadWorkerConfig,
  cadMcpWorkerConfig,
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
