/**
 * services/chat/providers/anthropic.ts — the pure halves.
 *
 * The provider itself needs the SDK and a network, but the two decisions worth
 * pinning don't: how a Usage object becomes KKSS's neutral shape, and how a
 * failure is classified. The second one is load-bearing twice over — it picks
 * the banner the user sees, and it decides whether the conservative retry runs
 * at all.
 */
import { describe, expect, it } from "vitest";
import { isContextOverflow, mapAnthropicUsage } from "../app/main/services/chat/providers/anthropic";

describe("mapAnthropicUsage", () => {
  it("keeps the cache figures separate from input", () => {
    // The API bills cache reads/writes *in addition to* input_tokens rather
    // than inside it, so a caller measuring context must add all three. Folding
    // them into `input` here would double-count them later.
    expect(
      mapAnthropicUsage({
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 30,
      })
    ).toEqual({ input: 120, output: 40, cacheRead: 9000, cacheWrite: 30 });
  });

  it("treats the nullable cache fields as zero", () => {
    // Both are `number | null` in the SDK types, and null is what an
    // uncached request returns.
    expect(mapAnthropicUsage({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null })).toEqual({
      input: 5,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("survives a usage object with nothing in it", () => {
    expect(mapAnthropicUsage({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("isContextOverflow", () => {
  it("recognises the API's own wording for an over-length prompt", () => {
    // This gate does two things: it picks the "context" error kind, and it
    // suppresses the conservative retry — which lowers max_tokens and so can
    // never fix a prompt that is itself too long, costing a wasted round trip
    // and then reporting the retry's error instead of the real one.
    expect(isContextOverflow("prompt is too long: 1051277 tokens > 1000000 maximum")).toBe(true);
    expect(isContextOverflow("input length exceeds the context window")).toBe(true);
    expect(isContextOverflow("context_length_exceeded")).toBe(true);
  });

  it("leaves every other 400 to the retry path", () => {
    // These are exactly the errors the conservative retry exists for.
    expect(isContextOverflow("thinking.type: Input tag 'adaptive' found using 'type'")).toBe(false);
    expect(isContextOverflow("max_tokens: 16000 > 8192, which is the maximum")).toBe(false);
    expect(isContextOverflow("")).toBe(false);
  });
});
