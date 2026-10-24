/**
 * Kraty's brain: a pure mapping from the sidebar's own host messages to a face.
 * No DOM, no timers — `kratyGlue` applies it. Presentation only: it reads the
 * *shape* of the stream (a call opened, a delta arrived), never its text.
 */

import type { Message } from "../../shared/i18n";

export type KratyState = "idle" | "waiting" | "writing" | "working" | "needsYou" | "finished" | "error";

export interface KratyExpression {
  eyes: "open" | "wide" | "closed" | "happy" | "worried";
  brows: "flat" | "raised" | "furrowed" | "worried";
  mouth: "smile" | "flat" | "small" | "open" | "talk" | "frown";
}

/** Each state's face as data, so a new reaction is a row, not a branch. */
export const EXPRESSIONS: Record<KratyState, KratyExpression> = {
  idle: { eyes: "open", brows: "flat", mouth: "smile" },
  waiting: { eyes: "open", brows: "raised", mouth: "small" },
  writing: { eyes: "open", brows: "flat", mouth: "talk" },
  working: { eyes: "wide", brows: "furrowed", mouth: "flat" },
  needsYou: { eyes: "wide", brows: "raised", mouth: "open" },
  finished: { eyes: "happy", brows: "flat", mouth: "smile" },
  error: { eyes: "worried", brows: "worried", mouth: "frown" },
};

/** Fixed bubble strings (i18n keys); `idle` says nothing. Never model text. */
export const BUBBLE_KEYS: Record<KratyState, Message | null> = {
  idle: null,
  waiting: "Thinking…",
  writing: "Writing…",
  working: "Running a tool…",
  needsYou: "Waiting for your OK",
  finished: "Done",
  error: "Something went wrong",
};

export interface KratySignals {
  busy: boolean;
  /** `assistantStart` seen this turn; deltas move it to writing. */
  phase: "none" | "started" | "writing";
  /** Tool calls with no result yet. */
  openCalls: string[];
  approval: boolean;
  error: boolean;
  /** A turn ended without an error since the last busy→true. */
  finished: boolean;
}

export const INITIAL_SIGNALS: KratySignals = {
  busy: false, phase: "none", openCalls: [], approval: false, error: false, finished: false,
};

/** The host messages the face reads — a subset of `ChatToWebview`, by shape. */
export type KratyEvent =
  | { type: "busy"; busy: boolean }
  | { type: "assistantStart" }
  | { type: "assistantDelta" }
  | { type: "assistantDone" }
  | { type: "toolCall"; callId: string }
  | { type: "toolResult"; callId: string }
  | { type: "approvalRequest" }
  | { type: "approvalResolved" }
  | { type: "error" }
  /** A `state` replay: the whole picture at once. */
  | { type: "replay"; busy: boolean; openCalls: string[]; approval: boolean; lastIsError: boolean };

export function reduceSignals(s: KratySignals, e: KratyEvent): KratySignals {
  switch (e.type) {
    case "replay":
      return { ...INITIAL_SIGNALS, busy: e.busy, openCalls: e.busy ? e.openCalls : [], approval: e.busy && e.approval, error: e.lastIsError };
    case "busy":
      if (e.busy) return { ...s, busy: true, error: false, finished: false };
      // Turn over: whatever was in flight is settled; a turn that errored stays an error.
      return { ...s, busy: false, phase: "none", openCalls: [], approval: false, finished: !s.error };
    case "assistantStart":
      return { ...s, phase: "started" };
    case "assistantDelta":
      return { ...s, phase: "writing" };
    case "assistantDone":
      return { ...s, phase: "none" };
    case "toolCall":
      return s.openCalls.includes(e.callId) ? s : { ...s, openCalls: [...s.openCalls, e.callId] };
    case "toolResult":
      return { ...s, openCalls: s.openCalls.filter((id) => id !== e.callId) };
    case "approvalRequest":
      return { ...s, approval: true };
    case "approvalResolved":
      return { ...s, approval: false };
    case "error":
      return { ...s, error: true, finished: false };
  }
}

/** Precedence: what needs the user beats what the app is doing beats what it is saying. */
export function stateOf(s: KratySignals): KratyState {
  if (s.busy && s.approval) return "needsYou";
  if (s.busy && s.openCalls.length > 0) return "working";
  if (s.busy && s.phase === "writing") return "writing";
  if (s.busy) return "waiting";
  if (s.error) return "error";
  if (s.finished) return "finished";
  return "idle";
}
