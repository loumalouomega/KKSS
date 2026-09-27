import * as fs from "node:fs";
import * as path from "node:path";
import {
  fallbackMessage,
  parseRendererSetting,
  selectRendererAtHost,
  type RendererChoice,
  type RendererFallbackReason,
} from "../../../mesh/src/parser/render/rendererSelect";
// rendererSelect imports the kind but does not re-export it; the declaration
// lives with the backend-neutral rendering data it describes.
import type { RendererKind } from "../../../mesh/src/parser/render/types";
import { effective, entryForVscode } from "../services/settings/registry";
import { stateStore } from "../services/stateStore";

/**
 * The renderer backend decision for KKSS's mesh preview page, and the page
 * rewrite that carries it into the webview.
 *
 * mesh picks the backend in `mesh/src/previewHtml.ts` while it *builds* each
 * preview's HTML (mesh 4.8.0, roadmap item 18). KKSS cannot use that seam: its
 * mesh page is a build artifact (`tools/gen-webview-html.mjs` writes
 * `out/renderer/mesh/index.html` from `webviewChrome`'s own fragments), and the
 * `FakeWebviewPanel`'s `html` setter is inert by design (see meshHost.ts's
 * header). A setting the page is frozen against would be a row that silently
 * does nothing, so the host makes the same decision here — from the same pure
 * module mesh uses — and rewrites the served page instead.
 *
 * `app/main/protocol.ts` calls this for the one request path
 * (`/renderer/mesh/index.html`), so the decision is made per page load: exactly
 * upstream's "applies to previews opened from now on" semantics, and a reload
 * (every file open) is what picks up a change.
 *
 * The two rewrites are the same two CSP/attribute additions
 * `webviewChrome.buildCsp`/`buildPreviewHtml` make for VTK-wasm, and nothing
 * else moves: with vtk.js selected the served page is byte-for-byte the
 * generated one, and VTK-wasm's runtime needs no `'unsafe-eval'` (mesh rewrites
 * the glue at build time so it evaluates nothing) — only `'wasm-unsafe-eval'`
 * so WebAssembly may compile, and a `connect-src` that already allows this
 * scheme for the glue's own `.wasm` fetch.
 */

/** Where the prepared runtime lands, relative to the mesh page. */
const RUNTIME_DIR = "vtk-wasm";

/** The one file whose presence means the runtime is usable. */
const RUNTIME_MARKER = "vtkWebAssembly.wasm";

/**
 * The base URI handed to the webview, relative to the page
 * (`kkss://app/renderer/mesh/index.html`), so it resolves to the served runtime
 * directory. `createVtkWasmBackend` resolves it against `document.baseURI`
 * before importing the glue and pointing `locateFile` at the same directory.
 */
const RUNTIME_BASE = `./${RUNTIME_DIR}`;

export interface RendererDecision {
  renderer: RendererKind;
  /** Set when VTK-wasm was asked for and the host already ruled it out. */
  fallbackReason?: RendererFallbackReason;
  /** The runtime directory the webview may import from (VTK-wasm only). */
  base?: string;
}

/**
 * Reads the registry-backed setting. The stored value is passed in rather than
 * read here so the decision stays pure and testable — `stateStore` is bound to
 * Electron's userData dir, which does not exist in a unit test (the repo's
 * usual core/glue split, as in jsonStore.ts/stateStore.ts).
 */
function requestedRenderer(stored: unknown): RendererKind {
  const entry = entryForVscode("kratos.preview", "renderer");
  return parseRendererSetting(entry ? effective(entry, stored) : stored);
}

/** Whether the prepared VTK-wasm runtime ships in this installation. */
export function rendererAssetsPresent(outDir: string): boolean {
  return fs.existsSync(path.join(outDir, "renderer", "mesh", RUNTIME_DIR, RUNTIME_MARKER));
}

/**
 * The host-side half of mesh's `selectRendererAtHost`: VTK-wasm only when
 * requested AND its runtime is installed. Everything that can only be known
 * inside the webview (JSPI, WebGL2, a failed boot) is left to the webview,
 * which falls back there with a reason from the same vocabulary.
 */
export function rendererDecision(outDir: string, stored?: unknown): RendererDecision {
  const requested = requestedRenderer(stored);
  const choice: RendererChoice = selectRendererAtHost(
    requested,
    requested === "vtkwasm" && rendererAssetsPresent(outDir)
  );
  return {
    renderer: choice.renderer,
    fallbackReason: choice.fallbackReason,
    base: choice.renderer === "vtkwasm" ? RUNTIME_BASE : undefined,
  };
}

/**
 * Carries `decision` into the generated page: the body attributes
 * `webviewChrome.buildPreviewHtml` emits, and the one CSP token its `buildCsp`
 * adds. Kept as two precise substitutions with a hard failure if either anchor
 * is missing, so a page that stops being generated the way this expects breaks
 * loudly at page load instead of quietly falling back to vtk.js forever.
 */
export function applyRenderer(html: string, decision: RendererDecision): string {
  const wantsWasm = decision.renderer === "vtkwasm";
  const attributes =
    (wantsWasm ? ` data-renderer="vtkwasm" data-vtk-wasm-base="${decision.base ?? RUNTIME_BASE}"` : "") +
    (decision.fallbackReason ? ` data-renderer-fallback="${decision.fallbackReason}"` : "");
  // The generated page opens `<body>` bare, so the anchor is the tag name
  // itself and the attributes go in front of its `>`. A page that stopped being
  // generated that way must fail here, not silently keep serving vtk.js.
  const bodyAt = html.indexOf("<body");
  const headEnd = bodyAt < 0 ? -1 : html.indexOf(">", bodyAt);
  if (bodyAt < 0 || headEnd < 0 || /[^\s>]/.test(html[bodyAt + 5])) {
    throw new Error("mesh page: no <body> tag to carry the renderer attributes");
  }
  let out = attributes
    ? `${html.slice(0, headEnd)}${attributes}${html.slice(headEnd)}`
    : html;
  if (wantsWasm) {
    // `script-src kkss:` → the same scheme plus 'wasm-unsafe-eval'. Never
    // 'unsafe-eval': the prepared glue needs no dynamic code at all.
    const scriptSrc = /script-src ([^;"]*)/.exec(out);
    if (!scriptSrc) throw new Error("mesh page: no script-src to widen for VTK-wasm");
    out = out.replace(scriptSrc[0], `${scriptSrc[0]} 'wasm-unsafe-eval'`);
  }
  return out;
}

/**
 * The page as the webview receives it. One entry point so a caller can never
 * serve the generated file without the decision, and so the fallback note text
 * is available where the decision is taken.
 */
export function meshPage(outDir: string, html: string): string {
  const entry = entryForVscode("kratos.preview", "renderer");
  const stored = entry?.storeKey ? stateStore.get(entry.storeKey) : undefined;
  const decision = rendererDecision(outDir, stored);
  if (decision.fallbackReason) console.warn(`[kkss] ${fallbackMessage(decision.fallbackReason)}`);
  return applyRenderer(html, decision);
}
