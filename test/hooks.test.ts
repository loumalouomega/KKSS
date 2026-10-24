import { describe, expect, it } from "vitest";
import {
  buildPayload, DEFAULT_HOOK_TIMEOUT_MS, fold, hookDenialText, judge, matchesTool, MAX_HOOK_TIMEOUT_MS, MAX_HOOKS,
  parseHooks, stops, withHookNotes, type HookDef, type HookEvent, type HookRunResult,
} from "../app/main/services/chat/hooks";

const run = (patch: Partial<HookRunResult> = {}): HookRunResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...patch });
const def = (patch: Partial<HookDef> = {}): HookDef => ({
  name: "h", event: "PreToolUse", command: "x", args: [], timeoutMs: DEFAULT_HOOK_TIMEOUT_MS, modelOutput: false, source: "user", ...patch,
});
const file = (...hooks: unknown[]) => JSON.stringify({ hooks });

describe("parsing hooks.json", () => {
  it("accepts a full definition and applies defaults", () => {
    const { hooks, errors } = parseHooks(file(
      { name: "audit", event: "PostToolUse", command: "node", args: ["a.js"], match: "kratos__*", timeoutMs: 2000, modelOutput: true },
      { name: "gate", event: "PreToolUse", command: "./check.sh" },
    ), "project");
    expect(errors).toEqual([]);
    expect(hooks[0]).toEqual({ name: "audit", event: "PostToolUse", command: "node", args: ["a.js"], match: "kratos__*", timeoutMs: 2000, modelOutput: true, source: "project" });
    expect(hooks[1]).toMatchObject({ args: [], timeoutMs: DEFAULT_HOOK_TIMEOUT_MS, modelOutput: false, source: "project" });
    expect(hooks[1].match).toBeUndefined();
  });

  it("treats an absent file as no hooks and a broken one as an error, never a throw", () => {
    expect(parseHooks(undefined, "user")).toEqual({ hooks: [], errors: [] });
    expect(parseHooks("{nope", "user").errors[0]).toMatch(/not valid JSON/);
    expect(parseHooks("[]", "user").errors[0]).toMatch(/"hooks" list/);
    expect(parseHooks('{"hooks": 3}', "user").errors[0]).toMatch(/"hooks" list/);
  });

  it("drops an invalid entry with a message and keeps the rest — a half-valid hook must not run", () => {
    const { hooks, errors } = parseHooks(file(
      { name: "Bad Name", event: "PreToolUse", command: "x" },
      { name: "no-event", command: "x" },
      { name: "wrong-event", event: "Before", command: "x" },
      { name: "no-command", event: "PreToolUse" },
      { name: "nul", event: "PreToolUse", command: "a\0b" },
      { name: "args", event: "PreToolUse", command: "x", args: [1] },
      { name: "match-on-prompt", event: "UserPromptSubmit", command: "x", match: "a" },
      { name: "slow", event: "PreToolUse", command: "x", timeoutMs: MAX_HOOK_TIMEOUT_MS + 1 },
      { name: "tiny", event: "PreToolUse", command: "x", timeoutMs: 5 },
      { name: "model-pre", event: "PreToolUse", command: "x", modelOutput: true },
      { name: "good", event: "TurnEnd", command: "x" },
    ), "user");
    expect(hooks.map((h) => h.name)).toEqual(["good"]);
    expect(errors).toHaveLength(10);
  });

  it("rejects a duplicate name and an over-long list", () => {
    const dup = parseHooks(file({ name: "a", event: "TurnEnd", command: "x" }, { name: "a", event: "TurnEnd", command: "y" }), "user");
    expect(dup.hooks).toHaveLength(1);
    expect(dup.errors[0]).toMatch(/duplicate/);
    const many = Array.from({ length: MAX_HOOKS + 1 }, (_, i) => ({ name: `h${i}`.replace(/\d/g, (d) => String.fromCharCode(97 + Number(d))), event: "TurnEnd", command: "x" }));
    const over = parseHooks(file(...many), "user");
    expect(over.hooks).toEqual([]);
    expect(over.errors[0]).toMatch(/more than/);
  });
});

describe("matching tool names", () => {
  it("is an anchored glob on the full namespaced name", () => {
    expect(matchesTool(undefined, "cad__x")).toBe(true);
    expect(matchesTool("kratos__*", "kratos__run_simulation")).toBe(true);
    expect(matchesTool("kratos__*", "xkratos__run")).toBe(false);
    expect(matchesTool("*__run_*", "kratos__run_simulation")).toBe(true);
    expect(matchesTool("cad__list", "cad__list_layers")).toBe(false);
    expect(matchesTool("a.b", "aXb")).toBe(false); // '.' is literal
    expect(matchesTool("a(b)*", "a(b)c")).toBe(true);
  });
});

describe("the payload", () => {
  it("is one JSON object with the event, omitting absent fields and capping the result", () => {
    const text = JSON.parse(buildPayload("PostToolUse", {
      source: "chat", conversationId: "c1", callId: "k1", tool: "mesh__x", args: { a: 1 },
      result: { ok: true, text: "y".repeat(20_000) }, files: { cad: ["/a.step"], mesh: [] },
    }));
    expect(text).toMatchObject({ event: "PostToolUse", source: "chat", conversationId: "c1", tool: "mesh__x", args: { a: 1 } });
    expect(text.message).toBeUndefined();
    expect(text.result.text.length).toBeLessThan(9000);
    expect(text.files.cad).toEqual(["/a.step"]);
    expect(JSON.parse(buildPayload("TurnEnd", { source: "meta", conversationId: null })).conversationId).toBeNull();
  });
});

describe("judging an exit", () => {
  it("0 is no opinion for every event", () => {
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "TurnEnd"] as HookEvent[]) {
      expect(judge(event, run()).kind).toBe("pass");
    }
  });

  it("2 denies only where something can be stopped, using stderr's first line", () => {
    expect(judge("PreToolUse", run({ code: 2, stderr: "\n  no solver here  \nsecond" }))).toEqual({ kind: "deny", reason: "no solver here" });
    expect(judge("UserPromptSubmit", run({ code: 2 }))).toEqual({ kind: "deny", reason: "denied by the hook" });
    expect(judge("PostToolUse", run({ code: 2 })).kind).toBe("failed");
    expect(judge("TurnEnd", run({ code: 2 })).kind).toBe("failed");
  });

  it("3 asks, for PreToolUse only", () => {
    expect(judge("PreToolUse", run({ code: 3, stderr: "check the path" }))).toEqual({ kind: "ask", reason: "check the path" });
    expect(judge("PreToolUse", run({ code: 3 }))).toEqual({ kind: "ask" });
    expect(judge("UserPromptSubmit", run({ code: 3 })).kind).toBe("failed");
  });

  it("anything else — other codes, timeout, crash, missing program, cancel — is a failure", () => {
    expect(judge("PreToolUse", run({ code: 1, stderr: "boom" }))).toEqual({ kind: "failed", reason: "exited with code 1: boom" });
    expect(judge("PreToolUse", run({ code: null, timedOut: true })).kind).toBe("failed");
    expect(judge("PreToolUse", run({ code: null, aborted: true })).kind).toBe("failed");
    expect(judge("PreToolUse", run({ code: null, error: "spawn x ENOENT" }))).toEqual({ kind: "failed", reason: "could not start: spawn x ENOENT" });
  });
});

describe("folding judgements into an outcome", () => {
  const step = (hook: HookDef, result: Partial<HookRunResult>) => ({ hook, run: run(result), judgement: judge(hook.event, run(result)) });

  it("nothing but passes is no opinion — a hook cannot approve", () => {
    const out = fold("PreToolUse", [step(def({ name: "a" }), {}), step(def({ name: "b" }), {})]);
    expect(out).toEqual({ verdict: "none", notes: [] });
    expect(Object.keys(out)).not.toContain("allow");
  });

  it("a PreToolUse failure fails closed, naming the hook", () => {
    const out = fold("PreToolUse", [step(def({ name: "gate" }), { code: null, timedOut: true })]);
    expect(out).toMatchObject({ verdict: "deny", hook: "gate", reason: "the hook timed out" });
  });

  it("the same failure on an observing event is not a verdict", () => {
    const post = def({ name: "audit", event: "PostToolUse" });
    expect(fold("PostToolUse", [step(post, { code: 1 })])).toEqual({ verdict: "none", notes: [] });
    const end = def({ name: "end", event: "TurnEnd" });
    expect(fold("TurnEnd", [step(end, { code: null, error: "x" })]).verdict).toBe("none");
    const prompt = def({ name: "p", event: "UserPromptSubmit" });
    expect(fold("UserPromptSubmit", [step(prompt, { code: 1 })]).verdict).toBe("none");
  });

  it("a deny beats an earlier ask; the first ask is kept otherwise", () => {
    const asks = fold("PreToolUse", [step(def({ name: "a" }), { code: 3, stderr: "one" }), step(def({ name: "b" }), { code: 3, stderr: "two" })]);
    expect(asks).toMatchObject({ verdict: "ask", hook: "a", reason: "one" });
    const denied = fold("PreToolUse", [step(def({ name: "a" }), { code: 3 }), step(def({ name: "b" }), { code: 2, stderr: "no" })]);
    expect(denied).toMatchObject({ verdict: "deny", hook: "b", reason: "no" });
  });

  it("collects model notes only from PostToolUse hooks that opted in and passed", () => {
    const yes = def({ name: "yes", event: "PostToolUse", modelOutput: true });
    const no = def({ name: "no", event: "PostToolUse" });
    const failed = def({ name: "failed", event: "PostToolUse", modelOutput: true });
    const out = fold("PostToolUse", [step(yes, { stdout: " logged to audit.csv\n" }), step(no, { stdout: "secret" }), step(failed, { code: 1, stdout: "x" })]);
    expect(out.notes).toEqual([{ hook: "yes", text: "logged to audit.csv" }]);
    expect(withHookNotes("tool text", out.notes)).toBe("tool text\n\n[Hook output: yes]\nlogged to audit.csv");
    expect(withHookNotes("tool text", [])).toBe("tool text");
  });

  it("stops running further hooks at a deny or a fatal PreToolUse failure only", () => {
    expect(stops("PreToolUse", { kind: "deny", reason: "x" })).toBe(true);
    expect(stops("PreToolUse", { kind: "failed", reason: "x" })).toBe(true);
    expect(stops("PreToolUse", { kind: "ask" })).toBe(false);
    expect(stops("PostToolUse", { kind: "failed", reason: "x" })).toBe(false);
    expect(stops("UserPromptSubmit", { kind: "deny", reason: "x" })).toBe(true);
  });
});

describe("what the model is told", () => {
  it("a denial reads as final", () => {
    const text = hookDenialText("gate", "no solver outside the study folder");
    expect(text).toContain('"gate"');
    expect(text).toContain("no solver outside the study folder");
    expect(text).toMatch(/Do not retry/);
  });
});
