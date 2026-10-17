import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SITE_BASE, rewriteExampleLinks, resolveDocsPath } from "../app/main/services/docsServe";

const docsRoot = path.resolve("/out/docs");

describe("resolveDocsPath", () => {
  it("resolves the site's pages inside the root", () => {
    expect(resolveDocsPath(docsRoot, "/")).toBe(path.join(docsRoot, "index.html"));
    expect(resolveDocsPath(docsRoot, "/index.html")).toBe(path.join(docsRoot, "index.html"));
    expect(resolveDocsPath(docsRoot, "/guide/cad-mode.html")).toBe(
      path.join(docsRoot, "guide", "cad-mode.html"),
    );
    expect(resolveDocsPath(docsRoot, "/assets/css/site.css")).toBe(
      path.join(docsRoot, "assets", "css", "site.css"),
    );
  });

  it("rejects path traversal and look-alike escapes", () => {
    expect(resolveDocsPath(docsRoot, "/../../etc/passwd")).toBeUndefined();
    expect(resolveDocsPath(docsRoot, "/guide/..%2F..%2Fetc/passwd")).toBeUndefined();
    expect(resolveDocsPath(docsRoot, "/%00.html")).toBeUndefined();
    expect(resolveDocsPath(docsRoot, "/guide%5C..%5Cwindows")).toBeUndefined(); // encoded backslash
    expect(resolveDocsPath(docsRoot, "/a/b/../../../out/x.js")).toBeUndefined();
  });

  it("still serves interesting-but-legal dot segments", () => {
    // `./` and one `..` that stays inside the root must not be refused.
    expect(resolveDocsPath(docsRoot, "/guide/../guide/index.html")).toBe(
      path.join(docsRoot, "guide", "index.html"),
    );
  });

  it("refuses a malformed percent-escape rather than guessing", () => {
    expect(resolveDocsPath(docsRoot, "/guide/%E0%A4%A.html")).toBeUndefined();
  });
});

describe("rewriteExampleLinks", () => {
  it("points the site's example downloads at the published site", () => {
    const html = '<a href="/KKSS/examples/tutorials/fluid.zip" download>fluid</a> and <a href="/KKSS/examples/kratos/cantilever/mesh.mdpa">mesh</a>';
    expect(rewriteExampleLinks(html)).toBe(
      `<a href="https://loumalouomega.github.io/KKSS/examples/tutorials/fluid.zip" download>fluid</a> and ` +
        `<a href="https://loumalouomega.github.io/KKSS/examples/kratos/cantilever/mesh.mdpa">mesh</a>`,
    );
    // The bare form is handled too, for a base-less site build.
    expect(rewriteExampleLinks('<a href="/examples/x.zip">x</a>')).toBe(
      '<a href="https://loumalouomega.github.io/KKSS/examples/x.zip">x</a>',
    );
  });

  it("leaves everything else alone", () => {
    const html = '<link href="/KKSS/assets/css/site.css" rel="stylesheet"/><a href="/KKSS/guide/cad-mode.html">x</a><a href="https://example.org">ext</a>';
    expect(rewriteExampleLinks(html)).toBe(html);
  });

  it("ignores non-href example paths", () => {
    const html = '<img src="/KKSS/examples/x.png">';
    expect(rewriteExampleLinks(html)).toBe(html);
  });
});

describe("SITE_BASE", () => {
  // Guards the constant against the docs base moving (a rename away from the
  // project-pages prefix would silently break every staged page). Only checked
  // when the site has been built — CI always builds first.
  const dist = path.join(__dirname, "..", "doc", ".vitepress", "dist", "index.html");
  it.skipIf(!fs.existsSync(dist))("matches the built site's public base", () => {
    const html = fs.readFileSync(dist, "utf8");
    expect(SITE_BASE).toBe("/KKSS");
    expect(html).toContain(`src="${SITE_BASE}/assets/`);
  });
});
