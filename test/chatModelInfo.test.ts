/**
 * services/chat/modelInfo.ts — the context window and pricing table.
 *
 * The table's whole purpose is that a number shown to the user was reviewed by
 * a person. So these tests pin the key set (a new row is a visible diff, never
 * a silent one), check each row is internally coherent, and above all check
 * that an unrecognised model resolves to *nothing* — the sidebar then shows raw
 * token counts, which is the honest answer, instead of a fabricated price.
 */
import { describe, expect, it } from "vitest";
import { estimateCost, MODEL_INFO, modelInfo, parseCustomPricing, resolvePricing } from "../app/main/services/chat/modelInfo";

describe("the model table", () => {
  it("holds exactly the reviewed rows", () => {
    expect(Object.keys(MODEL_INFO).sort()).toEqual([
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "longcat-2.5-preview-free",
      "step-5-preview-free",
    ]);
  });

  it("gives every row a coherent window and price ladder", () => {
    for (const [name, info] of Object.entries(MODEL_INFO)) {
      expect(info.contextWindow, name).toBeGreaterThanOrEqual(200_000);
      if (info.inputPer1M === 0 && info.outputPer1M === 0) continue; // free tier: nothing to ladder
      expect(info.outputPer1M, name).toBeGreaterThan(info.inputPer1M);
      // A cache read must be cheaper than fresh input, or caching would be
      // pointless. A write must be dearer — unless the provider path never
      // bills it (0 on every OpenAI-compatible gateway, where TurnUsage
      // carries no write count at all).
      expect(info.cacheReadPer1M, name).toBeLessThan(info.inputPer1M);
      expect(info.cacheWritePer1M === 0 || info.cacheWritePer1M > info.inputPer1M, name).toBe(true);
    }
  });

  it("covers the model the app defaults to", () => {
    expect(modelInfo("claude-opus-4-8")).toMatchObject({ contextWindow: 1_000_000, inputPer1M: 5 });
  });

  it("resolves a dated snapshot id to its base model", () => {
    expect(modelInfo("claude-opus-4-8-20251101")).toBe(MODEL_INFO["claude-opus-4-8"]);
  });

  it("knows nothing about a model it has no figures for", () => {
    // The normal case for the OpenAI-compatible provider — and the one that
    // must never be papered over with a guess.
    expect(modelInfo("llama3.1:70b")).toBeNull();
    expect(modelInfo("gpt-4o")).toBeNull();
    expect(modelInfo("")).toBeNull();
    expect(modelInfo("claude-opus-4-8-not-a-date")).toBeNull();
  });

  it("prices the OpenCode defaults from reviewed gateway figures", () => {
    // Zen/Go ids where both gateways publish identical rates (OpenCode docs,
    // 2026-10-08) — one provider-blind row cannot misprice the other.
    expect(modelInfo("kimi-k2.7-code")).toMatchObject({ inputPer1M: 0.95, outputPer1M: 4 });
    expect(modelInfo("glm-5.3-flash")).toMatchObject({ inputPer1M: 0.15, outputPer1M: 0.5 });
    // The free defaults cost nothing on either gateway.
    for (const free of ["longcat-2.5-preview-free", "step-5-preview-free"]) {
      const info = modelInfo(free)!;
      expect(info).toMatchObject({ inputPer1M: 0, outputPer1M: 0 });
      expect(estimateCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, info)).toBe(0);
    }
  });
});

describe("estimateCost", () => {
  it("prices each token class at its own rate", () => {
    const info = MODEL_INFO["claude-opus-4-8"];
    // 1M uncached in ($5) + 1M out ($25) + 1M cache read ($0.50) + 1M write ($6.25)
    const cost = estimateCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, info);
    expect(cost).toBeCloseTo(36.75, 10);
  });

  it("is zero for a conversation that has spent nothing", () => {
    expect(estimateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, MODEL_INFO["claude-sonnet-5"])).toBe(0);
  });

  it("makes a cached read far cheaper than the same tokens uncached", () => {
    const info = MODEL_INFO["claude-opus-4-8"];
    const cached = estimateCost({ input: 0, output: 0, cacheRead: 500_000, cacheWrite: 0 }, info);
    const fresh = estimateCost({ input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 }, info);
    expect(cached).toBeLessThan(fresh);
  });
});

describe("user-supplied pricing", () => {
  it("never overrides a reviewed row", () => {
    const r = resolvePricing("claude-opus-4-8", { contextWindow: 10, inputPer1M: 99, outputPer1M: 99 });
    expect(r.userSupplied).toBe(false);
    expect(r.contextWindow).toBe(1_000_000);
    expect(r.rates?.inputPer1M).toBe(5);
  });

  it("resolves an unlisted model to nothing until the user supplies something", () => {
    expect(resolvePricing("llama3.1:70b", {})).toEqual({ contextWindow: undefined, rates: undefined, userSupplied: false });
  });

  it("prices only when both input and output rates are set", () => {
    expect(resolvePricing("llama3.1:70b", { inputPer1M: 1 }).rates).toBeUndefined();
    expect(resolvePricing("llama3.1:70b", { outputPer1M: 1 }).rates).toBeUndefined();
    const r = resolvePricing("llama3.1:70b", { inputPer1M: 1, outputPer1M: 4 });
    expect(r.userSupplied).toBe(true);
    expect(r.rates).toEqual({ inputPer1M: 1, outputPer1M: 4, cacheReadPer1M: 1, cacheWritePer1M: 1 });
  });

  it("honours explicit cache rates, including zero", () => {
    const r = resolvePricing("x", { inputPer1M: 2, outputPer1M: 4, cacheReadPer1M: 0.2, cacheWritePer1M: 0 });
    expect(r.rates).toMatchObject({ cacheReadPer1M: 0.2, cacheWritePer1M: 0 });
  });

  it("lets a context window stand alone", () => {
    const r = resolvePricing("x", { contextWindow: 32_000 });
    expect(r).toEqual({ contextWindow: 32_000, rates: undefined, userSupplied: true });
  });

  it("drops invalid stored values instead of producing NaN or negative rates", () => {
    expect(
      parseCustomPricing({ contextWindow: 1.5, inputPer1M: -1, outputPer1M: "3", cacheReadPer1M: NaN, cacheWritePer1M: Infinity })
    ).toEqual({});
    expect(parseCustomPricing({ contextWindow: 0, inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: undefined, cacheWritePer1M: null })).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
    });
  });
});
