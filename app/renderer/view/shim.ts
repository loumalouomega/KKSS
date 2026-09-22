/**
 * acquireVsCodeApi shim — the entire VS Code compatibility layer for the
 * unmodified extension webview bundles. Loaded before viewer.js / webview.js.
 *
 * Neither bundle uses getState/setState (verified), so they are no-ops.
 * Inbound host messages arrive as normal window "message" events via the
 * preload bridge; outbound postMessage goes to the Electron main process.
 */
import "../appearance";

interface KkssBridge {
  post(message: unknown): void;
  initialState?: { theme?: string; flowgraphOrientation?: string };
}

declare global {
  interface Window {
    __kkss: KkssBridge;
    acquireVsCodeApi: () => {
      postMessage: (message: unknown) => void;
      getState: () => unknown;
      setState: (state: unknown) => void;
    };
  }
}

const bridge = window.__kkss;

window.acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => bridge.post(message),
  getState: () => undefined,
  setState: () => undefined,
});

// The mesh providers render <body data-theme="${savedTheme}"> server-side;
// replicate that from the persisted state before the bundle boots.
const theme = bridge.initialState?.theme;
if (theme) {
  document.body.dataset.theme = theme;
}

// mesh's previewHtml.ts bakes kratos.flowgraph.splitOrientation into
// <body data-flowgraph-orientation>; KKSS's page is prebuilt, so replicate it.
const orientation = bridge.initialState?.flowgraphOrientation;
if (orientation) {
  document.body.dataset.flowgraphOrientation = orientation;
}

// VS Code's theme-kind body class, set before the viewer bundle reads its
// palette at startup (the shared preload also applies it, and keeps it live —
// cad re-palettes on the change via its own MutationObserver).
const kind = window.kkssAppearance?.current()?.kind;
if (kind) {
  document.body.classList.add(kind);
  document.body.dataset.vscodeThemeKind = kind;
}

// The mesh scene's "auto" theme samples the body background only when it is
// applied (startup, or its own theme picker). mesh-overrides.css hides that
// picker, but it still exists and its change handler re-runs applyTheme — so
// re-firing it with "auto" re-samples the new palette live, without touching
// mesh. Only for "auto": an explicit scene theme is independent of the UI one.
window.kkssAppearance?.onChange(() => {
  const select = document.getElementById("theme-select") as HTMLSelectElement | null;
  if (select?.value === "auto") select.dispatchEvent(new Event("change"));
});

export {};
