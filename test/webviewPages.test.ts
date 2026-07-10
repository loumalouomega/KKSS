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
  });

  it("carries the mesh provider skeleton", () => {
    const html = read("mesh");
    for (const anchor of ['id="loading"', 'id="app"', 'id="sidebar"', 'id="render-root"', 'id="find-bar"']) {
      expect(html).toContain(anchor);
    }
  });

  it("keeps vtk.js blob workers allowed in the mesh CSP", () => {
    expect(read("mesh")).toContain("worker-src blob:");
  });

  it("allows kkss-file fetches in the cad CSP (loadUrl pipeline)", () => {
    expect(read("cad")).toMatch(/connect-src[^;]*kkss-file:/);
  });
});
