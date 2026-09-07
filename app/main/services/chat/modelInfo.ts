/**
 * Context window and pricing for the models KKSS can talk to.
 *
 * A deliberate, reviewed table — the same stance `toolPolicy.ts` takes, and for
 * a related reason: a wrong number here is worse than no number. A stale price
 * misreports money and a stale context window misreports how much room is left,
 * both silently. So an unrecognised model resolves to `null` and the sidebar
 * shows raw token counts with no cost and no percentage, rather than guessing.
 *
 * That "unknown" path is the normal case for the OpenAI-compatible provider,
 * which points at arbitrary gateways (Ollama, OpenRouter, a local server) whose
 * pricing KKSS has no way to know. It is not a gap to fill by inventing rows.
 *
 * **Re-check this table whenever the model list changes** — a new model is a
 * reviewed edit here, never an inference at runtime. Prices are USD per million
 * tokens, first-party Anthropic API rates (Bedrock and Vertex are billed by
 * those partners at their own rates, which this table does not model).
 *
 * Pure module (no electron/node) so the glue tests drive it directly.
 */

export interface ModelInfo {
  /** Maximum input tokens the model accepts. */
  contextWindow: number;
  inputPer1M: number;
  outputPer1M: number;
  /** Cache reads and writes are billed at their own rates — stored per row
   *  rather than derived from `inputPer1M`. The usual relationship is ~0.1x for
   *  a read and ~1.25x for a write, but it is not universal (Fable 5.1 reads at
   *  $0.25/MTok, not $1.00), and a pricing rule with one exception is a pricing
   *  rule that will acquire more. */
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

const K = 1000;
const M = 1000 * K;

export const MODEL_INFO: Readonly<Record<string, ModelInfo>> = {
  "claude-opus-5": { contextWindow: M, inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-8": { contextWindow: M, inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-7": { contextWindow: M, inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-6": { contextWindow: M, inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-sonnet-5": { contextWindow: M, inputPer1M: 2, outputPer1M: 10, cacheReadPer1M: 0.2, cacheWritePer1M: 2.5 },
  "claude-sonnet-4-6": { contextWindow: M, inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-haiku-4-5": { contextWindow: 200 * K, inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
  "claude-fable-5": { contextWindow: M, inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },
  // Reads at a flat $0.25/MTok — the exception the per-row storage exists for.
  "claude-fable-5-1": { contextWindow: M, inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 0.25, cacheWritePer1M: 12.5 },
};

/** Trailing dated snapshot, e.g. "-20251101". Current ids carry none, but the
 *  model is a free-text setting, so an older dated id must still resolve. */
const DATE_SUFFIX = /-\d{8}$/;

/** The table row for a model, or `null` when KKSS has no reviewed figures. */
export function modelInfo(model: string): ModelInfo | null {
  if (!model) return null;
  return MODEL_INFO[model] ?? MODEL_INFO[model.replace(DATE_SUFFIX, "")] ?? null;
}

/** USD for one usage total. Callers must have a row already — there is no
 *  fallback rate, because a made-up rate is the failure mode this avoids. */
export function estimateCost(
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
  info: ModelInfo
): number {
  return (
    (usage.input * info.inputPer1M +
      usage.output * info.outputPer1M +
      usage.cacheRead * info.cacheReadPer1M +
      usage.cacheWrite * info.cacheWritePer1M) /
    1_000_000
  );
}
