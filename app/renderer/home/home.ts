import "../localization";
import { t, translate } from "../../shared/i18n";
/**
 * Home screen: the config-driven main menu shown on launch (see homeConfig.ts),
 * plus the recent-files list.
 *
 * The buttons are static config; the recents list and the project-root line are
 * pushed from main over home:toWebview and re-pushed on `homeReady`, so a
 * reload replays them. Both arrive pre-formatted because this is a browser
 * bundle with no node:path.
 */
import { WorkflowForm, type WorkflowField } from "./workflowForm";
import { findingRows, showArgs } from "./findings";
import { HOME_BUTTONS } from "./homeConfig";
import { homeAvailability, REASON_TEXT } from "./availability";
import { WIZARD_FAMILIES, checklistRows, examplesFor, type NextStepPayload, type StepCommand } from "./wizard";
import { convergencePlots } from "../../shared/convergencePlots";
import { TOOLBAR_ICONS } from "../shell/shellIcons";
import type { HomeToWebview, ProjectRootInfo, RecentEntry, RecoveryInfo } from "../../main/ipc";

declare global {
  interface Window {
    homeApi: {
      post(message: unknown): void;
      onMessage(handler: (message: unknown) => void): void;
    };
  }
}

const api = window.homeApi;
const menu = document.getElementById("menu") as HTMLDivElement;

for (const { action, icon, label, description } of HOME_BUTTONS) {
  const button = document.createElement("button");
  button.className = "menu-btn card";
  button.title = description;

  const glyph = document.createElement("span");
  glyph.className = "menu-btn-icon toolbar-icon";
  glyph.innerHTML = TOOLBAR_ICONS[icon];
  const text = document.createElement("span");
  text.className = "menu-btn-text";
  const title = document.createElement("span");
  title.className = "menu-btn-label";
  title.textContent = label;
  const detail = document.createElement("span");
  detail.className = "menu-btn-description";
  detail.textContent = description;
  text.append(title, detail);
  button.append(glyph, text);

  button.addEventListener("click", () => api.post({ type: "action", action }));
  menu.appendChild(button);
}

const recents = document.getElementById("recents") as HTMLElement;
const recentsList = document.getElementById("recents-list") as HTMLDivElement;

document
  .getElementById("recents-clear")!
  .addEventListener("click", () => api.post({ type: "clearRecents" }));

function renderRecents(entries: RecentEntry[]): void {
  recentsList.replaceChildren();
  for (const entry of entries) {
    const button = document.createElement("button");
    button.className = "recent-btn";
    // Folder in the tooltip, mirroring the native menu's row; and textContent
    // throughout — a file name is data, never markup.
    button.title = entry.description;

    const glyph = document.createElement("span");
    glyph.className = "recent-btn-icon toolbar-icon";
    glyph.innerHTML = TOOLBAR_ICONS[entry.mode === "cad" ? "preMode" : "postMode"];
    const label = document.createElement("span");
    label.className = "recent-btn-label";
    label.textContent = entry.label;
    button.append(glyph, label);

    button.addEventListener("click", () =>
      api.post({ type: "openRecent", path: entry.path, mode: entry.mode })
    );
    recentsList.appendChild(button);
  }
  recents.hidden = entries.length === 0;
}

const recovery = document.getElementById("recovery") as HTMLElement;
const recoveryList = document.getElementById("recovery-list") as HTMLDivElement;

/** Task codes main stores with a checkpoint; anything unknown is simply not shown. */
function recoveryTaskText(code: string | undefined): string | null {
  return code === "kratosRun" ? t("A Kratos run was active.") : null;
}

function recoveryButton(label: string, key: string, type: "recoveryRestore" | "recoveryShow" | "recoveryDiscard", disabled = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", () => api.post({ type, key }));
  return button;
}

function renderRecovery(entries: RecoveryInfo[]): void {
  recoveryList.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "recovery-row";
    row.setAttribute("role", "group");
    // textContent throughout: a file name is data, never markup.
    const title = document.createElement("div");
    title.className = "recovery-title";
    title.textContent = entry.kind === "mesh"
      ? t("Mesh operations on {0}", { 0: entry.name })
      : entry.name ? t("Text editor changes to {0}", { 0: entry.name }) : t("Untitled text editor buffer");
    row.append(title);
    const detail = document.createElement("div");
    detail.className = "recovery-detail";
    const when = entry.savedAt ? t("Saved {0}", { 0: new Date(entry.savedAt).toLocaleString() }) : "";
    detail.textContent = [when, recoveryTaskText(entry.task)].filter(Boolean).join(" · ");
    if (detail.textContent) row.append(detail);
    if (entry.verdict !== "restorable") {
      const warn = document.createElement("div");
      warn.className = "recovery-warn";
      warn.setAttribute("role", "note");
      warn.textContent = entry.verdict === "sourceMissing"
        ? t("The original file no longer exists, so this cannot be restored.")
        : t("The file changed after this was saved, so it will not be restored over it.");
      row.append(warn);
    }
    const actions = document.createElement("div");
    actions.className = "recovery-actions";
    actions.append(
      recoveryButton(entry.kind === "mesh" ? t("Restore into a new tab") : t("Restore into the text editor"), entry.key, "recoveryRestore", entry.verdict !== "restorable"),
      recoveryButton(t("Show file"), entry.key, "recoveryShow"),
      recoveryButton(t("Discard"), entry.key, "recoveryDiscard"),
    );
    row.append(actions);
    recoveryList.append(row);
  }
  recovery.hidden = entries.length === 0;
}

const projectRootSection = document.getElementById("project-root") as HTMLElement;
const projectRootPath = document.getElementById("project-root-path") as HTMLElement;

const workflow = document.getElementById("workflow") as HTMLElement;
const workflowError = document.getElementById("workflow-error") as HTMLElement;
const studyPicker = document.getElementById("study-picker") as HTMLSelectElement;
const studyPickerLabel = document.getElementById("study-picker-label") as HTMLElement;
const studyReadiness = document.getElementById("study-readiness") as HTMLElement;
const environmentReport = document.getElementById("environment-report") as HTMLElement;
const queueStatus = document.getElementById("queue-status") as HTMLElement;
const duplicateButton = document.getElementById("study-duplicate") as HTMLButtonElement;
const planRunButton = document.getElementById("study-plan-run") as HTMLButtonElement;
const rebuildStaleButton = document.getElementById("study-rebuild-stale") as HTMLButtonElement;
const planSweepButton = document.getElementById("study-plan-sweep") as HTMLButtonElement;
const planGeometrySweepButton = document.getElementById("study-plan-geometry-sweep") as HTMLButtonElement;
let workflowSnapshot: { project?: { studies?: { id: string; handoff?: { units?: { length?: string | null } } }[]; queue?: { paused: boolean; tasks: { id: string; kind: string; state: string; runId: string }[] } }; queuePlanRevision?: string } | undefined;
let workflowAction: "show-finding" | "queue-preview" | "queue-enqueue" | "queue-resume" | "region-refs" | "region-preview" | "goal-seek-iterates" | "goal-seek-next" | undefined;
let manualRuntimeAvailable: boolean | undefined;
let selectedStudy: { id: string; name: string } | undefined;
let selectedRunId: string | undefined;
let activeStates: Record<string, string | undefined> = {};
let activeRunCount = 0;
let selectedRunHasResult = false;

/**
 * One call decides `disabled` for every study/queue button and states why in
 * `title` + `aria-description` (a disabled button is not focusable, so the
 * title is the sighted tooltip and the description covers AT that reads it).
 */
function refreshAvailability(): void {
  const queue = workflowSnapshot?.project?.queue;
  const result = homeAvailability({
    hasProjectFolder: !!projectRootPath.title,
    hasStudy: !!selectedStudy,
    manualRuntimeAvailable,
    states: activeStates,
    hasSelectedRun: !!selectedRunId,
    selectedRunHasResult,
    runCount: activeRunCount,
    queue: { paused: !!queue?.paused, taskStates: (queue?.tasks ?? []).map(task => task.state) },
  });
  for (const [id, reason] of Object.entries(result)) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (!button) continue;
    button.disabled = !!reason;
    if (reason) {
      const text = translate(REASON_TEXT[reason]);
      button.title = text;
      button.setAttribute("aria-description", text);
    } else {
      button.removeAttribute("title");
      button.removeAttribute("aria-description");
    }
  }
}

const form = new WorkflowForm(workflow, () => projectRootPath.title);
let workflowPending = false;
function meshFields(ready: boolean): WorkflowField[] {
  return ready ? [{ name: "mesh", label: t("Mesh handling"), choices: [t("Reuse mesh"), t("Regenerate mesh")], value: t("Reuse mesh") }] : [];
}
function reuseMesh(values: Record<string, string>): boolean { return values.mesh === t("Reuse mesh"); }
function meshReady(id: string): boolean {
  return (workflowSnapshot as { readiness?: Record<string, Record<string, string>> } | undefined)?.readiness?.[id]?.mesh === "ready";
}
function confirmAction(title: string, detail: string, accept: () => void): void { form.open(title, [], accept, detail); }

/** Fills the findings list under a run review; each row with a target gets a Show action. */
function renderFindings(value: unknown): void {
  const list = document.getElementById("run-review-findings") as HTMLElement;
  list.replaceChildren();
  const rows = findingRows(value);
  list.hidden = !rows?.length;
  for (const row of rows ?? []) {
    const item = document.createElement("li");
    item.className = `finding finding-${row.severity}`;
    const text = document.createElement("span");
    text.textContent = `${row.severity === "warning" || row.severity === "error" ? "⚠ " : "ⓘ "}${row.message}`;
    item.append(text);
    const args = showArgs(row, selectedStudy?.id, selectedRunId);
    if (args) {
      const show = document.createElement("button");
      show.type = "button";
      show.className = "btn-link";
      show.textContent = t("Show");
      show.addEventListener("click", () => workflowCall("study_open", args, true));
      item.append(show);
    }
    list.append(item);
  }
}

function workflowCall(tool: string, args: Record<string, unknown>, keepReview = false): void {
  if (workflowPending) return;
  workflowAction = keepReview ? "show-finding" : ["queue_plan_preview", "queue_parameter_sweep_preview", "queue_geometry_sweep_preview", "queue_retry_variant_preview"].includes(tool) ? "queue-preview"
    : tool === "queue_enqueue" ? "queue-enqueue" : tool === "queue_resume" ? "queue-resume"
    : tool === "goal_seek_iterates" ? "goal-seek-iterates" : tool === "goal_seek_next" ? "goal-seek-next"
    : tool === "study_region_references" ? "region-refs" : tool === "study_region_rename" && args.apply !== true ? "region-preview" : undefined;
  workflowPending = true; form.setBusy(true);
  workflowError.hidden = true;
  api.post({ type: "workflow", tool: `app__${tool}`, args });
}

document.getElementById("workflow-check")!.addEventListener("click", () => {
  api.post({ type: "checkEnvironment" });
});
document.getElementById("study-create")!.addEventListener("click", () => {
  form.open(t("New study"), [
    { name: "source", label: t("Geometry file path (inside the project is portable):") },
    { name: "name", label: t("Study name:"), optional: true },
  ], ({source, name}) => workflowCall("study_create", { source, name: name || source.split(/[\\/]/).pop() || t("Study") }));
});
duplicateButton.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Duplicate"), [{ name: "name", label: t("Name for the duplicate:"), value: t("{0} copy", {0: study.name}) }, ...meshFields(meshReady(study.id))],
    values => workflowCall("study_duplicate", { studyId: study.id, name: values.name, reuseMesh: reuseMesh(values) }));
});
planRunButton.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Plan run"), meshFields(meshReady(study.id)), values => {
    workflowCall("queue_plan_preview", { studyId: study.id, reuseMesh: reuseMesh(values) });
  });
});
rebuildStaleButton.addEventListener("click", () => {
  if (selectedStudy) workflowCall("queue_plan_preview", { studyId: selectedStudy.id, staleOnly: true });
});
/** "All combinations" or "Paired lists" → the tools' mode argument. */
const sweepModes = (): readonly string[] => [t("All combinations"), t("Paired lists")];
const sweepMode = (inputs: Record<string, string>): "grid" | "paired" => inputs.combinations === t("Paired lists") ? "paired" : "grid";
/** Parses `{"name": [values…], …}` into the {name, values} list both preview tools take. */
function parseSweepObject(raw: string): { name: string; values: unknown[] }[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(t("Enter a valid JSON object.")); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("Enter a valid JSON object."));
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > 4) throw new Error(t("Sweep 1–4 parameters."));
  return entries.map(([name, values]) => {
    if (!Array.isArray(values) || values.length < 1 || values.length > 50) throw new Error(t("Enter 1–50 values in a JSON array."));
    return { name, values };
  });
}
planSweepButton.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Plan sweep"), [
    { name: "parameters", label: t("Case settings to sweep as a JSON object, one array of values per dotted path (maximum 4 paths, 50 rows):"), value: '{"values.problem.timeStep": [0.05, 0.1, 0.2]}', multiline: true },
    { name: "combinations", label: t("Combine the lists as:"), choices: sweepModes(), value: t("All combinations") },
    ...meshFields(meshReady(study.id)),
  ], inputs => {
    const parameters = parseSweepObject(inputs.parameters).map(entry => ({ path: entry.name, values: entry.values }));
    workflowCall("queue_parameter_sweep_preview", { studyId: study.id, reuseMesh: reuseMesh(inputs), parameters, mode: sweepMode(inputs) });
  });
});
document.getElementById("study-plan-geometry-sweep")!.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Plan geometry sweep"), [
    { name: "variables", label: t("CAD document variables to sweep as a JSON object, one array of numbers or expressions per variable (the model must define them):"), value: '{"L": [10, 20, 30]}', multiline: true },
    { name: "combinations", label: t("Combine the lists as:"), choices: sweepModes(), value: t("All combinations") },
  ], inputs => {
    const variables = parseSweepObject(inputs.variables);
    workflowCall("queue_geometry_sweep_preview", { studyId: study.id, variables, mode: sweepMode(inputs) });
  });
});
document.getElementById("queue-resume")!.addEventListener("click", () => {
  const revision = workflowSnapshot?.queuePlanRevision;
  const tasks = workflowSnapshot?.project?.queue?.tasks ?? [];
  if (!revision || !tasks.length) return;
  const plan = tasks.map(task => `${task.kind}: ${task.id} (${task.state})`).join("\n");
  confirmAction(t("Resume queue"), `${t("Resume this exact persisted plan?\n\n{0}", {0: plan})}\n${revision}`, () => {
    workflowCall("queue_resume", { planRevision: revision });
  });
});
document.getElementById("queue-pause")!.addEventListener("click", () => workflowCall("queue_pause", {}));
document.getElementById("queue-cancel")!.addEventListener("click", () => {
  const tasks = workflowSnapshot?.project?.queue?.tasks ?? [];
  const task = tasks.find(row => ["dispatching", "running", "uncertain"].includes(row.state)) ?? tasks.find(row => ["waiting", "held"].includes(row.state));
  if (task) confirmAction(t("Cancel task"), t("Cancel {0} task {1}?", {0: task.kind, 1: task.id}), () => workflowCall("queue_cancel", { taskId: task.id }));
});
studyPicker.addEventListener("change", () => {
  selectedStudy = studyPicker.selectedOptions[0]
    ? { id: studyPicker.value, name: studyPicker.selectedOptions[0].textContent ?? "Study" }
    : undefined;
  refreshAvailability();
  if (selectedStudy) workflowCall("study_select", { studyId: selectedStudy.id });
});
for (const [id, stage] of [["study-open-geometry", "geometry"], ["study-open-mesh", "mesh"], ["study-open-case", "case"], ["study-open-results", "results"]] as const) {
  (document.getElementById(id) as HTMLButtonElement).addEventListener("click", () => {
    if (selectedStudy) workflowCall("study_open", { studyId: selectedStudy.id, stage, ...(stage === "results" && selectedRunId ? { runId: selectedRunId } : {}) });
  });
}
for (const [id, title, tool, name, label] of [
  ["study-relink-source", t("Relink geometry"), "study_relink_source", "sourcePath", t("Path to the replacement geometry file:")],
  ["study-attach-mesh", t("Attach mesh"), "study_attach_mesh", "meshPath", t("Exported mesh path:")],
] as const) document.getElementById(id)!.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(title, [{ name, label }], values => workflowCall(tool, { studyId: study.id, ...values }));
});
document.getElementById("study-copy-source")!.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  confirmAction(t("Copy geometry in project"), t("Copy this geometry into the project? The original file will stay unchanged."),
    () => workflowCall("study_copy_source_into_project", { studyId: study.id }));
});
document.getElementById("environment-retry")!.addEventListener("click", () => api.post({ type: "retrySimulationTools", install: false }));
document.getElementById("environment-install")!.addEventListener("click", () => api.post({ type: "retrySimulationTools", install: true }));
document.getElementById("environment-install-solver")!.addEventListener("click", () => api.post({ type: "installKratosSolver" }));
document.getElementById("study-set-case")!.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Set case snapshot"), [{ name: "settings", label: t("Case state JSON (the mesh viewer writes this beside the mesh):"), multiline: true }], values => {
    let caseSettings: unknown;
    try { caseSettings = JSON.parse(values.settings); } catch { throw new Error(t("Enter a JSON object.")); }
    if (!caseSettings || typeof caseSettings !== "object" || Array.isArray(caseSettings)) throw new Error(t("Enter a JSON object."));
    workflowCall("study_set_settings", { studyId: study.id, caseSettings });
  });
});
document.getElementById("study-import-run")!.addEventListener("click", () => {
  if (selectedStudy) workflowCall("study_import_run", { studyId: selectedStudy.id });
});
for (const [id, tool] of [["study-review-run", "run_review"], ["study-export-review", "run_review_export"]] as const) {
  (document.getElementById(id) as HTMLButtonElement).addEventListener("click", () => {
    if (selectedStudy && selectedRunId) workflowCall(tool, { studyId: selectedStudy.id, runId: selectedRunId });
  });
}
document.getElementById("study-region-refs")!.addEventListener("click", () => {
  if (selectedStudy) workflowCall("study_region_references", { studyId: selectedStudy.id });
});
let pendingRename: { studyId: string; renames: { from: string; to: string }[] } | undefined;
document.getElementById("study-region-rename")!.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Rename region references"), [
    { name: "from", label: t("Region path in the case settings (for example Structure/Inlet):") },
    { name: "to", label: t("New region path in the mesh:") },
  ], values => {
    pendingRename = { studyId: study.id, renames: [{ from: values.from.trim(), to: values.to.trim() }] };
    workflowCall("study_region_rename", { ...pendingRename, apply: false });
  });
});
document.getElementById("study-compare-runs")!.addEventListener("click", () => {
  // mesh 5.17.0's in-editor run comparison on study runs: the selected run is
  // the left side, the form picks the right side from the study's other runs.
  // The Markdown report renders in the run-review area like every other
  // workflowResult string.
  const study = selectedStudy, leftRunId = selectedRunId; if (!study || !leftRunId) return;
  const runs = (workflowSnapshot as { project?: { studies?: { id: string; runs?: { id: string; state?: string }[] }[] } } | undefined)
    ?.project?.studies?.find(s => s.id === study.id)?.runs?.filter(r => r.id !== leftRunId) ?? [];
  if (!runs.length) return;
  const label = (r: { id: string; state?: string }): string => `${r.id.slice(0, 8)} · ${r.state ?? "?"}`;
  form.open(t("Compare runs"), [
    { name: "other", label: t("Other run (the selected run is the left side):"), choices: runs.map(label), value: label(runs[0]) },
  ], values => {
    const match = runs.filter(r => label(r) === values.other);
    if (match.length !== 1) throw new Error(t("Pick one of the listed runs."));
    workflowCall("run_compare", { studyId: study.id, leftRunId, rightRunId: match[0].id });
  });
});
document.getElementById("study-refinement")!.addEventListener("click", () => {
  const study = selectedStudy, runId = selectedRunId; if (!study || !runId) return;
  form.open(t("Refinement metadata"), [
    { name: "method", label: t("Refinement method"), choices: ['uniform', 'adaptive'], value: 'adaptive' },
    { name: "characteristicSize", label: t("Characteristic size (required for adaptive meshes)"), optional: true },
    { name: "domainMeasure", label: t("Domain measure (uniform count-derived size only)"), optional: true },
    { name: "lengthUnit", label: t("Unit"), choices: ['m', 'cm', 'mm'], value: 'm' },
    { name: "dimension", label: t("Spatial dimension"), choices: ['1', '2', '3'], value: '3' },
    { name: "sizingDefinition", label: t("Sizing definition (same across levels)") },
    { name: "justification", label: t("Why this size represents refinement for the quantity"), multiline: true },
    { name: "comparable", label: t("Comparable geometry and discretization family confirmed"), choices: ['false', 'true'], value: 'false' },
    { name: "asymptotic", label: t("Asymptotic range assumed (not proven)"), choices: ['false', 'true'], value: 'false' },
  ], ({characteristicSize, domainMeasure, dimension, comparable, asymptotic, ...values}) => {
    workflowCall('run_refinement_set', { studyId: study.id, runId, ...values, dimension: Number(dimension), comparable: comparable === 'true', asymptotic: asymptotic === 'true',
      ...(characteristicSize ? { characteristicSize: Number(characteristicSize) } : {}), ...(domainMeasure ? { domainMeasure: Number(domainMeasure) } : {}) });
  });
});
document.getElementById("study-evaluate-quantity")!.addEventListener("click", () => {
  const study = selectedStudy; const runId = selectedRunId; if (!study || !runId) return;
  form.open(t("Evaluate quantity"), [
    { name: "field", label: t("Result field"), value: "DISPLACEMENT" },
    { name: "kind", label: t("Field location"), choices: ["Nodal", "Elemental", "Conditional"], value: "Nodal" },
    { name: "component", label: t("Component"), choices: ["scalar", "x", "y", "z", "magnitude"], value: "magnitude" },
    { name: "reduction", label: t("Reduction"), choices: ["min", "max", "minAbs", "maxAbs", "mean", "std", "median", "sum", "count", "q1", "q3", "iqr"], value: "max" },
    { name: "unit", label: t("Unit") },
    { name: "timeStep", label: t("Time step (optional)"), optional: true },
    { name: "region", label: t("Region or SubModelPart path"), value: "global" },
    { name: "resultPath", label: t("Result path (optional)"), optional: true },
  ], ({timeStep: rawStep, resultPath, ...values}) => {
    const timeStep = rawStep ? Number(rawStep) : undefined;
    if (timeStep !== undefined && (!Number.isSafeInteger(timeStep) || timeStep < 0)) throw new Error(t("Enter a non-negative integer time step."));
    workflowCall("run_quantity_evaluate", { studyId: study.id, runId, ...values, ...(timeStep !== undefined ? { timeStep } : {}), ...(resultPath ? { resultPath } : {}) });
  });
});
// Goal seek: gather the solved iterates (read-only), ask for the next value
// (read-only), then hand a one-value sweep to the usual preview -> enqueue ->
// start confirmations. Nothing here starts a solve.
interface GoalSeekRequest { studyId: string; path: string; quantity: Record<string, unknown>; spec: Record<string, number> }
let goalSeek: GoalSeekRequest | undefined;
document.getElementById("study-goal-seek")!.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Goal seek"), [
    { name: "path", label: t("Case-settings parameter (dotted path):"), value: "values.problem.timeStep" },
    { name: "target", label: t("Target value of the quantity") },
    { name: "relTolerance", label: t("Relative tolerance"), value: "0.01" },
    { name: "lower", label: t("Lower bound of the parameter") },
    { name: "upper", label: t("Upper bound of the parameter") },
    { name: "maxStep", label: t("Maximum step") },
    { name: "initialStep", label: t("Initial step") },
    { name: "maxSolves", label: t("Maximum solves"), value: "6" },
    { name: "field", label: t("Result field"), value: "DISPLACEMENT" },
    { name: "kind", label: t("Field location"), choices: ["Nodal", "Elemental", "Conditional"], value: "Nodal" },
    { name: "component", label: t("Component"), choices: ["scalar", "x", "y", "z", "magnitude"], value: "magnitude" },
    { name: "reduction", label: t("Reduction"), choices: ["min", "max", "minAbs", "maxAbs", "mean", "std", "median", "sum", "count", "q1", "q3", "iqr"], value: "max" },
    { name: "unit", label: t("Unit") },
    { name: "time", label: t("Time (optional)"), optional: true },
    { name: "region", label: t("Region or SubModelPart path"), value: "global" },
  ], values => {
    const num = (name: string): number => {
      const n = Number(values[name]);
      if (!Number.isFinite(n)) throw new Error(t("Enter a finite number for {0}.", {0: name}));
      return n;
    };
    const spec = { target: num("target"), relTolerance: num("relTolerance"), lower: num("lower"), upper: num("upper"), maxStep: num("maxStep"), initialStep: num("initialStep"), maxSolves: num("maxSolves") };
    if (!Number.isSafeInteger(spec.maxSolves) || spec.maxSolves < 2) throw new Error(t("Enter at least two solves."));
    const time = values.time ? Number(values.time) : undefined;
    if (time !== undefined && !Number.isFinite(time)) throw new Error(t("Enter a finite number for {0}.", {0: "time"}));
    const quantity = { field: values.field, kind: values.kind, component: values.component, region: values.region, reduction: values.reduction, unit: values.unit, ...(time !== undefined ? { time } : {}) };
    goalSeek = { studyId: study.id, path: values.path, quantity, spec };
    workflowCall("goal_seek_iterates", { studyId: study.id, parameterPath: values.path, ...quantity });
  });
});
for (const [id, tool] of [["study-compare-variants", "variants_compare"], ["study-export-comparison", "variants_compare_export"]] as const) {
  (document.getElementById(id) as HTMLButtonElement).addEventListener("click", () => {
    if (selectedStudy) workflowCall(tool, { studyId: selectedStudy.id });
  });
}

// ---- New Simulation wizard ---------------------------------
// Step 1 picks a physics family, step 2 an example of it (or the user's own
// geometry); main extracts/picks, creates the study and answers `wizardDone`.
// The checklist below is rendered from the `nextStep` push main sends with every
// workflow state, so it follows the study as the user works.
document.getElementById("study-wizard")!.addEventListener("click", () => {
  const families = WIZARD_FAMILIES.map(f => translate(f.label));
  form.open(translate("New simulation"), [
    { name: "family", label: translate("What do you want to simulate?"), choices: families, value: families[0] },
  ], ({ family }) => {
    const chosen = WIZARD_FAMILIES[families.indexOf(family)];
    if (!chosen) throw new Error(translate("Choose a physics family."));
    const examples = examplesFor(chosen.id);
    const own = translate("Use my own geometry");
    const labels = examples.map(e => translate(e.label));
    form.complete();
    form.open(translate("Start from"), [
      { name: "start", label: translate("Start from an example case or your own geometry:"), choices: [...labels, own], value: labels[0] ?? own },
    ], ({ start }) => {
      const example = examples[labels.indexOf(start)];
      workflowPending = true; form.setBusy(true); workflowError.hidden = true;
      api.post(example ? { type: "wizardStart", kind: "example", id: example.id } : { type: "wizardStart", kind: "own" });
    });
  });
});

const checklistSection = document.getElementById("study-checklist") as HTMLElement;
const checklistList = document.getElementById("study-checklist-list") as HTMLOListElement;
const COMMAND_BUTTON: Partial<Record<StepCommand, string>> = {
  "relink-source": "study-relink-source", "attach-mesh": "study-attach-mesh", "plan-run": "study-plan-run", "review-run": "study-review-run",
};
const COMMAND_STAGE: Partial<Record<StepCommand, "geometry" | "mesh" | "case">> = {
  "open-geometry": "geometry", "open-mesh": "mesh", "open-case": "case",
};
function runStepCommand(studyId: string, command: StepCommand): void {
  const stage = COMMAND_STAGE[command];
  if (stage) { workflowCall("study_open", { studyId, stage }); return; }
  // Everything else is an existing Home button (and so keeps its own availability rules).
  const button = document.getElementById(COMMAND_BUTTON[command] ?? "") as HTMLButtonElement | null;
  if (button && !button.disabled) button.click();
}
function renderChecklist(value: unknown): void {
  checklistList.replaceChildren();
  const payload = value as NextStepPayload | null;
  checklistSection.hidden = !payload || !Array.isArray(payload.steps);
  if (!payload || !Array.isArray(payload.steps)) return;
  for (const row of checklistRows(payload)) {
    const item = document.createElement("li");
    item.className = `checklist-row${row.isNext ? " is-next" : ""}`;
    const text = document.createElement("span"); text.className = "checklist-text";
    const label = document.createElement("span"); label.className = "checklist-label"; label.textContent = translate(row.label);
    const state = document.createElement("span"); state.className = "checklist-state";
    state.textContent = [translate(row.stateLabel), row.why ? translate(row.why) : undefined].filter(Boolean).join(" \u00b7 ");
    text.append(label, state);
    const open = document.createElement("button"); open.type = "button"; open.className = "btn-link";
    open.textContent = translate(row.button); open.disabled = !row.enabled;
    if (row.why) { open.title = translate(row.why); }
    open.addEventListener("click", () => runStepCommand(payload.studyId, row.command));
    item.append(text, open);
    checklistList.append(item);
  }
}

function renderWorkflow(raw: unknown): void {
  workflow.hidden = false;
  if (!raw || typeof raw !== "object") { studyPickerLabel.hidden = true; selectedStudy = undefined; activeStates = {}; refreshAvailability(); return; }
  const value = raw as { project?: { studies?: { id: string; name: string; parentId?: string; handoff?: { units?: { length?: string | null } }; runs?: { id: string; state?: string; artifacts: { role: string }[] }[] }[]; activeStudyId?: string; activeRunId?: string; queue?: { paused: boolean; tasks: { id: string; studyId: string; kind: string; state: string; runId: string }[] } }; readiness?: Record<string, Record<string, string>>; queuePlanRevision?: string; environment?: { manual?: { available: boolean }; requirementsComplete?: boolean } };
  manualRuntimeAvailable = value.environment ? !!value.environment.manual?.available && value.environment.requirementsComplete !== false : undefined;
  workflowSnapshot = value;
  const hasProject = !!value.project;
  const studies = hasProject ? value.project?.studies ?? [] : [];
  // A selected project folder is enough to create the first optional study;
  // the project.json file is initialized by the service on that first write.
  studyPicker.replaceChildren();
  for (const study of studies) {
    const option = document.createElement("option");
    option.value = study.id; option.textContent = study.name;
    studyPicker.append(option);
  }
  studyPickerLabel.hidden = studies.length === 0;
  const active = studies.find(s => s.id === value.project?.activeStudyId) ?? studies[0];
  const variantContainer = document.getElementById("variant-rows")!;
  variantContainer.replaceChildren();
  if (active) {
    studyPicker.value = active.id;
    selectedStudy = active;
    activeStates = value.readiness?.[active.id] ?? {};
    selectedRunId = value.project?.activeRunId ?? active.runs?.[Math.max(0, (active.runs?.length ?? 0) - 1)]?.id;
    activeRunCount = active.runs?.length ?? 0;
    selectedRunHasResult = !!active.runs?.some(r => r.id === selectedRunId && r.artifacts.some(a => a.role === "result"));
    const states = activeStates;
    studyReadiness.textContent = ["geometry", "mesh", "case", "run", "results"]
      .map(step => `${translate(step)}: ${translate(states[step] ?? "missing")}`).join(" · ");
    const parentId = active.parentId ?? active.id;
    const group = studies.filter(study => study.id === parentId || study.parentId === parentId);
    for (const study of group) {
      const rowTasks = value.project?.queue?.tasks.filter(task => task.studyId === study.id).sort((a, b) => value.project!.queue!.tasks.indexOf(a) - value.project!.queue!.tasks.indexOf(b)) ?? [];
      const latestRun = study.runs?.[study.runs.length - 1];
      const latestQueueRunId = [...rowTasks].reverse().find(task => task.kind === "solve")?.runId;
      const runId = latestQueueRunId ?? latestRun?.id;
      const tasks = rowTasks.filter(task => !runId || task.runId === runId);
      const selectedRun = study.runs?.find(run => run.id === runId);
      const failure = selectedRun && ["failed", "cancelled", "blocked"].includes(selectedRun.state ?? "") || tasks.some(task => ["failed", "cancelled", "blocked"].includes(task.state));
      const activeTask = tasks.some(task => ["dispatching", "running", "uncertain"].includes(task.state));
      const hasOpenTasks = rowTasks.some(task => ["waiting", "held", "dispatching", "running", "uncertain"].includes(task.state));
      const waitingTasks = tasks.filter(task => ["waiting", "held"].includes(task.state));
      const row = document.createElement("div"); row.className = "variant-row";
      const label = document.createElement("span"); label.className = "variant-row-label";
      const status = selectedRun?.state ?? (tasks.length ? tasks[tasks.length - 1].state : "not run");
      label.textContent = `${study.name} · ${translate(status)}${runId ? ` · ${runId.slice(0, 8)}` : ""}`;
      row.append(label);
      const actions = document.createElement("span"); actions.className = "variant-row-actions";
      if (!failure && !activeTask && waitingTasks.length && value.queuePlanRevision && manualRuntimeAvailable !== false) {
        const resume = document.createElement("button"); resume.type = "button"; resume.className = "btn-link"; resume.textContent = t("Resume row");
        resume.addEventListener("click", () => {
          const taskList = waitingTasks.map(task => `${task.kind}: ${task.state}`).join(" · ");
          confirmAction(t("Resume row"), t("Resume only {0} from the approved queue plan? Other waiting rows will stay held.\n\n{1}\nPlan revision: {2}", {0: study.name, 1: taskList, 2: value.queuePlanRevision}), () =>
            workflowCall("queue_resume_row", { taskId: waitingTasks[0].id, planRevision: value.queuePlanRevision }));
        });
        actions.append(resume);
      }
      if (failure && !hasOpenTasks) {
        const retry = document.createElement("button"); retry.type = "button"; retry.className = "btn-link"; retry.textContent = t("Retry row");
        retry.addEventListener("click", () => {
          form.open(t("Retry row"), meshFields(value.readiness?.[study.id]?.mesh === "ready"), values => {

            workflowCall("queue_retry_variant_preview", { studyId: study.id, reuseMesh: reuseMesh(values) });
          });
        });
        actions.append(retry);
      }
      row.append(actions); variantContainer.append(row);
    }
  } else {
    selectedStudy = undefined; selectedRunId = undefined; activeStates = {}; activeRunCount = 0; selectedRunHasResult = false;
    studyReadiness.textContent = t("No studies yet.");
  }
  const queue = value.project?.queue;
  const tasks = queue?.tasks ?? [];
  const activeQueueTasks = tasks.filter(task => ["dispatching", "running", "uncertain"].includes(task.state));
  queueStatus.textContent = tasks.length
    ? t("Queue {0}: {1}", {0: queue?.paused ? t("paused") : t("running"), 1: tasks.map(task => `${translate(task.kind)} ${translate(task.state)}`).join(" · ")})
    : t("Queue empty.");
  refreshAvailability();
}

document
  .getElementById("project-root-change")!
  .addEventListener("click", () => api.post({ type: "chooseProjectRoot" }));
document
  .getElementById("project-root-clear")!
  .addEventListener("click", () => api.post({ type: "clearProjectRoot" }));

function renderProjectRoot(info: ProjectRootInfo): void {
  // Only an explicitly chosen root is shown; an inferred one would change every
  // time the focused document did.
  projectRootPath.textContent = info.display ?? "";
  projectRootPath.title = info.path ?? "";
  projectRootSection.hidden = !info.path;
  refreshAvailability();
}

api.onMessage((raw) => {
  const message = raw as HomeToWebview;
  if (message?.type === "recents") renderRecents(message.entries);
  if (message?.type === "recovery") renderRecovery(message.entries);
  else if (message?.type === "projectRoot") renderProjectRoot(message);
  else if (message?.type === "workflowState") renderWorkflow(message.value);
  else if (message?.type === "nextStep") renderChecklist(message.value);
  else if (message?.type === "wizardDone") { workflowPending = false; form.complete(); }
  else if (message?.type === "environmentReport") {
    const report = message.value as {
      manual?: { available: boolean; executable?: string; version?: string; kratosVersion?: string; reason?: string; capabilities?: { threads: boolean; mpi: boolean; mpiReason?: string; mpiLauncher?: string }; applications?: { name: string; available: boolean; reason?: string }[] };
      tools?: { available: boolean; executable?: string; version?: string; kratosVersion?: string; reason?: string; applications?: { name: string; available: boolean; reason?: string }[] };
      directory?: string; writable?: boolean; directoryReason?: string; cpuCount?: number; memoryBytes?: number;
      suggestedThreads?: number; requirementsComplete?: boolean; host?: string;
    };
    manualRuntimeAvailable = !!report.manual?.available && report.requirementsComplete !== false && report.writable === true;
    const runtimeLine = (name: string, runtime: typeof report.manual): string => {
      if (!runtime) return `${name}: ${t("unavailable")}`;
      const identity = [runtime.executable, runtime.version && `Python ${runtime.version}`, runtime.kratosVersion && `Kratos ${runtime.kratosVersion}`].filter(Boolean).join(" · ");
      return `${name}: ${runtime.available ? t("available") : runtime.reason ?? t("unavailable")}${identity ? ` · ${identity}` : ""}`;
    };
    const applicationLines = [report.manual, report.tools].flatMap(runtime => runtime?.applications ?? []).map(application =>
      `${application.name}: ${application.available ? t("available") : application.reason ?? t("missing")}`);
    environmentReport.textContent = [
      report.host ? t("Checked on ssh host {0}: guided solves run there", {0: report.host}) : undefined,
      runtimeLine(t("Manual runs"), report.manual),
      runtimeLine(t("Assistant tools"), report.tools),
      ...new Set(applicationLines),
      t("Run directory{0}: {1}", {0: report.directory ? ` (${report.directory})` : "", 1: report.writable ? t("writable") : report.directoryReason ?? t("unavailable")}),
      report.requirementsComplete === false ? t("Required applications: this case has no declared built-in requirements, so verification is incomplete.") : undefined,
      report.cpuCount ? t("Available CPU cores: {0}", {0: report.cpuCount}) : undefined,
      report.memoryBytes ? t("Available memory: {0} GiB", {0: (report.memoryBytes / 1024 ** 3).toFixed(1)}) : undefined,
      report.suggestedThreads ? t("Suggested thread limit: {0}", {0: report.suggestedThreads}) : undefined,
      report.manual?.capabilities?.mpi === false ? t("MPI unavailable: {0}", {0: report.manual.capabilities.mpiReason}) : undefined,
      report.manual?.capabilities?.mpi === true ? t("MPI available via {0}: set MPI Ranks in Settings → Kratos to run guided solves on several ranks of this node.", {0: report.manual.capabilities.mpiLauncher}) : undefined,
    ].filter(Boolean).join("\n");
    (document.getElementById("environment-actions") as HTMLElement).hidden = !!report.tools?.available;
    // The managed solver runtime is local: offered only while this machine's manual runtime is unusable.
    (document.getElementById("environment-solver-actions") as HTMLElement).hidden = !!report.manual?.available || !!report.host;
    refreshAvailability();
  }
  else if (message?.type === "workflowResult") {
    workflowPending = false; form.complete();
    const value = message.value;
    // Show on a finding opens a viewer; the review it came from stays on screen.
    if (workflowAction === "show-finding") { workflowAction = undefined; return; }
    const plots = document.getElementById("run-review-plots")!;
    plots.replaceChildren();
    renderFindings(value);
    const samples = value && typeof value === "object" ? (value as { evidence?: { convergence?: { samples?: unknown } } }).evidence?.convergence?.samples : undefined;
    if (Array.isArray(samples) && samples.every(s => s && typeof s === "object" && typeof s.iteration === "number" &&
      (s.converged === null || typeof s.converged === "boolean"))) {
      plots.innerHTML = convergencePlots(samples);
    }
    if (workflowAction === "goal-seek-iterates" && value && typeof value === "object" && goalSeek) {
      const found = value as { start?: number | null; iterates?: unknown[] };
      workflowCall("goal_seek_next", { ...goalSeek.spec, ...(typeof found.start === "number" ? { start: found.start } : {}), iterates: found.iterates ?? [] });
      return;
    }
    if (workflowAction === "goal-seek-next" && value && typeof value === "object" && goalSeek) {
      workflowAction = undefined;
      const request = goalSeek; goalSeek = undefined;
      const decision = value as { kind?: string; x?: number; y?: number; reason?: string };
      const review = document.getElementById("run-review") as HTMLElement;
      if (decision.kind === "reached") review.textContent = t("Goal reached: {0} = {1} gives {2}.", {0: request.path, 1: String(decision.x), 2: String(decision.y)});
      else if (decision.kind === "stopped") review.textContent = t("Goal seek stopped: {0}", {0: decision.reason ?? ""});
      else if (decision.kind === "notReached") review.textContent = t("Goal not reached: {0}", {0: decision.reason ?? ""});
      else if (decision.kind === "next" && typeof decision.x === "number") {
        review.textContent = t("Goal seek suggests {0} = {1}. Review the one-value sweep and confirm to queue it.", {0: request.path, 1: String(decision.x)});
        workflowCall("queue_parameter_sweep_preview", { studyId: request.studyId, reuseMesh: meshReady(request.studyId), mode: "grid", parameters: [{ path: request.path, values: [decision.x] }] });
      } else review.textContent = JSON.stringify(value, null, 2);
      return;
    }
    if (workflowAction === "region-refs" && value && typeof value === "object") {
      workflowAction = undefined;
      const report = (value as { report?: { available?: boolean; unavailableReason?: string; regions?: { path: string; status: string; possibleRename?: string; references: { owner: string; label: string }[] }[]; newRegions?: string[] } }).report;
      const lines: string[] = [t("Region references (matched by name only):")];
      if (!report?.available) lines.push(report?.unavailableReason ?? t("Not available for this mesh."));
      else {
        for (const row of report.regions ?? []) {
          const used = row.references.map(r => `${r.owner} ${r.label}`).join(", ");
          lines.push(`${row.status === "kept" ? "✓" : "✗"} ${row.path} — ${used}${row.possibleRename ? ` → ${t("possible rename: {0}", {0: row.possibleRename})}` : ""}`);
        }
        if (report.newRegions?.length) lines.push(t("In the mesh, not referenced: {0}", {0: report.newRegions.join(", ")}));
      }
      (document.getElementById("run-review") as HTMLElement).textContent = lines.join("\n");
      return;
    }
    if (workflowAction === "region-preview" && value && typeof value === "object" && pendingRename) {
      workflowAction = undefined;
      const preview = value as { wouldChange?: number; settingsRevision?: string };
      const request = pendingRename; pendingRename = undefined;
      const rename = request.renames[0];
      if (preview.settingsRevision && preview.wouldChange) confirmAction(t("Rename region references"),
        t("Move {0} reference(s) from {1} to {2} in this study's case settings? Names only: the mesh is not changed.", {0: String(preview.wouldChange), 1: rename.from, 2: rename.to}),
        () => workflowCall("study_region_rename", { ...request, apply: true, expectedSettingsRevision: preview.settingsRevision }));
      (document.getElementById("run-review") as HTMLElement).textContent = t("{0} reference(s) would change.", {0: String(preview.wouldChange ?? 0)});
      return;
    }
    if (workflowAction === "queue-preview" && value && typeof value === "object") {
      const preview = value as { previewId?: string; summary?: string[]; tasks?: { kind: string; id: string; runId: string }[]; runId?: string; nothingToDo?: boolean; nothingToRebuild?: boolean; reevaluate?: unknown[] };
      workflowAction = undefined;
      if (preview.nothingToDo || preview.nothingToRebuild) {
        const study = selectedStudy, runId = selectedRunId;
        const count = preview.reevaluate?.length ?? 0;
        (document.getElementById("run-review") as HTMLElement).textContent = preview.nothingToDo ? t("Everything is current; nothing to rebuild.") : t("Results are current, but {0} saved quantity(ies) were evaluated on a changed result.", {0: String(count)});
        if (preview.nothingToRebuild && study && runId) confirmAction(t("Re-evaluate quantities"), t("Replay the saved quantities of the previous run on the selected run's current result?"), () => workflowCall("run_quantity_reevaluate", { studyId: study.id, runId }));
        return;
      }
      const summary = preview.summary?.join("\n") ?? JSON.stringify(value, null, 2);
      if (preview.previewId) confirmAction(t("Persist paused plan"), t("Queue preview\n\n{0}\n\nPersist this paused plan?", {0: summary}), () => {
        workflowCall("queue_enqueue", { previewId: preview.previewId });
      });
      (document.getElementById("run-review") as HTMLElement).textContent = t("Run plan preview:\n{0}", {0: summary});
      return;
    }
    if ((workflowAction === "queue-enqueue" || workflowAction === "queue-resume") && value && typeof value === "object") {
      const action = workflowAction;
      workflowAction = undefined;
      if (action === "queue-enqueue") {
        const queued = value as { planRevision?: string; tasks?: { kind: string; id: string; runId: string }[] };
        const taskList = queued.tasks?.map(task => `${task.kind}: ${task.id} · run ${task.runId}`).join("\n") ?? t("No tasks");
        if (queued.planRevision) confirmAction(t("Start plan"), t("The exact plan is persisted and paused. Start it now?\n\nPlan revision: {0}\n{1}", {0: queued.planRevision, 1: taskList}), () => {
          workflowCall("queue_resume", { planRevision: queued.planRevision });
        });
      }
      (document.getElementById("run-review") as HTMLElement).textContent = JSON.stringify(value, null, 2);
      return;
    }
    const review = document.getElementById("run-review") as HTMLElement;
    review.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  else if (message?.type === "workflowBusy") (document.getElementById("workflow-check") as HTMLButtonElement).disabled = message.busy;
  else if (message?.type === "workflowError") { workflowPending = false; form.fail(message.message); workflowError.textContent = message.message; workflowError.hidden = false; }
});

api.post({ type: "homeReady" });
