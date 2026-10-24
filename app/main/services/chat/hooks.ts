/**
 * Lifecycle hooks for the assistant — definitions, validation and the decision
 * table. Pure (no Electron, no filesystem, no processes) so every rule is
 * unit-tested; the process half is `hookRunner.ts`, the glue `hooksStore.ts`.
 *
 * A hook is a command the user (or a *trusted* project folder) wants run at one
 * of four points of the chat loop:
 *
 *   PreToolUse        before a tool call is approved   — may deny or force a prompt
 *   PostToolUse       after the call returned          — observes
 *   UserPromptSubmit  before a message is sent         — may refuse it
 *   TurnEnd           after a turn finished            — observes
 *
 * Non-negotiable properties, kept in this file because they are decisions and
 * not plumbing:
 * - **A hook can never approve anything.** The only outcomes are "no opinion",
 *   "deny" and "ask" (force a prompt that the gate would have skipped). A hook
 *   that could approve would be the gate approving itself.
 * - **Failing closed where it matters.** For `PreToolUse` a timeout, a crash, a
 *   missing program or any exit code other than 0/2/3 denies the call. For the
 *   other three events those outcomes are only logged — a broken audit hook must
 *   not take the whole assistant down.
 * - A definition holds a command and arguments, run directly and never through a
 *   shell, and carries no secret: the hook's environment is the MCP SDK's minimal
 *   one, so a project file cannot read the host's variables by naming them.
 */
import { oneLine } from "./assistantDefs";
import type { DefSource } from "./assistantDefs";

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "TurnEnd"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events that carry a tool call, and so accept a `match` glob. */
export const TOOL_EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse"];

export const HOOK_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_HOOKS = 32;
export const MAX_HOOK_ARGS = 64;
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MAX_HOOK_TIMEOUT_MS = 60_000;
/** Each of a hook's output streams is kept up to this many characters. */
export const HOOK_OUTPUT_CHARS = 8192;
/** The tool result text a hook is shown (stdin), so a huge result is not piped. */
export const HOOK_RESULT_CHARS = 8192;
export const MAX_REASON_CHARS = 500;
/** What an opted-in `PostToolUse` hook may add to the model-visible result. */
export const MAX_MODEL_OUTPUT_CHARS = 2000;

/** Exit codes a hook uses to speak. Anything else is "failed" (see `judge`). */
export const EXIT_OK = 0;
export const EXIT_DENY = 2;
export const EXIT_ASK = 3;

export interface HookDef {
  name: string;
  event: HookEvent;
  command: string;
  args: string[];
  /** `*` glob on the full namespaced tool name; tool events only. */
  match?: string;
  timeoutMs: number;
  /** `PostToolUse` only: stdout is appended to the result the model reads. */
  modelOutput: boolean;
  source: DefSource;
}

export interface ParsedHooks {
  hooks: HookDef[];
  errors: string[];
}

function parseOne(raw: unknown, source: DefSource, errors: string[]): HookDef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("a hook entry must be an object");
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || !HOOK_NAME_RE.test(o.name)) {
    errors.push(`hook name ${JSON.stringify(o.name)} must be 1-32 lowercase letters, digits or hyphens, starting with a letter`);
    return null;
  }
  const label = o.name;
  if (typeof o.event !== "string" || !(HOOK_EVENTS as readonly string[]).includes(o.event)) {
    errors.push(`${label}: event must be one of ${HOOK_EVENTS.join(", ")}`);
    return null;
  }
  const event = o.event as HookEvent;
  if (typeof o.command !== "string" || !o.command.trim()) { errors.push(`${label}: command must be a non-empty string`); return null; }
  if (o.command.includes("\0")) { errors.push(`${label}: command contains a NUL byte`); return null; }
  let args: string[] = [];
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || o.args.some((a) => typeof a !== "string" || a.includes("\0"))) {
      errors.push(`${label}: args must be a list of strings`);
      return null;
    }
    if (o.args.length > MAX_HOOK_ARGS) { errors.push(`${label}: at most ${MAX_HOOK_ARGS} arguments`); return null; }
    args = o.args as string[];
  }
  let match: string | undefined;
  if (o.match !== undefined) {
    if (typeof o.match !== "string" || !o.match.trim() || o.match.length > 128) {
      errors.push(`${label}: match must be a short non-empty string`);
      return null;
    }
    if (!TOOL_EVENTS.includes(event)) { errors.push(`${label}: match only applies to PreToolUse and PostToolUse`); return null; }
    match = o.match.trim();
  }
  let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
  if (o.timeoutMs !== undefined) {
    if (typeof o.timeoutMs !== "number" || !Number.isFinite(o.timeoutMs) || o.timeoutMs < 100 || o.timeoutMs > MAX_HOOK_TIMEOUT_MS) {
      errors.push(`${label}: timeoutMs must be between 100 and ${MAX_HOOK_TIMEOUT_MS}`);
      return null;
    }
    timeoutMs = Math.round(o.timeoutMs);
  }
  let modelOutput = false;
  if (o.modelOutput !== undefined) {
    if (typeof o.modelOutput !== "boolean") { errors.push(`${label}: modelOutput must be true or false`); return null; }
    if (o.modelOutput && event !== "PostToolUse") { errors.push(`${label}: modelOutput only applies to PostToolUse`); return null; }
    modelOutput = o.modelOutput;
  }
  return { name: label, event, command: o.command.trim(), args, ...(match ? { match } : {}), timeoutMs, modelOutput, source };
}

/**
 * Parses a `hooks.json` file. Never throws. A bad entry is dropped with a message
 * (a half-valid hook must not run — least of all a `PreToolUse` one that was meant
 * to deny), and the rest of the file still loads.
 */
export function parseHooks(text: string | undefined, source: DefSource): ParsedHooks {
  const out: ParsedHooks = { hooks: [], errors: [] };
  if (text === undefined) return out;
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (error) {
    out.errors.push(`hooks.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return out;
  }
  const list = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as { hooks?: unknown }).hooks : undefined;
  if (!Array.isArray(list)) {
    out.errors.push('hooks.json must be an object with a "hooks" list');
    return out;
  }
  if (list.length > MAX_HOOKS) {
    out.errors.push(`hooks.json has more than ${MAX_HOOKS} hooks; none were loaded`);
    return out;
  }
  const seen = new Set<string>();
  for (const raw of list) {
    const hook = parseOne(raw, source, out.errors);
    if (!hook) continue;
    if (seen.has(hook.name)) { out.errors.push(`${hook.name}: duplicate hook name`); continue; }
    seen.add(hook.name);
    out.hooks.push(hook);
  }
  return out;
}

/** `*` matches any run of characters; everything else is literal. Anchored. */
export function matchesTool(glob: string | undefined, toolName: string): boolean {
  if (glob === undefined) return true;
  const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(toolName);
}

// ---------------------------------------------------------------- the payload

export interface HookFiles {
  projectRoot?: string;
  cad: string[];
  mesh: string[];
  activeCad?: string | null;
  activeMesh?: string | null;
}

/** Everything a hook is told, besides the event itself. Absent fields are omitted. */
export interface HookContext {
  /** `chat`: the sidebar (and the subscription runtimes); `meta`: the HTTP endpoint. */
  source: "chat" | "meta";
  conversationId: string | null;
  callId?: string;
  tool?: string;
  /** The parsed arguments (or the raw string when they were not JSON). */
  args?: unknown;
  message?: string;
  result?: { ok: boolean; text: string };
  outcome?: "done" | "error" | "stopped";
  files?: HookFiles;
}

export function parseArgs(argsJson: string): unknown {
  try { return JSON.parse(argsJson); } catch { return argsJson; }
}

/** The single JSON object written to a hook's standard input. */
export function buildPayload(event: HookEvent, ctx: HookContext): string {
  const payload: Record<string, unknown> = { event };
  for (const [key, value] of Object.entries(ctx)) {
    if (value === undefined) continue;
    if (key === "result") {
      const r = value as NonNullable<HookContext["result"]>;
      payload.result = { ok: r.ok, text: r.text.length > HOOK_RESULT_CHARS ? `${r.text.slice(0, HOOK_RESULT_CHARS)}…` : r.text };
    } else {
      payload[key] = value;
    }
  }
  return JSON.stringify(payload);
}

// ------------------------------------------------------------ the decision table

/** What running one hook produced; `hookRunner.ts` fills it. */
export interface HookRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The caller's signal fired, or the runner was shut down. */
  aborted: boolean;
  /** The program could not be started (`ENOENT`…). */
  error?: string;
}

export type HookJudgement =
  | { kind: "pass" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason?: string }
  /** The hook misbehaved. Fatal for `PreToolUse` (⇒ deny); logged otherwise. */
  | { kind: "failed"; reason: string };

function firstLine(text: string): string {
  return oneLine(text.split(/\r?\n/).find((line) => line.trim()) ?? "", MAX_REASON_CHARS);
}

/** Why a run failed, in words a person can act on. */
export function failureReason(run: HookRunResult): string {
  if (run.error) return `could not start: ${run.error}`;
  if (run.timedOut) return "timed out";
  if (run.aborted) return "was cancelled";
  const detail = firstLine(run.stderr);
  return `exited with code ${run.code}${detail ? `: ${detail}` : ""}`;
}

/** One hook's run, judged for its event. */
export function judge(event: HookEvent, run: HookRunResult): HookJudgement {
  if (run.error || run.timedOut || run.aborted || run.code === null) return { kind: "failed", reason: failureReason(run) };
  if (run.code === EXIT_OK) return { kind: "pass" };
  if (run.code === EXIT_DENY) {
    // Exit 2 is "deny" for the two events that can stop something. For the
    // observers it carries no meaning, so it is a plain failure (logged).
    if (event === "PreToolUse" || event === "UserPromptSubmit") return { kind: "deny", reason: firstLine(run.stderr) || "denied by the hook" };
    return { kind: "failed", reason: failureReason(run) };
  }
  if (run.code === EXIT_ASK && event === "PreToolUse") {
    const reason = firstLine(run.stderr);
    return { kind: "ask", ...(reason ? { reason } : {}) };
  }
  return { kind: "failed", reason: failureReason(run) };
}

export interface HookOutcome {
  verdict: "none" | "deny" | "ask";
  /** The hook that decided (the first deny; else the first ask). */
  hook?: string;
  reason?: string;
  /** `PostToolUse` hooks that opted in: text to append to the model-visible result. */
  notes: Array<{ hook: string; text: string }>;
}

export const NO_OUTCOME: HookOutcome = { verdict: "none", notes: [] };

/**
 * True when no later hook of the event should run: the call is already refused
 * (a deny, or a `PreToolUse` failure that fails closed), so a later hook would be
 * shown something that will never happen.
 */
export function stops(event: HookEvent, judgement: HookJudgement): boolean {
  return judgement.kind === "deny" || (judgement.kind === "failed" && event === "PreToolUse");
}

/**
 * Folds hooks' judgements, in run order, into one outcome. A deny wins over an
 * ask; a failure is a deny only for `PreToolUse`.
 */
export function fold(event: HookEvent, steps: Array<{ hook: HookDef; judgement: HookJudgement; run: HookRunResult }>): HookOutcome {
  const outcome: HookOutcome = { verdict: "none", notes: [] };
  for (const { hook, judgement, run } of steps) {
    if (judgement.kind === "deny") {
      return { ...outcome, verdict: "deny", hook: hook.name, reason: judgement.reason };
    }
    if (judgement.kind === "failed" && event === "PreToolUse") {
      return { ...outcome, verdict: "deny", hook: hook.name, reason: `the hook ${judgement.reason}` };
    }
    if (judgement.kind === "ask" && outcome.verdict === "none") {
      outcome.verdict = "ask";
      outcome.hook = hook.name;
      if (judgement.reason) outcome.reason = judgement.reason;
    }
    if (judgement.kind === "pass" && hook.modelOutput && event === "PostToolUse") {
      const text = run.stdout.trim();
      if (text) outcome.notes.push({ hook: hook.name, text: text.length > MAX_MODEL_OUTPUT_CHARS ? `${text.slice(0, MAX_MODEL_OUTPUT_CHARS)}…` : text });
    }
  }
  return outcome;
}

// ------------------------------------------------------------ what the model reads

/**
 * The tool result for a call a hook refused. It must read as final: a denial the
 * model can talk itself around gets re-emitted until `MAX_ITERATIONS` runs out
 * (see `DENIED_TEXT`), and this one is the user's own rule.
 */
export function hookDenialText(hook: string, reason: string | undefined): string {
  return `Blocked by the user's hook "${hook}"${reason ? `: ${reason}` : ""}. This is the user's own policy. Do not retry this call or work around it; tell the user what was blocked and why.`;
}

/** A `PostToolUse` note, labelled so the model can tell it from the tool's own output. */
export function withHookNotes(text: string, notes: HookOutcome["notes"]): string {
  if (!notes.length) return text;
  return `${text}\n\n${notes.map((n) => `[Hook output: ${n.hook}]\n${n.text}`).join("\n\n")}`;
}
