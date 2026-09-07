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
import { estimateCost, MODEL_INFO, modelInfo } from "../app/main/services/chat/modelInfo";

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
    ]);
  });

  it("gives every row a coherent window and price ladder", () => {
    for (const [name, info] of Object.entries(MODEL_INFO)) {
      expect(info.contextWindow, name).toBeGreaterThanOrEqual(200_000);
      expect(info.outputPer1M, name).toBeGreaterThan(info.inputPer1M);
      // A cache read must be cheaper than fresh input and a write dearer,
      // or caching would be pointless / free respectively.
      expect(info.cacheReadPer1M, name).toBeLessThan(info.inputPer1M);
      expect(info.cacheWritePer1M, name).toBeGreaterThan(info.inputPer1M);
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
