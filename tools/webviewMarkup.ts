/**
 * Generates out/renderer/cad/index.html and out/renderer/mesh/index.html from
 * the submodules' own vscode-free markup modules, so the pages always carry
 * the exact DOM the extensions ship — never a hand-copied snapshot.
 *
 * cad page body   = viewerBodyHtml() from cad/src/viewerDom.ts
 * mesh page body  = the provider HTML skeleton (mdpaEditorProvider.getHtml /
 *                   vtkEditorProvider.getHtml emit byte-identical bodies)
 *                   assembled from mesh/src/webviewChrome.ts + toolbarIcons.ts.
 *
 * This file is bundled by tools/gen-webview-html.mjs and run under Node; it
 * must not import `vscode` (the modules above are vscode-free by design).
 */
import * as fs from "fs";
import * as path from "path";
import { viewerBodyHtml } from "../cad/src/viewerDom";
import { FILE_MENU_HTML, FLOWGRAPH_PANE_HTML, SIDEBAR_HTML } from "../mesh/src/webviewChrome";
import { TOOLBAR_ICONS } from "../mesh/src/toolbarIcons";

/** Same helper the mesh providers define (mdpaEditorProvider.ts). */
function icon(id: keyof typeof TOOLBAR_ICONS): string {
  return `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
}

function page(opts: { title: string; csp: string; bundle: string; css: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${opts.csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="../theme/vscode-vars.css" rel="stylesheet" />
  <link href="./${opts.css}" rel="stylesheet" />
  <title>${opts.title}</title>
</head>
<body>
${opts.body}
  <script src="./shim.js"></script>
  <script src="./${opts.bundle}"></script>
</body>
</html>`;
}

// CSP mirrors each provider's directives (cad/src/provider.ts getHtml,
// mesh/src/*EditorProvider.ts getHtml), with the kkss: app scheme in place of
// webview.cspSource and kkss-file: allowed for cad's loadUrl fetch pipeline.
const CAD_CSP = [
  `default-src 'none'`,
  `img-src kkss: blob: data:`,
  `style-src kkss: 'unsafe-inline'`,
  `script-src kkss:`,
  `connect-src kkss: kkss-file: blob: data:`,
].join("; ");

const MESH_CSP = [
  `default-src 'none'`,
  `img-src kkss: https: data: blob:`,
  `style-src kkss: 'unsafe-inline'`,
  `script-src kkss:`,
  `worker-src blob:`,
  // The embedded Flowgraph editor is served from a localhost port (or an
  // https tunnel) resolved via asExternalUri at runtime, so frame-src is
  // scoped by scheme/host rather than an exact port (mdpaEditorProvider.ts /
  // vtkEditorProvider.ts getHtml).
  `frame-src http://localhost:* http://127.0.0.1:* https:`,
  `child-src blob:`,
  `connect-src kkss: blob: data:`,
].join("; ");

/** Replica of the shared provider skeleton (mdpa/vtk getHtml bodies are identical). */
function meshBody(): string {
  return `  <div id="loading">
    <div id="loading-inner">
      <div id="loading-bar-wrap"><div id="loading-bar"></div></div>
      <div id="loading-label">Reading file…</div>
    </div>
  </div>
  <div id="app" style="display:none">
    ${SIDEBAR_HTML}
    <div id="sidebar-resizer" title="Drag to resize the sidebar"></div>
    <div id="viewport">
      <div id="vtk-sub">
      ${FILE_MENU_HTML}
      <div id="cut-panel" class="hidden">
        <span style="opacity:0.7;font-size:11px">Axis</span>
        <label><input type="radio" name="cut-axis" value="0"> X</label>
        <label><input type="radio" name="cut-axis" value="1"> Y</label>
        <label><input type="radio" name="cut-axis" value="2" checked> Z</label>
        <button id="cut-flip">Flip</button>
        <input type="range" id="cut-slider" min="0" max="100" value="50" step="0.5">
        <span id="cut-position"></span>
      </div>
      <div id="toolbar">
        <button data-action="reset" title="Reset camera">${icon("reset")} Reset</button>
        <button data-action="pan" title="Toggle pan mode">${icon("pan")} Pan</button>
        <button data-action="cut" title="Toggle clip plane">${icon("cut")} Cut Plane</button>
        <button data-action="wireframe" title="Toggle wireframe">${icon("wireframe")} Wireframe</button>
        <button data-action="nodeIds" title="Toggle node ids">${icon("nodeIds")} Node IDs</button>
        <button data-action="quality" title="Compute mesh quality">${icon("quality")} Quality</button>
        <button data-action="field" title="Visualize field data">${icon("field")} Field</button>
        <button data-action="grid" title="Toggle background grid">${icon("grid")} Grid</button>
        <button data-action="find" title="Find entity by ID">${icon("find")} Find</button>
        <button data-action="screenshot" title="Save screenshot as PNG">${icon("screenshot")}</button>
        <select id="theme-select" title="Scene theme">
          <option value="auto">Auto</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="scientific">Scientific</option>
        </select>
      </div>
      <div id="find-bar">
        <select id="find-type">
          <option>Node</option>
          <option>Element</option>
          <option>Condition</option>
          <option>Geometry</option>
        </select>
        <input id="find-id" type="number" min="1" placeholder="ID" />
        <button id="find-go">Go</button>
        <button id="find-close" title="Close">${icon("close")}</button>
        <span id="find-status"></span>
      </div>
      <div id="render-root"></div>
      </div>
      ${FLOWGRAPH_PANE_HTML}
    </div>
  </div>`;
}

const outDir = path.join(process.cwd(), "out", "renderer");
fs.mkdirSync(path.join(outDir, "cad"), { recursive: true });
fs.mkdirSync(path.join(outDir, "mesh"), { recursive: true });

fs.writeFileSync(
  path.join(outDir, "cad", "index.html"),
  page({ title: "KKSS — CAD Preview", csp: CAD_CSP, bundle: "viewer.js", css: "viewer.css", body: `  ${viewerBodyHtml()}` })
);
fs.writeFileSync(
  path.join(outDir, "mesh", "index.html"),
  page({ title: "KKSS — Mesh Preview", csp: MESH_CSP, bundle: "webview.js", css: "style.css", body: meshBody() })
);

console.log("gen-webview-html: wrote out/renderer/cad/index.html and out/renderer/mesh/index.html");
