/**
 * services/chat/compaction.ts — clearing old tool-result text from requests.
 *
 * Two properties carry the whole design, and both are pinned here: the pass
 * never touches its input (the stored transcript and the sidebar keep the full
 * text), and advancing the boundary always makes progress and always terminates.
 */
import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  clearableCount,
  CLEARED_PLACEHOLDER,
  isClearable,
  nextCount,
} from "../app/main/services/chat/compaction";
import type { ChatEntry } from "../app/main/services/chat/transcript";

const call = (id: string): ChatEntry => ({ kind: "toolCall", callId: id, server: "cad", tool: "inspect", argsJson: "{}" });
const result = (id: string, text = `result ${id}`, ok = true): ChatEntry => ({ kind: "toolResult", callId: id, ok, text });

/** A conversation of `n` tool round trips, each preceded by a user message. */
const conversation = (n: number): ChatEntry[] =>
  Array.from({ length: n }, (_, i) => [
    { kind: "user", text: `ask ${i}` } as ChatEntry,
    call(`c${i}`),
    result(`c${i}`),
  ]).flat();

describe("isClearable", () => {
  it("accepts a successful tool result and nothing else", () => {
    expect(isClearable(result("c1"))).toBe(true);
    expect(isClearable(call("c1"))).toBe(false);
    expect(isClearable({ kind: "user", text: "hi" })).toBe(false);
    expect(isClearable({ kind: "assistant", text: "hi" })).toBe(false);
  });

  it("refuses a failed result, including a denial", () => {
    // A denied call's text tells the model not to retry; the placeholder tells
    // it the opposite, and re-running would re-open the approval prompt.
    expect(isClearable(result("c1", "Denied by the user. Do not retry.", false))).toBe(false);
    expect(isClearable(result("c1", "Tool call failed: ENOENT", false))).toBe(false);
  });

  it("refuses one it has already cleared, so a count cannot be spent twice", () => {
    expect(isClearable(result("c1", CLEARED_PLACEHOLDER))).toBe(false);
  });
});

describe("applyCompaction", () => {
  it("clears the oldest results and leaves the newest intact", () => {
    const out = applyCompaction(conversation(3), 2);
    const texts = out.filter((e) => e.kind === "toolResult").map((e) => (e as { text: string }).text);
    expect(texts).toEqual([CLEARED_PLACEHOLDER, CLEARED_PLACEHOLDER, "result c2"]);
  });

  it("never mutates its input, and never hands back the caller's array", () => {
    // Both halves matter: requestEntries() writes the context suffix into the
    // array it is given, and the sidebar plus the store still hold these objects.
    const entries = conversation(2);
    const snapshot = JSON.parse(JSON.stringify(entries));
    const out = applyCompaction(entries, 2);
    expect(entries).toEqual(snapshot);
    expect(out).not.toBe(entries);
    expect(out[2]).not.toBe(entries[2]);
  });

  it("allocates even when there is nothing to do", () => {
    const entries = conversation(1);
    expect(applyCompaction(entries, 0)).not.toBe(entries);
    expect(applyCompaction(entries, 0)).toEqual(entries);
  });

  it("clamps a count larger than the transcript — clearing more, never less", () => {
    // The direction a stale boundary must fail in.
    const out = applyCompaction(conversation(2), 99);
    expect(clearableCount(out)).toBe(0);
  });

  it("leaves a denied result alone even when it precedes the boundary", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "go" },
      call("c0"),
      result("c0", "Denied by the user.", false),
      call("c1"),
      result("c1", "real output"),
    ];
    const out = applyCompaction(entries, 5);
    expect((out[2] as { text: string }).text).toBe("Denied by the user.");
    expect((out[4] as { text: string }).text).toBe(CLEARED_PLACEHOLDER);
  });

  it("uses a non-empty placeholder", () => {
    // An empty content block is rejected outright by some block shapes.
    expect(CLEARED_PLACEHOLDER.length).toBeGreaterThan(0);
  });
});

describe("nextCount", () => {
  it("returns null when there is nothing left to clear", () => {
    expect(nextCount(conversation(0), 0)).toBeNull();
    expect(nextCount(conversation(4), 4)).toBeNull();
    expect(nextCount(conversation(4), 99)).toBeNull();
  });

  it("always advances by at least one", () => {
    expect(nextCount(conversation(1), 0)).toBe(1);
    expect(nextCount(conversation(3), 2)).toBe(3);
  });

  it("halves what remains rather than stepping a fixed amount", () => {
    // A fixed step would blank the whole tool history whenever prose is what is
    // actually filling the window.
    expect(nextCount(conversation(8), 0)).toBe(4);
    expect(nextCount(conversation(8), 4)).toBe(6);
  });

  it("reaches a fixpoint, strictly increasing all the way", () => {
    const entries = conversation(10);
    let count = 0;
    let steps = 0;
    for (;;) {
      const next = nextCount(entries, count);
      if (next === null) break;
      expect(next).toBeGreaterThan(count);
      count = next;
      expect(++steps).toBeLessThan(50); // must terminate, and quickly
    }
    expect(count).toBe(10);
    expect(clearableCount(applyCompaction(entries, count))).toBe(0);
  });

  it("ignores duplicate call ids — the boundary is a count, not an identity", () => {
    // A gateway that streams no tool-call ids gets synthetic call_0, call_1…
    // reused every iteration. An id-anchored boundary could move backwards here.
    const entries: ChatEntry[] = [
      { kind: "user", text: "go" },
      call("call_0"),
      result("call_0", "first"),
      call("call_0"),
      result("call_0", "second"),
    ];
    expect(nextCount(entries, 0)).toBe(1);
    const out = applyCompaction(entries, 1);
    expect((out[2] as { text: string }).text).toBe(CLEARED_PLACEHOLDER);
    expect((out[4] as { text: string }).text).toBe("second");
  });
});
