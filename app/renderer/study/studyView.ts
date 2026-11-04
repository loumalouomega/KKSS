/** Pure labels for the study panel; kept out of the DOM code so they can be tested. */
import { t } from "../../shared/i18n";

export type StageId = "geometry" | "mesh" | "case" | "run" | "results";

export function stageLabel(id: StageId): string {
  switch (id) {
    case "geometry": return t("Geometry");
    case "mesh": return t("Mesh");
    case "case": return t("Case");
    case "run": return t("Run");
    case "results": return t("Results");
  }
}

/** File-stage states are translated; run states (succeeded, failed, …) are the service's own words. */
export function stateLabel(state: string): string {
  return state === "ready" ? t("ready") : state === "stale" ? t("stale") : state === "missing" ? t("missing") : state;
}

/** "Next: <step> — <action>" for the active study's checklist; the action text is the service's own sentence. */
export function nextLabel(step: string, action: string): string {
  const name = (["geometry", "mesh", "case", "run"] as const).includes(step as never) ? stageLabel(step as StageId) : step === "review" ? stageLabel("results") : step;
  return t("Next: {0}", { 0: `${name} — ${action}` });
}
