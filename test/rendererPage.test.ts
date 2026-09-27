/**
 * app/main/mesh/rendererPage.ts — the renderer decision KKSS makes per mesh
 * page load, and the two rewrites that carry it into the webview.
 *
 * mesh 4.8.0 picks the backend (vtk.js | VTK-wasm) in `previewHtml.ts` while it
 * BUILDS a preview's HTML. KKSS cannot use that seam — its page is a build
 * artifact and the fake webview discards the providers' HTML — so this is the
 * same decision, taken here with mesh's own pure module, and applied by
 * rewriting the served page.
 *
 * Two properties are defended here. First, vtk.js is the untouched default:
 * with it selected the served page must be byte-for-byte the generated one, and
 * the CSP must gain nothing (upstream's "nothing weakens the default"). Second,
 * VTK-wasm's widening must be exactly what `webviewChrome.buildCsp` does — one
 * `'wasm-unsafe-eval'`, never `'unsafe-eval'` — since a rewrite that quietly
 * widened more would be a CSP regression the generated page cannot show.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyRenderer, rendererAssetsPresent, rendererDecision } from "../app/main/mesh/rendererPage";

/** A stand-in for the generated page: the anchors the rewrite relies on. The
 *  body is emitted BARE by `tools/webviewMarkup.ts`, which is the case that has
 *  to work; a tagged one is covered too, since that is what upstream emits. */
const PAGE = [
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src kkss: https: data: blob:; style-src kkss: \'unsafe-inline\'; script-src kkss:; worker-src blob:; connect-src kkss: blob: data:" />',
  "<body>",
  '<div id="app"></div>',
].join("\n");

const TAGGED_PAGE = PAGE.replace("<body>", '<body data-theme="dark">');

describe("applyRenderer", () => {
  it("leaves the page byte-identical for vtk.js", () => {
    for (const page of [PAGE, TAGGED_PAGE]) {
      for (const decision of [
        { renderer: "vtkjs" as const },
        { renderer: "vtkjs" as const, base: "./vtk-wasm" },
      ]) {
        expect(applyRenderer(page, decision)).toBe(page);
      }
    }
  });

  it("carries VTK-wasm the way buildPreviewHtml does", () => {
    const html = applyRenderer(PAGE, { renderer: "vtkwasm", base: "./vtk-wasm" });
    // The attributes webview/main.ts reads (dataset.renderer /
    // dataset.vtkWasmBase).
    expect(html).toContain('<body data-renderer="vtkwasm" data-vtk-wasm-base="./vtk-wasm">');
    expect(applyRenderer(TAGGED_PAGE, { renderer: "vtkwasm", base: "./vtk-wasm" })).toContain(
      '<body data-theme="dark" data-renderer="vtkwasm" data-vtk-wasm-base="./vtk-wasm">'
    );
    // buildCsp's one addition, and nothing else.
    expect(html).toContain("script-src kkss: 'wasm-unsafe-eval'");
    expect(html).not.toContain("'unsafe-eval'");
    expect(html).toContain("connect-src kkss: blob: data:");
  });

  it("announces a host-side fallback without switching renderer", () => {
    // What mesh emits when the setting asks for VTK-wasm and the runtime is not
    // installed: no data-renderer (so the webview boots vtk.js) plus the reason,
    // which main.ts turns into the same one-line status note.
    const html = applyRenderer(PAGE, { renderer: "vtkjs", fallbackReason: "assets-missing" });
    expect(html).toContain('data-renderer-fallback="assets-missing"');
    expect(html).not.toContain('data-renderer="vtkwasm"');
    expect(html).not.toContain("wasm-unsafe-eval");
  });

  it("fails loudly rather than silently serving the default", () => {
    // A page that stopped being generated the way the rewrite expects would
    // otherwise fall back to vtk.js forever, with nothing to show for it.
    expect(() => applyRenderer("<html></html>", { renderer: "vtkwasm", base: "./vtk-wasm" })).toThrow(
      /<body>/,
    );
    // A near-miss anchor must fail too, rather than matching some other tag.
    expect(() =>
      applyRenderer('<meta content="default-src \'none\'" /><bodyy data-theme="dark">', {
        renderer: "vtkwasm",
        base: "./vtk-wasm",
      }),
    ).toThrow(/<body>/);
    expect(() =>
      applyRenderer('<meta content="default-src \'none\'" /><body data-theme="dark">', {
        renderer: "vtkwasm",
        base: "./vtk-wasm",
      }),
    ).toThrow(/script-src/);
  });
});

describe("rendererDecision", () => {
  const marker = (dir: string) =>
    path.join(dir, "renderer", "mesh", "vtk-wasm", "vtkWebAssembly.wasm");

  it("reads the runtime's presence out of the bundle directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-renderer-"));
    try {
      expect(rendererAssetsPresent(dir)).toBe(false);
      const wasm = marker(dir);

      fs.mkdirSync(path.dirname(wasm), { recursive: true });
      fs.writeFileSync(wasm, "");
      expect(rendererAssetsPresent(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never routes to VTK-wasm in an installation without the runtime", () => {
    // The setting asks for it, but the runtime is not installed: mesh's
    // `selectRendererAtHost` turns that into vtk.js plus the reason the webview
    // shows, rather than a page that cannot boot.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-renderer-"));
    try {
      expect(rendererDecision(dir, "vtkwasm")).toEqual({
        renderer: "vtkjs",
        fallbackReason: "assets-missing",
        base: undefined,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("selects VTK-wasm only when it is both asked for and installed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkss-renderer-"));
    try {
      const wasm = path.join(dir, "renderer", "mesh", "vtk-wasm", "vtkWebAssembly.wasm");
      fs.mkdirSync(path.dirname(wasm), { recursive: true });
      fs.writeFileSync(wasm, "");
      expect(rendererDecision(dir, "vtkwasm")).toEqual({
        renderer: "vtkwasm",
        fallbackReason: undefined,
        base: "./vtk-wasm",
      });
      // vtk.js stays the default when the runtime is merely present.
      expect(rendererDecision(dir, undefined)).toMatchObject({ renderer: "vtkjs" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
