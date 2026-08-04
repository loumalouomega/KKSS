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
import {
  ADVANCED_MENU_HTML,
  CUT_PANEL_HTML,
  FLOWGRAPH_PANE_HTML,
  MENUBAR_HTML,
  SIDEBAR_HTML,
  TOOLBAR_HTML,
  VIEW_MENU_HTML,
} from "../mesh/src/webviewChrome";
import { TOOLBAR_ICONS } from "../mesh/src/toolbarIcons";

/**
 * Same helper the mesh providers define (mdpaEditorProvider.ts). The toolbar
 * and both popups embed their own icons via `webviewChrome.ts`, so this is only
 * needed for the find bar's close button, which the providers still inline.
 */
function icon(id: keyof typeof TOOLBAR_ICONS): string {
  return `<span class="toolbar-icon">${TOOLBAR_ICONS[id]}</span>`;
}

/**
 * `css` is an ordered list because mesh needs two sheets: design-system.css
 * defines the `--ds-*` tokens style.css resolves, so it must be linked first
 * (mdpaEditorProvider.getHtml does the same), and the KKSS-only overrides come
 * last so they win.
 */
function page(opts: {
  title: string;
  csp: string;
  bundle: string;
  css: string[];
  body: string;
}): string {
  const links = opts.css.map((f) => `  <link href="./${f}" rel="stylesheet" />`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${opts.csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="../theme/vscode-vars.css" rel="stylesheet" />
${links}
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

/**
 * Replica of the shared provider skeleton (mdpa/vtk getHtml bodies are
 * identical) — mirrors mesh/src/mdpaEditorProvider.ts's getHtml body element
 * for element. Everything that can come from `webviewChrome.ts` does; the only
 * markup written out here is what the providers themselves inline.
 *
 * `MENUBAR_HTML` is emitted even though KKSS hides it (mesh-overrides.css):
 * `webview/main.ts` looks its nodes up by id — including `#theme-select`, which
 * the shared `sceneTheme` setting drives through `initialState` — so dropping
 * it would leave those lookups null.
 */
function meshBody(): string {
  return `  <div id="loading">
    <div id="loading-inner">
      <div id="loading-bar-wrap"><div id="loading-bar"></div></div>
      <div id="loading-label">Reading file…</div>
    </div>
  </div>
  <div id="app" style="display:none">
    ${MENUBAR_HTML}
    <div id="main">
    ${SIDEBAR_HTML}
    <div id="sidebar-resizer" title="Drag to resize the sidebar"></div>
    <div id="viewport">
      <div id="vtk-sub">
      <div id="cut-panel" class="hidden">${CUT_PANEL_HTML}
      </div>
      <div id="toolbar">${TOOLBAR_HTML}
      </div>
      ${VIEW_MENU_HTML}
      ${ADVANCED_MENU_HTML}
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
    </div>
  </div>`;
}

const outDir = path.join(process.cwd(), "out", "renderer");
fs.mkdirSync(path.join(outDir, "cad"), { recursive: true });
fs.mkdirSync(path.join(outDir, "mesh"), { recursive: true });

fs.writeFileSync(
  path.join(outDir, "cad", "index.html"),
  page({
    title: "KKSS — CAD Preview",
    csp: CAD_CSP,
    bundle: "viewer.js",
    css: ["viewer.css"],
    body: `  ${viewerBodyHtml()}`,
  })
);
fs.writeFileSync(
  path.join(outDir, "mesh", "index.html"),
  page({
    title: "KKSS — Mesh Preview",
    csp: MESH_CSP,
    bundle: "webview.js",
    css: ["design-system.css", "style.css", "mesh-overrides.css"],
    body: meshBody(),
  })
);

console.log("gen-webview-html: wrote out/renderer/cad/index.html and out/renderer/mesh/index.html");
