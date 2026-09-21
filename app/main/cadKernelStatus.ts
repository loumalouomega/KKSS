/**
 * Kernel-readiness tracker for the status bar's "OCCT ready · Gmsh ready" line
 * (cad 3.0.0). The Electron-free half of cadComputeClient.ts, split out so the
 * alias table below is unit-testable — same shape as jsonStore.ts under
 * stateStore.ts.
 *
 * cad infers readiness from calls in `kernelClient.ts` (a forked child). KKSS
 * runs the same handler set in one persistent worker thread, so the client that
 * owns that worker feeds this tracker instead. The reducer is cad's own
 * (`kernelActivity.ts`, vscode-free), imported verbatim.
 */
import {
  initialKernelState,
  reduceKernelState,
  type KernelEvent,
  type KernelState,
} from "../../cad/src/kernelActivity";

/**
 * RPC names KKSS spells differently from cad's `DocumentPipeline`, which is what
 * `kernelsFor` keys on. Left unmapped they would read as "touches no kernel", so
 * OCCT would never show ready after a plain open — the one call that matters.
 * Every other `cadCompute` method name already matches a pipeline key exactly.
 */
export const KKSS_FN_ALIAS: Readonly<Record<string, string>> = {
  loadBRepCachedInWorker: "loadBRepCachedForDocument",
  releaseBRepCache: "disposeBRepCacheForDocument",
};

export interface KernelTracker {
  state(): KernelState;
  /** Fires only when the state actually changed. Returns an unsubscribe. */
  subscribe(listener: (state: KernelState) => void): () => void;
  start(fn: string): void;
  success(fn: string): void;
  failure(fn: string): void;
  /** The worker died — every kernel went with it. */
  reset(): void;
}

export function createKernelTracker(): KernelTracker {
  let state: KernelState = initialKernelState();
  const listeners = new Set<(state: KernelState) => void>();

  function emit(ev: KernelEvent): void {
    const next = reduceKernelState(state, ev);
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l(state);
  }
  const named = (fn: string): string => KKSS_FN_ALIAS[fn] ?? fn;

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start: (fn) => emit({ type: "start", fn: named(fn) }),
    success: (fn) => emit({ type: "success", fn: named(fn) }),
    failure: (fn) => emit({ type: "failure", fn: named(fn) }),
    reset: () => emit({ type: "reset" }),
  };
}
