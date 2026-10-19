/**
 * Serving the in-app manual (Help ▸ KKSS Manual…) — the pure half of the
 * `kkss://docs/*` host branch in protocol.ts, Electron-free so `test/` can
 * exercise it directly.
 *
 * The manual is the built documentation site (VitePress `dist/`), staged by
 * `esbuild.mjs`'s `copyArtifacts()` into `out/docs/` — everything but the
 * `examples/` tree, whose ~28 MB of downloadable tutorial cases stay a
 * website concern (their links are rewritten to the published site, see
 * `rewriteExampleLinks`). `out/**` is what the packaged app ships, so the
 * manual is always present in an installer; in a dev checkout it exists once
 * `npm run docs:build` has run, and a missing tree gets the fallback page
 * from `manualFallbackHtml` rather than an error the user can't act on.
 *
 * Same-origin rules: the manual window's documents live on `kkss://docs`
 * (the site's own host label under the `kkss` scheme), while the app pages
 * stay on `kkss://app` — a different origin, so the site's scripts cannot
 * touch the app's IPC surface (contextIsolation aside, the schemes already
 * split them).
 */
import * as path from "path";

/** Serve an `index.html` for the bare docs root. */
export const DOCS_INDEX = "index.html";

/**
 * Resolve a request path under the manual's root to a file inside `docsRoot`,
 * or `undefined` when the request must be refused: dot-dot traversal, NUL
 * bytes, or anything that escapes `docsRoot` after normalization — the exact
 * check `kkss://app`'s own handler applies to its bundle root.
 *
 * A bare path resolves to the site's `index.html`; every other segment is
 * appended and must still land inside `docsRoot` (the double-check matters:
 * `pathname` is attacker-influenced text, so normalization alone is not the
 * gate — the containment check is).
 */
export function resolveDocsPath(docsRoot: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined; // malformed percent-encoding
  }
  if (decoded.includes("\0")) return undefined;
  let rel = decoded.replace(/^\/+/, ""); // strip the leading slash(es)
  if (rel === "") rel = DOCS_INDEX;
  if (rel.includes("\\")) return undefined; // Windows separator — never resolve
  const fsPath = path.normalize(path.join(docsRoot, rel));
  const rootWithSep = docsRoot.endsWith(path.sep) ? docsRoot : docsRoot + path.sep;
  if (!fsPath.startsWith(rootWithSep)) return undefined;
  return fsPath;
}

const SITE_URL = "https://loumalouomega.github.io/KKSS";

/**
 * The site's public base (VitePress `base: '/KKSS/'` for the project-pages
 * deployment): every asset and page link in `dist` starts with it, so both
 * the server-side resolution (protocol.ts strips it before
 * `resolveDocsPath`) and the example-link rewrite below use this constant —
 * the shipped pages are useless without it.
 */
export const SITE_BASE = "/KKSS";

/**
 * The site's `dist` skips the ~28 MB of downloadable tutorial/kratos cases
 * (the `examples/` tree), so its pages carry example links that do not
 * resolve inside the app. This rewrite sends them to the published site —
 * the manual window intercepts external navigations and opens them in the
 * OS browser (see services/manual.ts), so the click ends up exactly where
 * the same link on the website goes.
 *
 * The built pages write them SITE_BASE-prefixed (`/KKSS/examples/…`) — the
 * base-prefixed form is what `dist` carries; the bare form stays handled for
 * a base-less site build. Only hrefs are rewritten; the docs ship no src
 * under examples.
 */
export function rewriteExampleLinks(html: string): string {
  const esc = SITE_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const baseForm = new RegExp(`(href\\s*=\\s*["'])${esc}/examples/`, "gi");
  return html.replace(baseForm, `$1${SITE_URL}/examples/`).replace(
    /(href\s*=\s*["'])\/examples\//gi,
    `$1${SITE_URL}/examples/`,
  );
}

/**
 * The page served for `kkss://docs/…` when the site has not been built (a
 * dev checkout without `npm run docs:build`). States the one command; never
 * an error page the user cannot act on.
 */
export function manualFallbackHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  body { font-family: system-ui, sans-serif; background: #1e1e1e; color: #ddd; display: grid; place-content: center; min-height: 96vh; margin: 0; }
  main { max-width: 34rem; line-height: 1.6; }
  h1 { font-size: 1.2rem; }
  code { background: #2a2a2a; padding: .15em .4em; border-radius: 4px; }
</style>
</head>
<body>
<main>
<h1>The manual is not built in this checkout</h1>
<p>
  The in-app manual is the documentation site compiled by
  <code>npm run docs:build</code> into <code>doc/.vitepress/dist</code>, which
  the build stages into <code>out/docs</code>. Packaged KKSS always ships a
  built manual; this is a development checkout.
</p>
<p>
  Until it is built, the documentation is available online at
  <a href="${SITE_URL}">${SITE_URL}</a> (links open in your browser).
</p>
</main>
</body>
</html>
`;
}
