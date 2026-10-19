/**
 * Custom URL schemes.
 *
 *  kkss://app/<path>          — app assets, served only from out/ (this
 *                               bundle's directory). Used for the shell,
 *                               picker, and the two webview pages. The mesh
 *                               page is the ONE asset not served verbatim: it
 *                               carries the renderer decision (mesh 4.8.0's
 *                               `kratos.preview.renderer`), which upstream
 *                               bakes in while building a preview's HTML and
 *                               KKSS — whose page is a build artifact — makes
 *                               per load here. See mesh/rendererPage.ts.
 *  kkss://docs/<path>         — the in-app manual (Help ▸ KKSS Manual…): the
 *                               documentation site built into out/docs/
 *                               (doc/.vitepress/dist, staged by esbuild —
 *                               the ~28 MB examples tree stays an
 *                               online-only concern, its links rewritten to
 *                               the published site per docsServe.ts). Host
 *                               label `docs` under the kkss scheme, so the
 *                               manual window is a distinct origin from
 *                               the app pages.
 *  kkss-file://local/<enc>    — user files, served only from registered
 *                               allowed roots (the open document's directory).
 *                               Electron's replacement for VS Code's
 *                               asWebviewUri/localResourceRoots pair; cad's
 *                               "loadUrl" strategy fetches these.
 */
import { protocol, net } from "electron";
import * as fs from "node:fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { isInsideRoot, isPathAllowed } from "./pathGuard";
import { meshPage } from "./mesh/rendererPage";
import { manualFallbackHtml, resolveDocsPath, SITE_BASE } from "./services/docsServe";

/** The one generated page the host rewrites on the way out. */
const MESH_PAGE = "/renderer/mesh/index.html";

const allowedRoots = new Set<string>();

/** Must run before app.whenReady(). */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "kkss", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    // corsEnabled: the CAD page (origin kkss://app) fetches user files
    // cross-origin through kkss-file:// (cad's "loadUrl" strategy for the
    // three.js-native mesh formats .stl/.obj/.ply/.gltf/…). Without it the
    // fetch dies as a CORS error and the model never loads. The handler
    // below still serves only registered allowed roots, so this widens
    // nothing on the file side.
    { scheme: "kkss-file", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

/** Allow serving files under `dir` via kkss-file:// (mirrors localResourceRoots). */
export function allowRoot(dir: string): void {
  allowedRoots.add(path.resolve(dir));
}

export function toKkssUrl(fsPath: string): string {
  return `kkss-file://local/${encodeURIComponent(path.resolve(fsPath))}`;
}

function isAllowed(fsPath: string): boolean {
  return isPathAllowed(allowedRoots, fsPath);
}

/** Must run after app.whenReady(). `outDir` is the bundle dir (out/). */
export function installProtocolHandlers(outDir: string): void {
  const appRoot = path.resolve(outDir);

  protocol.handle("kkss", (request) => {
    const url = new URL(request.url);

    // The manual: kkss://docs/<site path> serves the built docs site. The
    // built pages carry the site's public base (SITE_BASE, `/KKSS/`) in every
    // asset and page link, so requests arrive with it; strip it before
    // resolving inside out/docs. The request is refused outright for anything
    // `resolveDocsPath` will not keep inside the tree; a missing file (or a
    // checkout with no manual at all) gets the one-command fallback page
    // instead of a bare 404.
    if (url.host === "docs") {
      const pathname = url.pathname.startsWith(`${SITE_BASE}/`)
        ? url.pathname.slice(SITE_BASE.length)
        : url.pathname;
      const fsPath = resolveDocsPath(path.join(appRoot, "docs"), pathname);
      if (!fsPath) return new Response("Forbidden", { status: 403 });
      if (!fs.existsSync(fsPath)) {
        return new Response(manualFallbackHtml(), {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return net.fetch(pathToFileURL(fsPath).toString());
    }

    const rel = decodeURIComponent(url.pathname);
    const fsPath = path.normalize(path.join(appRoot, rel));
    if (!isInsideRoot(appRoot, fsPath)) {
      return new Response("Forbidden", { status: 403 });
    }
    // The mesh page is the one asset whose bytes depend on state: the renderer
    // backend is chosen per page load, the way mesh chooses it per preview
    // build. Everything else — the bundles, the styles, the VTK-wasm runtime
    // itself — is served straight off disk.
    if (rel === MESH_PAGE) {
      return new Response(meshPage(outDir, fs.readFileSync(fsPath, "utf8")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return net.fetch(pathToFileURL(fsPath).toString());
  });

  protocol.handle("kkss-file", (request) => {
    const url = new URL(request.url);
    const fsPath = path.resolve(decodeURIComponent(url.pathname.replace(/^\//, "")));
    if (!isAllowed(fsPath)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(fsPath).toString());
  });
}
