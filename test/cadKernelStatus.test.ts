/**
 * app/main/cadKernelStatus.ts — the status bar's "OCCT ready · Gmsh ready".
 *
 * The reducer is cad's own; what is KKSS's to defend is the *feeding* of it: the
 * worker's RPC names are not all cad's `DocumentPipeline` names, and an unmapped
 * one reads as "touches no kernel", so OCCT would sit at "Kernels idle" after a
 * perfectly good open.
 */
import { describe, expect, it, vi } from "vitest";
import { KERNELS_BY_FUNCTION, describeKernelState, kernelsFor } from "../cad/src/kernelActivity";
import { KKSS_FN_ALIAS, createKernelTracker } from "../app/main/cadKernelStatus";
import { cadCompute } from "../app/main/cadComputeClient";

describe("kernel tracker", () => {
  it("starts idle", () => {
    expect(describeKernelState(createKernelTracker().state())).toEqual({ text: "Kernels idle", tone: "idle" });
  });

  it("loads OCCT on the main B-rep load's KKSS spelling, and reads ready on success", () => {
    const t = createKernelTracker();
    t.start("loadBRepCachedInWorker");
    expect(t.state().occt).toBe("loading");
    t.success("loadBRepCachedInWorker");
    expect(describeKernelState(t.state())).toEqual({ text: "OCCT ready", tone: "ready" });
  });

  it("a failed first call leaves the kernel cold again", () => {
    const t = createKernelTracker();
    t.start("generateMesh");
    t.failure("generateMesh");
    expect(t.state().gmsh).toBe("idle");
  });

  it("a worker death resets every kernel", () => {
    const t = createKernelTracker();
    t.start("loadBRep");
    t.success("loadBRep");
    t.reset();
    expect(t.state().occt).toBe("idle");
  });

  it("notifies only on a real change, and unsubscribes", () => {
    const t = createKernelTracker();
    const seen = vi.fn();
    const off = t.subscribe(seen);
    t.start("loadBRep"); // idle → loading
    t.start("loadBRep"); // already loading: no change
    t.success("loadBRep"); // → ready
    t.success("loadBRep"); // already ready
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    t.reset();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("releasing the cache touches no kernel", () => {
    const t = createKernelTracker();
    t.start("releaseBRepCache");
    expect(t.state()).toEqual(createKernelTracker().state());
  });
});

describe("KKSS RPC names", () => {
  // These legitimately touch no WASM kernel (CPU-only three.js/STL work) or are
  // KKSS-side; everything else must resolve to a kernel or an explicit alias.
  const NO_KERNEL = new Set(["buildPartsFromMeshioRegions", "fitMeshRegion", "searchStandardParts", "downloadStandardPart"]);

  it("every cadCompute method is known to cad's table, aliased, or explicitly kernel-free", () => {
    for (const method of Object.keys(cadCompute)) {
      const name = KKSS_FN_ALIAS[method] ?? method;
      const known = name in KERNELS_BY_FUNCTION;
      expect(known || NO_KERNEL.has(method), `${method} is unmapped — it would read as touching no kernel`).toBe(true);
    }
  });

  it("aliases point at real pipeline keys", () => {
    for (const target of Object.values(KKSS_FN_ALIAS)) expect(target in KERNELS_BY_FUNCTION).toBe(true);
    expect(kernelsFor(KKSS_FN_ALIAS.loadBRepCachedInWorker)).toEqual(["occt"]);
  });
});
