import { describe, expect, it } from "vitest";
import {
  BUBBLE_KEYS, EXPRESSIONS, INITIAL_SIGNALS, reduceSignals, stateOf,
} from "../app/renderer/chat/kratyCore";
import type { KratyEvent, KratyState } from "../app/renderer/chat/kratyCore";
import en from "../app/shared/i18n/en.json";
import es from "../app/shared/i18n/es.json";

const run = (events: KratyEvent[]) => events.reduce(reduceSignals, INITIAL_SIGNALS);
const STATES = Object.keys(EXPRESSIONS) as KratyState[];

describe("kraty state mapping", () => {
  it("starts idle", () => expect(stateOf(INITIAL_SIGNALS)).toBe("idle"));

  it("walks a normal turn: waiting → writing → finished", () => {
    let s = run([{ type: "busy", busy: true }, { type: "assistantStart" }]);
    expect(stateOf(s)).toBe("waiting");
    s = reduceSignals(s, { type: "assistantDelta" });
    expect(stateOf(s)).toBe("writing");
    s = [{ type: "assistantDone" }, { type: "busy", busy: false }].reduce((acc, e) => reduceSignals(acc, e as KratyEvent), s);
    expect(stateOf(s)).toBe("finished");
  });

  it("a tool call with no result is working; its result ends that", () => {
    let s = run([{ type: "busy", busy: true }, { type: "toolCall", callId: "a" }]);
    expect(stateOf(s)).toBe("working");
    s = reduceSignals(s, { type: "toolResult", callId: "a" });
    expect(stateOf(s)).toBe("waiting");
  });

  it("an approval beats a running call", () => {
    const s = run([{ type: "busy", busy: true }, { type: "toolCall", callId: "a" }, { type: "approvalRequest" }]);
    expect(stateOf(s)).toBe("needsYou");
    expect(stateOf(reduceSignals(s, { type: "approvalResolved" }))).toBe("working");
  });

  it("an error entry shows once the turn ends, and the next turn clears it", () => {
    let s = run([{ type: "busy", busy: true }, { type: "error" }]);
    expect(stateOf(s)).toBe("waiting");
    s = reduceSignals(s, { type: "busy", busy: false });
    expect(stateOf(s)).toBe("error");
    expect(stateOf(reduceSignals(s, { type: "busy", busy: true }))).toBe("waiting");
  });

  it("a stopped turn drops open calls and approval", () => {
    const s = run([{ type: "busy", busy: true }, { type: "toolCall", callId: "a" }, { type: "approvalRequest" }, { type: "busy", busy: false }]);
    expect(s.openCalls).toEqual([]);
    expect(s.approval).toBe(false);
  });

  it("a replay restores a blocked turn and ignores stale calls when idle", () => {
    expect(stateOf(run([{ type: "replay", busy: true, openCalls: ["a"], approval: true, lastIsError: false }]))).toBe("needsYou");
    expect(stateOf(run([{ type: "replay", busy: false, openCalls: ["a"], approval: false, lastIsError: false }]))).toBe("idle");
    expect(stateOf(run([{ type: "replay", busy: false, openCalls: [], approval: false, lastIsError: true }]))).toBe("error");
  });

  it("duplicate call ids do not double-count", () => {
    const s = run([{ type: "busy", busy: true }, { type: "toolCall", callId: "a" }, { type: "toolCall", callId: "a" }, { type: "toolResult", callId: "a" }]);
    expect(s.openCalls).toEqual([]);
  });
});

describe("kraty data tables", () => {
  it("every state has an expression and a bubble entry", () => {
    for (const s of STATES) {
      expect(EXPRESSIONS[s]).toBeDefined();
      expect(s in BUBBLE_KEYS).toBe(true);
    }
  });

  it("every bubble string is translated in both locales", () => {
    for (const key of Object.values(BUBBLE_KEYS)) {
      if (!key) continue;
      expect(key in en, key).toBe(true);
      expect(key in es, key).toBe(true);
    }
  });
});
