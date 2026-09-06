/**
 * Guards on the generated webview pages (out/renderer/{cad,mesh}/index.html).
 * Skipped when the build has not run — CI always builds first.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const outDir = path.join(__dirname, "..", "out", "renderer");
const built = fs.existsSync(path.join(outDir, "cad", "index.html"));

describe.skipIf(!built)("generated webview pages", () => {
  const read = (mode: string) => fs.readFileSync(path.join(outDir, mode, "index.html"), "utf8");

  it("loads the shim before the extension bundle", () => {
    for (const [mode, bundle] of [
      ["cad", "viewer.js"],
      ["mesh", "webview.js"],
    ] as const) {
      const html = read(mode);
      const shimAt = html.indexOf("shim.js");
      const bundleAt = html.indexOf(bundle);
      expect(shimAt).toBeGreaterThan(-1);
      expect(bundleAt).toBeGreaterThan(shimAt);
    }
  });

  it("carries the cad viewer DOM from viewerDom.ts", () => {
    // Stable anchors of viewerBodyHtml(): app layout, file menu, edits panel.
    const html = read("cad");
    for (const anchor of ['id="app"', 'id="layout"', 'id="file-menu"', 'id="edits-panel"']) {
      expect(html).toContain(anchor);
    }
    // cad 1.10.0: New Blank Model in the File ▾ dropdown, and a collapse
    // chevron on every sidebar section header (setupCollapsiblePanels wires
    // them by class, so a stale page would leave all nine inert).
    expect(html).toContain('id="menu-new"');
    expect(html).toContain('class="panel-chevron"');
  });

  it("carries the mesh provider skeleton", () => {
    const html = read("mesh");
    // #menubar + #main arrived with mesh 3.0.0's unified chrome; style.css's
    // whole layout hangs off them.
    for (const anchor of [
      'id="loading"',
      'id="app"',
      'id="menubar"',
      'id="main"',
      'id="sidebar"',
      'id="render-root"',
      'id="find-bar"',
    ]) {
      expect(html).toContain(anchor);
    }
  });

  it("carries the View and Advanced menus (meshBody() replicates the providers' toolbar)", () => {
    // Node IDs / Grid / Screenshot live in #view-popup and Mesh Size / Spheres
    // / Face normals / Export skin / Lighting / Bookmarks in #advanced-popup,
    // both siblings of #toolbar — webview/main.ts looks them up by id, so a
    // stale meshBody() would leave every one of them dead in KKSS only.
    const html = read("mesh");
    expect(html).toContain('id="view-popup"');
    expect(html).toContain('id="advanced-popup"');
    for (const action of ["viewMenu", "advanced", "inspect"]) {
      expect(html).toContain(`data-action="${action}"`);
    }
    // "edges" is mesh 3.14.4's global edge-line toggle — it lives in the
    // visible #view-popup, not the hidden #menubar, so it is KKSS's only route
    // to it and there is no native-menu fallback if the markup goes stale.
    for (const action of ["nodeIds", "grid", "edges", "screenshot", "meshSize", "spheres", "normals", "exportSkin", "lighting", "bookmarks"]) {
      expect(html).toContain(`data-action="${action}"`);
    }
  });

  it("carries the redesigned Clip controls", () => {
    // mesh 3.0.0 reparents #cut-panel into the nav card; its Off/On toggle and
    // the Free oblique-normal inputs are new ids main.ts wires by hand.
    const html = read("mesh");
    for (const anchor of ['id="cut-toggle"', 'id="cut-free-inputs"', 'id="cut-normal-x"']) {
      expect(html).toContain(anchor);
    }
  });

  it("links design-system.css before style.css, then the KKSS overrides", () => {
    // style.css resolves 37 --ds-* tokens defined only in design-system.css, and
    // mesh-overrides.css hides the menubar — order decides all three.
    const html = read("mesh");
    const ds = html.indexOf("design-system.css");
    const style = html.indexOf("./style.css");
    const overrides = html.indexOf("mesh-overrides.css");
    expect(ds).toBeGreaterThan(-1);
    expect(style).toBeGreaterThan(ds);
    expect(overrides).toBeGreaterThan(style);
  });

  it("keeps vtk.js blob workers allowed in the mesh CSP", () => {
    expect(read("mesh")).toContain("worker-src blob:");
  });

  it("allows kkss-file fetches in the cad CSP (loadUrl pipeline)", () => {
    expect(read("cad")).toMatch(/connect-src[^;]*kkss-file:/);
  });
});
