import { describe, expect, it } from "vitest";
import { nextIterate, type Iterate, type SeekSpec } from "../app/main/services/workflows/goalSeek";

const spec: SeekSpec = { target: 10, relTolerance: 1e-3, lower: 0, upper: 100, maxStep: 50, maxSolves: 8, initialStep: 5 };
const f = (x: number) => 2 * x;
const run = (s: SeekSpec) => {
  const h: Iterate[] = [];
  for (;;) { const d = nextIterate(h, s); if (d.kind !== "next") return { d, h }; h.push({ x: d.x, y: f(d.x), state: "succeeded" }); }
};

describe("goal-seek", () => {
  it("converges on a linear response", () => {
    const { d, h } = run(spec);
    expect(d.kind).toBe("reached"); expect(h.length).toBeLessThanOrEqual(4);
  });
  it("stops, never continuing, on a failed or uncertain iterate", () => {
    expect(nextIterate([{ x: 1, y: null, state: "uncertain" }], spec).kind).toBe("stopped");
    expect(nextIterate([{ x: 1, y: 2, state: "failed" }], spec).kind).toBe("stopped");
  });
  it("reports not reached at the solve cap and when a bound binds", () => {
    expect(run({ ...spec, target: 1e9, upper: 100 }).d.kind).toBe("notReached");
    expect(run({ ...spec, maxSolves: 2, relTolerance: 1e-12, target: 11.1 }).d.kind).toBe("notReached");
  });
  it("clips steps and rejects bad specs", () => {
    const d = nextIterate([{ x: 50, y: 100, state: "succeeded" }, { x: 51, y: 102, state: "succeeded" }], { ...spec, maxStep: 1, target: 1000 });
    expect(d).toEqual({ kind: "next", x: 52 });
    expect(() => nextIterate([], { ...spec, lower: 5, upper: 5 })).toThrow();
  });
  it("starts at the clamped start value when given, else the midpoint", () => {
    expect(nextIterate([], spec)).toEqual({ kind: "next", x: 50 });
    expect(nextIterate([], { ...spec, start: 30 })).toEqual({ kind: "next", x: 30 });
    expect(nextIterate([], { ...spec, start: 500 })).toEqual({ kind: "next", x: 100 });
    expect(() => nextIterate([], { ...spec, start: Number.NaN })).toThrow();
  });
});
