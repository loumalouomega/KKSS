/**
 * unresponsiveGuard.ts — the "renderer not responding" policy.
 *
 * The property that matters is negative: `unresponsive` fires on any long
 * synchronous task (a large mesh parse), so nothing here may reload on its own.
 * Reload is reachable only through the user's answer; everything else either
 * waits, backs off, or goes quiet.
 */
import { describe, expect, it } from "vitest";
import {
  FIRST_PROMPT_MS,
  MAX_PROMPT_DELAY_MS,
  promptDelay,
  UnresponsiveGuard,
  type UnresponsiveAnswer,
} from "../app/main/unresponsiveGuard";

/** A manual clock: timers run only when the test advances it. */
function harness(answers: UnresponsiveAnswer[] | (() => Promise<UnresponsiveAnswer>) = []) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const prompts: { payload: string; attempt: number; signal: AbortSignal }[] = [];
  const reloads: string[] = [];
  const queue = Array.isArray(answers) ? [...answers] : undefined;
  const guard = new UnresponsiveGuard<string>({
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    prompt: async (payload, info) => {
      prompts.push({ payload, ...info });
      return queue ? (queue.shift() ?? "wait") : (answers as () => Promise<UnresponsiveAnswer>)();
    },
    reload: (payload) => void reloads.push(payload),
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return { guard, advance, prompts, reloads, timers };
}

describe("promptDelay", () => {
  it("starts generous, doubles on each Wait and is capped", () => {
    expect(promptDelay(0)).toBe(FIRST_PROMPT_MS);
    expect(promptDelay(1)).toBe(FIRST_PROMPT_MS * 2);
    expect(promptDelay(2)).toBe(FIRST_PROMPT_MS * 4);
    expect(promptDelay(50)).toBe(MAX_PROMPT_DELAY_MS);
  });
});

describe("UnresponsiveGuard", () => {
  it("does nothing before the delay, and never reloads by itself", async () => {
    const h = harness();
    h.guard.unresponsive("tab:mesh:1", "mesh");
    await h.advance(FIRST_PROMPT_MS - 1);
    expect(h.prompts).toHaveLength(0);
    expect(h.reloads).toHaveLength(0);
  });

  it("asks once the view has stayed unresponsive past the delay", async () => {
    const h = harness(["wait"]);
    h.guard.unresponsive("tab:mesh:1", "mesh");
    await h.advance(FIRST_PROMPT_MS);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toMatchObject({ payload: "mesh", attempt: 0 });
    expect(h.reloads).toHaveLength(0);
  });

  it("a view that recovers first is never asked", async () => {
    const h = harness();
    h.guard.unresponsive("a", "x");
    await h.advance(FIRST_PROMPT_MS - 1);
    h.guard.responsive("a");
    await h.advance(FIRST_PROMPT_MS * 10);
    expect(h.prompts).toHaveLength(0);
    expect(h.guard.pending).toBe(0);
  });

  it("dismisses an open prompt when the view recovers, and then ignores the answer", async () => {
    let release!: (a: UnresponsiveAnswer) => void;
    const h = harness(() => new Promise<UnresponsiveAnswer>((resolve) => (release = resolve)));
    h.guard.unresponsive("a", "x");
    await h.advance(FIRST_PROMPT_MS);
    expect(h.prompts[0].signal.aborted).toBe(false);
    h.guard.responsive("a");
    expect(h.prompts[0].signal.aborted).toBe(true);
    release("reload"); // the dialog resolves late — it must not trigger a reload
    await Promise.resolve();
    await Promise.resolve();
    expect(h.reloads).toHaveLength(0);
  });

  it("Wait re-arms with a doubled delay, and keeps backing off", async () => {
    const h = harness(["wait", "wait", "reload"]);
    h.guard.unresponsive("a", "x");
    await h.advance(FIRST_PROMPT_MS);
    expect(h.prompts).toHaveLength(1);
    await h.advance(FIRST_PROMPT_MS * 2 - 1);
    expect(h.prompts).toHaveLength(1);
    await h.advance(1);
    expect(h.prompts).toHaveLength(2);
    expect(h.prompts[1].attempt).toBe(1);
    await h.advance(FIRST_PROMPT_MS * 4);
    expect(h.prompts).toHaveLength(3);
    expect(h.reloads).toEqual(["x"]);
  });

  it("Reload is the only path to a reload, and ends the episode", async () => {
    const h = harness(["reload"]);
    h.guard.unresponsive("a", "x");
    await h.advance(FIRST_PROMPT_MS);
    expect(h.reloads).toEqual(["x"]);
    expect(h.guard.pending).toBe(0);
    await h.advance(MAX_PROMPT_DELAY_MS * 2); // nothing further is scheduled
    expect(h.prompts).toHaveLength(1);
  });

  it("repeated reports for one episode do not stack timers or prompts", async () => {
    const h = harness(["wait"]);
    h.guard.unresponsive("a", "x");
    h.guard.unresponsive("a", "x");
    h.guard.unresponsive("a", "x");
    expect(h.timers.size).toBe(1);
    await h.advance(FIRST_PROMPT_MS);
    expect(h.prompts).toHaveLength(1);
  });

  it("tracks views independently", async () => {
    const h = harness(["wait", "reload"]);
    h.guard.unresponsive("a", "first");
    h.guard.unresponsive("b", "second");
    h.guard.responsive("a");
    await h.advance(FIRST_PROMPT_MS);
    expect(h.prompts.map((p) => p.payload)).toEqual(["second"]);
  });

  it("'gone' (the tab closed) forgets the view without a reload or re-arm", async () => {
    const h = harness(["gone"]);
    h.guard.unresponsive("a", "x");
    await h.advance(FIRST_PROMPT_MS);
    expect(h.guard.pending).toBe(0);
    await h.advance(MAX_PROMPT_DELAY_MS * 2);
    expect(h.prompts).toHaveLength(1);
    expect(h.reloads).toHaveLength(0);
  });

  it("treats a failed dialog as Wait, never as Reload", async () => {
    const h = harness(() => Promise.reject(new Error("dialog failed")));
    h.guard.unresponsive("a", "x");
    await h.advance(FIRST_PROMPT_MS);
    expect(h.reloads).toHaveLength(0);
    expect(h.guard.pending).toBe(1);
    expect(h.timers.size).toBe(1); // re-armed
  });

  it("dispose cancels timers and aborts open prompts, and ignores later reports", async () => {
    let release!: (a: UnresponsiveAnswer) => void;
    const h = harness(() => new Promise<UnresponsiveAnswer>((resolve) => (release = resolve)));
    h.guard.unresponsive("a", "x");
    h.guard.unresponsive("b", "y");
    await h.advance(FIRST_PROMPT_MS);
    h.guard.dispose();
    expect(h.prompts.every((p) => p.signal.aborted)).toBe(true);
    release("reload");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.reloads).toHaveLength(0);
    h.guard.unresponsive("c", "z");
    expect(h.guard.pending).toBe(0);
  });
});
