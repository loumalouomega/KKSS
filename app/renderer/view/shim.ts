/**
 * acquireVsCodeApi shim — the entire VS Code compatibility layer for the
 * unmodified extension webview bundles. Loaded before viewer.js / webview.js.
 *
 * Neither bundle uses getState/setState (verified), so they are no-ops.
 * Inbound host messages arrive as normal window "message" events via the
 * preload bridge; outbound postMessage goes to the Electron main process.
 */
interface KkssBridge {
  post(message: unknown): void;
  initialState?: { theme?: string };
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

export {};
