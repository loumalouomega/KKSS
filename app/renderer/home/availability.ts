// Why a Home button is disabled (roadmap item 10). Pure: state in, one decision
// per button out, so the `disabled` flag and the explanation come from the same
// call and cannot drift. home.ts translates the reason code through `t()` via
// REASON_TEXT and applies `title` + `aria-description`.

export type HomeReason =
  | "noProjectFolder"
  | "noStudy"
  | "runtimeUnavailable"
  | "geometryNotReady"
  | "meshNotReady"
  | "caseNotReady"
  | "noRun"
  | "noResults"
  | "needsTwoRuns"
  | "queueEmpty"
  | "queueNotPaused"
  | "queuePaused"
  | "nothingToCancel";

export interface HomeAvailabilityState {
  hasProjectFolder: boolean;
  hasStudy: boolean;
  /** `undefined` while the environment report has not arrived (do not block). */
  manualRuntimeAvailable: boolean | undefined;
  /** Readiness of the active study's steps ("ready" | "missing" | …). */
  states: Record<string, string | undefined>;
  hasSelectedRun: boolean;
  selectedRunHasResult: boolean;
  runCount: number;
  queue: { paused: boolean; taskStates: string[] };
}

/** Button id → reason it is disabled; a missing id means enabled. */
export type HomeAvailability = Record<string, HomeReason | undefined>;

const ACTIVE = ["dispatching", "running", "uncertain"];
const PENDING = ["waiting", "held"];

export function homeAvailability(s: HomeAvailabilityState): HomeAvailability {
  const out: HomeAvailability = {};
  const study = (r: HomeReason | undefined): HomeReason | undefined => (s.hasStudy ? r : "noStudy");
  const runtime: HomeReason | undefined = s.manualRuntimeAvailable === false ? "runtimeUnavailable" : undefined;
  const run = (): HomeReason | undefined => (s.hasSelectedRun ? undefined : "noRun");
  const meshReady = s.states.mesh === "ready";

  out["study-create"] = s.hasProjectFolder ? undefined : "noProjectFolder";
  out["study-wizard"] = s.hasProjectFolder ? undefined : "noProjectFolder";
  out["study-duplicate"] = study(undefined);
  out["study-plan-run"] = study(runtime);
  out["study-plan-sweep"] = study(runtime);
  out["study-plan-geometry-sweep"] = study(runtime);
  // Rebuild stale previews against the selected study, so it needs one.
  out["study-rebuild-stale"] = study(undefined);

  out["study-open-geometry"] = study(s.states.geometry === "ready" ? undefined : "geometryNotReady");
  out["study-open-mesh"] = study(meshReady ? undefined : "meshNotReady");
  out["study-open-case"] = study(meshReady ? undefined : "meshNotReady");
  out["study-open-results"] = study(s.selectedRunHasResult ? undefined : s.hasSelectedRun ? "noResults" : "noRun");
  out["study-relink-source"] = study(undefined);
  out["study-copy-source"] = study(undefined);
  out["study-attach-mesh"] = study(undefined);
  out["study-set-case"] = study(meshReady ? undefined : "meshNotReady");
  out["study-import-run"] = study(meshReady ? undefined : "meshNotReady");
  out["study-review-run"] = study(run());
  out["study-compare-runs"] = study(!s.hasSelectedRun ? "noRun" : s.runCount < 2 ? "needsTwoRuns" : undefined);
  out["study-region-refs"] = study(!s.states.mesh || s.states.mesh === "missing" ? "meshNotReady" : undefined);
  out["study-region-rename"] = study(!s.states.case || s.states.case === "missing" ? "caseNotReady" : undefined);
  out["study-evaluate-quantity"] = study(run());
  out["study-goal-seek"] = study(run());
  out["study-refinement"] = study(run());
  out["study-export-review"] = study(run());
  out["study-compare-variants"] = study(undefined);
  out["study-export-comparison"] = study(undefined);

  const states = s.queue.taskStates;
  const empty = states.length === 0;
  out["queue-resume"] = empty ? "queueEmpty" : s.queue.paused ? runtime : "queueNotPaused";
  out["queue-pause"] = empty ? "queueEmpty" : s.queue.paused ? "queuePaused" : undefined;
  out["queue-cancel"] = empty
    ? "queueEmpty"
    : states.some((x) => ACTIVE.includes(x) || PENDING.includes(x))
      ? undefined
      : "nothingToCancel";
  return out;
}

/** English source strings; home.ts passes each through `t()` (keys are these literals). */
export const REASON_TEXT: Record<HomeReason, string> = {
  noProjectFolder: "Choose a project folder first.",
  noStudy: "Select or create a study first.",
  runtimeUnavailable: "The Kratos runtime is unavailable; see the runtime report.",
  geometryNotReady: "This study has no ready geometry.",
  meshNotReady: "This study has no ready mesh.",
  caseNotReady: "This study has no case snapshot.",
  noRun: "Select a run first.",
  noResults: "The selected run has no result files.",
  needsTwoRuns: "Comparing needs at least two runs.",
  queueEmpty: "The queue is empty.",
  queueNotPaused: "The queue is not paused.",
  queuePaused: "The queue is already paused.",
  nothingToCancel: "No active or waiting task to cancel.",
};
