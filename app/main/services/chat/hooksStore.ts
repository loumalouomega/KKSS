/**
 * Glue for lifecycle hooks: reads `hooks.json` from the user's
 * `<userData>/assistant` and — **only while the project folder is trusted** — from
 * the project's `.kkss/assistant`, and runs the matching hooks for an event.
 *
 * Same shape as `AssistantDefsStore`, and for the same reasons: reads are fresh
 * (a project file edited after trust must stop applying at once —
 * `trustedProjectFiles()` re-verifies the hash on every call), and everything
 * environmental is injected, so this is unit-tested without Electron.
 *
 * `run()` never throws except for the caller's own abort: a hook that cannot
 * start is a judgement (`failed`), not an exception, because a `PreToolUse` hook
 * that crashes must deny the call rather than crash the turn.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatHookInfo } from "../../ipc";
import { readAssistantTree } from "./assistantFiles";
import {
  buildPayload, fold, judge, matchesTool, NO_OUTCOME, parseHooks, stops, TOOL_EVENTS,
  type HookContext, type HookDef, type HookEvent, type HookOutcome, type HookRunResult,
} from "./hooks";
import { HookRunner, type HookExecutor } from "./hookRunner";

export interface HookEngineDeps {
  /** `<userData>/assistant`. */
  userDir: string;
  /** Settings ▸ LLM Assistant ▸ Lifecycle Hooks. Off ⇒ nothing is read or run. */
  enabled(): boolean;
  /** The project's definition files; empty unless the folder is trusted *right now*. */
  trustedProjectFiles(): Record<string, string>;
  /** Subscribe to project trust / root changes. */
  onProjectChange(listener: () => void): void;
  /** The explicit project folder, if any (the hooks' cwd, and `KKSS_PROJECT_ROOT`). */
  projectRoot(): string | undefined;
  /** The minimal environment a hook starts with — never `process.env`. */
  baseEnv(): Record<string, string>;
  executor?: HookExecutor;
  /** Hook problems that are only logged (an observer that failed). */
  log?(message: string): void;
}

export interface HookSnapshot {
  hooks: HookDef[];
  errors: string[];
  /**
   * Set when the user's own `hooks.json` exists but the assistant folder could not
   * be read (the shared reader fails the whole folder on one unsafe or oversized
   * file). The hooks it holds are the user's policy, so `run()` refuses a
   * `PreToolUse` with this reason rather than quietly running without them.
   */
  blocked?: string;
}

const EMPTY: HookSnapshot = { hooks: [], errors: [] };

export class HookEngine {
  private readonly listeners = new Set<() => void>();
  private readonly executor: HookExecutor;

  constructor(private readonly deps: HookEngineDeps) {
    this.executor = deps.executor ?? new HookRunner();
    deps.onProjectChange(() => this.emit());
  }

  onChange(listener: () => void): void { this.listeners.add(listener); }
  /** Something that can change what the sidebar shows (a setting, trust, a root). */
  emit(): void { for (const l of [...this.listeners]) l(); }

  enabled(): boolean { return this.deps.enabled(); }

  /** One consistent read: the user's hooks first, then the trusted project's. */
  snapshot(): HookSnapshot {
    if (!this.deps.enabled()) return EMPTY;
    const user = readAssistantTree(this.deps.userDir, null);
    const mine = parseHooks(user.files["hooks.json"], "user");
    const errors = [...(user.error ? [user.error] : []), ...mine.errors];
    const blocked = user.error && fs.existsSync(path.join(this.deps.userDir, "hooks.json"))
      ? `your hooks cannot be loaded (${user.error})`
      : undefined;
    const project = parseHooks(this.deps.trustedProjectFiles()["hooks.json"], "project");
    errors.push(...project.errors.map((e) => `project: ${e}`));
    return { hooks: [...mine.hooks, ...project.hooks], errors, ...(blocked ? { blocked } : {}) };
  }

  summary(snapshot: HookSnapshot = this.snapshot()): { enabled: boolean; hooks: ChatHookInfo[]; errors: string[] } {
    return {
      enabled: this.deps.enabled(),
      hooks: snapshot.hooks.map((h) => ({
        name: h.name,
        event: h.event,
        source: h.source,
        ...(h.match ? { match: h.match } : {}),
        command: [h.command, ...h.args].join(" "),
      })),
      errors: snapshot.errors,
    };
  }

  /** Whether any hook would run for this event — lets a caller skip building a payload. */
  has(event: HookEvent, tool?: string): boolean {
    const snapshot = this.snapshot();
    if (snapshot.blocked && event === "PreToolUse") return true;
    return snapshot.hooks.some((h) => this.applies(h, event, tool));
  }

  private applies(hook: HookDef, event: HookEvent, tool: string | undefined): boolean {
    if (hook.event !== event) return false;
    return TOOL_EVENTS.includes(event) ? matchesTool(hook.match, tool ?? "") : true;
  }

  /**
   * Runs every hook of `event` that applies, in order, stopping at the first one
   * that settles the question (see `stops`). Rejects only with the caller's abort,
   * so a turn that is being stopped unwinds instead of acting on a half-run hook.
   */
  async run(event: HookEvent, ctx: HookContext, signal?: AbortSignal): Promise<HookOutcome> {
    signal?.throwIfAborted();
    const snapshot = this.snapshot();
    if (snapshot.blocked && event === "PreToolUse") return { verdict: "deny", hook: "hooks.json", reason: snapshot.blocked, notes: [] };
    const hooks = snapshot.hooks.filter((h) => this.applies(h, event, ctx.tool));
    if (!hooks.length) return NO_OUTCOME;
    const stdin = buildPayload(event, ctx);
    const root = this.deps.projectRoot();
    const cwd = root ?? this.deps.userDir;
    const env = { ...this.deps.baseEnv(), KKSS_HOOK_EVENT: event, ...(root ? { KKSS_PROJECT_ROOT: root } : {}) };
    const steps: Array<{ hook: HookDef; judgement: ReturnType<typeof judge>; run: HookRunResult }> = [];
    for (const hook of hooks) {
      const run = await this.executor.run({ command: hook.command, args: hook.args, timeoutMs: hook.timeoutMs }, stdin, { cwd, env, signal });
      signal?.throwIfAborted();
      const judgement = judge(event, run);
      steps.push({ hook, judgement, run });
      if (judgement.kind === "failed" && event !== "PreToolUse") {
        this.deps.log?.(`hook "${hook.name}" (${event}) ${judgement.reason}`);
      }
      if (stops(event, judgement)) break;
    }
    return fold(event, steps);
  }

  /** Stops every running hook. Idempotent; called at quit and on dispose. */
  killAll(): void { this.executor.killAll(); }
}
