/**
 * Pure model of the run-review findings list on Home: which rows get a Show
 * action, and which `study_open` stage it opens. The main process stamps
 * `target` on a finding; the renderer re-checks it because the value crosses
 * an IPC boundary, and offers nothing it cannot map.
 */
export type ShowStage = "mesh" | "case" | "results";

export interface FindingRow {
  severity: "error" | "warning" | "unavailable";
  message: string;
  stage?: ShowStage;
}

const STAGES: readonly string[] = ["mesh", "case", "results"];
const SEVERITIES: readonly string[] = ["error", "warning", "unavailable"];

/** Rows for `review.evidence.findings`; malformed entries are dropped, never guessed. */
export function findingRows(value: unknown): FindingRow[] | undefined {
  const findings = (value as { evidence?: { findings?: unknown } } | null | undefined)?.evidence?.findings;
  if (!Array.isArray(findings)) return undefined;
  const rows: FindingRow[] = [];
  for (const f of findings) {
    if (!f || typeof f !== "object") continue;
    const { severity, message, target } = f as Record<string, unknown>;
    if (typeof message !== "string" || typeof severity !== "string" || !SEVERITIES.includes(severity)) continue;
    rows.push({ severity: severity as FindingRow["severity"], message, ...(typeof target === "string" && STAGES.includes(target) ? { stage: target as ShowStage } : {}) });
  }
  return rows;
}

/** The `study_open` arguments for a row's Show action; `results` also names the run. */
export function showArgs(row: FindingRow, studyId: string | undefined, runId: string | undefined): Record<string, unknown> | undefined {
  if (!row.stage || !studyId) return undefined;
  return { studyId, stage: row.stage, ...(row.stage === "results" && runId ? { runId } : {}) };
}
