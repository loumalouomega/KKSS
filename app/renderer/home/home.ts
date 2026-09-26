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
import { HOME_BUTTONS } from "./homeConfig";
import { convergencePlots } from "../../shared/convergencePlots";
import { TOOLBAR_ICONS } from "../shell/shellIcons";
import type { HomeToWebview, ProjectRootInfo, RecentEntry } from "../../main/ipc";

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
const planSweepButton = document.getElementById("study-plan-sweep") as HTMLButtonElement;
let workflowSnapshot: { project?: { studies?: { id: string; handoff?: { units?: { length?: string | null } } }[]; queue?: { paused: boolean; tasks: { id: string; kind: string; state: string; runId: string }[] } }; queuePlanRevision?: string } | undefined;
let workflowAction: "queue-preview" | "queue-enqueue" | "queue-resume" | undefined;
let manualRuntimeAvailable: boolean | undefined;
let selectedStudy: { id: string; name: string } | undefined;
let selectedRunId: string | undefined;

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

function workflowCall(tool: string, args: Record<string, unknown>): void {
  if (workflowPending) return;
  workflowAction = ["queue_plan_preview", "queue_parameter_sweep_preview", "queue_retry_variant_preview"].includes(tool) ? "queue-preview"
    : tool === "queue_enqueue" ? "queue-enqueue" : tool === "queue_resume" ? "queue-resume" : undefined;
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
planSweepButton.addEventListener("click", () => {
  const study = selectedStudy; if (!study) return;
  form.open(t("Plan sweep"), [
    { name: "parameterPath", label: t("Case setting path (for example values.problem.timeStep):") },
    { name: "values", label: t("Sweep values as a JSON array (maximum 50):"), value: "[0.05, 0.1, 0.2]", multiline: true },
    ...meshFields(meshReady(study.id)),
  ], inputs => {
    let values: unknown;
    try { values = JSON.parse(inputs.values); } catch { throw new Error(t("Enter a valid JSON array.")); }
    if (!Array.isArray(values) || values.length < 1 || values.length > 50) throw new Error(t("Enter 1–50 values in a JSON array."));

    workflowCall("queue_parameter_sweep_preview", { studyId: study.id, reuseMesh: reuseMesh(inputs), parameterPath: inputs.parameterPath, values });
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
  duplicateButton.disabled = !selectedStudy;
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
for (const [id, tool] of [["study-compare-variants", "variants_compare"], ["study-export-comparison", "variants_compare_export"]] as const) {
  (document.getElementById(id) as HTMLButtonElement).addEventListener("click", () => {
    if (selectedStudy) workflowCall(tool, { studyId: selectedStudy.id });
  });
}

function renderWorkflow(raw: unknown): void {
  workflow.hidden = false;
  if (!raw || typeof raw !== "object") { studyPickerLabel.hidden = true; duplicateButton.disabled = true; return; }
  const value = raw as { project?: { studies?: { id: string; name: string; parentId?: string; handoff?: { units?: { length?: string | null } }; runs?: { id: string; state?: string; artifacts: { role: string }[] }[] }[]; activeStudyId?: string; activeRunId?: string; queue?: { paused: boolean; tasks: { id: string; studyId: string; kind: string; state: string; runId: string }[] } }; readiness?: Record<string, Record<string, string>>; queuePlanRevision?: string; environment?: { manual?: { available: boolean }; requirementsComplete?: boolean } };
  manualRuntimeAvailable = value.environment ? !!value.environment.manual?.available && value.environment.requirementsComplete !== false : undefined;
  workflowSnapshot = value;
  const hasProject = !!value.project;
  const studies = hasProject ? value.project?.studies ?? [] : [];
  // A selected project folder is enough to create the first optional study;
  // the project.json file is initialized by the service on that first write.
  (document.getElementById("study-create") as HTMLButtonElement).disabled = !projectRootPath.title;
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
    duplicateButton.disabled = false;
    planRunButton.disabled = manualRuntimeAvailable === false;
    planSweepButton.disabled = manualRuntimeAvailable === false;
    const states = value.readiness?.[active.id] ?? {};
    selectedRunId = value.project?.activeRunId ?? active.runs?.[Math.max(0, (active.runs?.length ?? 0) - 1)]?.id;
    (document.getElementById("study-open-geometry") as HTMLButtonElement).disabled = states.geometry !== "ready";
    (document.getElementById("study-open-mesh") as HTMLButtonElement).disabled = states.mesh !== "ready";
    (document.getElementById("study-open-case") as HTMLButtonElement).disabled = states.mesh !== "ready";
    (document.getElementById("study-open-results") as HTMLButtonElement).disabled = !active.runs?.some(r => r.id === selectedRunId && r.artifacts.some(a => a.role === "result"));
    (document.getElementById("study-attach-mesh") as HTMLButtonElement).disabled = false;
    (document.getElementById("study-relink-source") as HTMLButtonElement).disabled = false;
    (document.getElementById("study-copy-source") as HTMLButtonElement).disabled = false;
    (document.getElementById("study-set-case") as HTMLButtonElement).disabled = states.mesh !== "ready";
    (document.getElementById("study-import-run") as HTMLButtonElement).disabled = !states.mesh || states.mesh !== "ready";
    (document.getElementById("study-review-run") as HTMLButtonElement).disabled = !selectedRunId;
    (document.getElementById("study-evaluate-quantity") as HTMLButtonElement).disabled = !selectedRunId;
    (document.getElementById("study-export-review") as HTMLButtonElement).disabled = !selectedRunId;
    (document.getElementById("study-compare-variants") as HTMLButtonElement).disabled = false;
    (document.getElementById("study-export-comparison") as HTMLButtonElement).disabled = false;
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
    selectedStudy = undefined; selectedRunId = undefined; duplicateButton.disabled = true; planRunButton.disabled = true; planSweepButton.disabled = true; studyReadiness.textContent = t("No studies yet.");
    for (const id of ["study-open-geometry", "study-open-mesh", "study-open-case", "study-open-results"]) (document.getElementById(id) as HTMLButtonElement).disabled = true;
    for (const id of ["study-relink-source", "study-copy-source", "study-attach-mesh", "study-set-case", "study-import-run", "study-review-run", "study-evaluate-quantity", "study-export-review", "study-compare-variants", "study-export-comparison"]) (document.getElementById(id) as HTMLButtonElement).disabled = true;
  }
  const queue = value.project?.queue;
  const tasks = queue?.tasks ?? [];
  const activeQueueTasks = tasks.filter(task => ["dispatching", "running", "uncertain"].includes(task.state));
  queueStatus.textContent = tasks.length
    ? t("Queue {0}: {1}", {0: queue?.paused ? t("paused") : t("running"), 1: tasks.map(task => `${translate(task.kind)} ${translate(task.state)}`).join(" · ")})
    : t("Queue empty.");
  (document.getElementById("queue-resume") as HTMLButtonElement).disabled = !queue?.paused || tasks.length === 0 || manualRuntimeAvailable === false;
  (document.getElementById("queue-pause") as HTMLButtonElement).disabled = !!queue?.paused || tasks.length === 0;
  (document.getElementById("queue-cancel") as HTMLButtonElement).disabled = tasks.length === 0 || (!activeQueueTasks.length && !tasks.some(task => ["waiting", "held"].includes(task.state)));
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
  (document.getElementById("study-create") as HTMLButtonElement).disabled = !info.path;
}

api.onMessage((raw) => {
  const message = raw as HomeToWebview;
  if (message?.type === "recents") renderRecents(message.entries);
  else if (message?.type === "projectRoot") renderProjectRoot(message);
  else if (message?.type === "workflowState") renderWorkflow(message.value);
  else if (message?.type === "environmentReport") {
    const report = message.value as {
      manual?: { available: boolean; executable?: string; version?: string; kratosVersion?: string; reason?: string; capabilities?: { threads: boolean; mpi: boolean; mpiReason?: string }; applications?: { name: string; available: boolean; reason?: string }[] };
      tools?: { available: boolean; executable?: string; version?: string; kratosVersion?: string; reason?: string; applications?: { name: string; available: boolean; reason?: string }[] };
      directory?: string; writable?: boolean; directoryReason?: string; cpuCount?: number; memoryBytes?: number;
      suggestedThreads?: number; requirementsComplete?: boolean;
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
      runtimeLine(t("Manual runs"), report.manual),
      runtimeLine(t("Assistant tools"), report.tools),
      ...new Set(applicationLines),
      t("Run directory{0}: {1}", {0: report.directory ? ` (${report.directory})` : "", 1: report.writable ? t("writable") : report.directoryReason ?? t("unavailable")}),
      report.requirementsComplete === false ? t("Required applications: this case has no declared built-in requirements, so verification is incomplete.") : undefined,
      report.cpuCount ? t("Available CPU cores: {0}", {0: report.cpuCount}) : undefined,
      report.memoryBytes ? t("Available memory: {0} GiB", {0: (report.memoryBytes / 1024 ** 3).toFixed(1)}) : undefined,
      report.suggestedThreads ? t("Suggested thread limit: {0}", {0: report.suggestedThreads}) : undefined,
      report.manual?.capabilities?.mpi === false ? t("MPI unavailable: {0}", {0: report.manual.capabilities.mpiReason}) : undefined,
    ].filter(Boolean).join("\n");
    (document.getElementById("environment-actions") as HTMLElement).hidden = !!report.tools?.available;
    planRunButton.disabled = !selectedStudy || manualRuntimeAvailable === false;
    planSweepButton.disabled = !selectedStudy || manualRuntimeAvailable === false;
    const queue = workflowSnapshot?.project?.queue;
    (document.getElementById("queue-resume") as HTMLButtonElement).disabled = !queue?.paused || !queue.tasks.length || manualRuntimeAvailable === false;
  }
  else if (message?.type === "workflowResult") {
    workflowPending = false; form.complete();
    const value = message.value;
    const plots = document.getElementById("run-review-plots")!;
    plots.replaceChildren();
    const samples = value && typeof value === "object" ? (value as { evidence?: { convergence?: { samples?: unknown } } }).evidence?.convergence?.samples : undefined;
    if (Array.isArray(samples) && samples.every(s => s && typeof s === "object" && typeof s.iteration === "number" &&
      (s.converged === null || typeof s.converged === "boolean"))) {
      plots.innerHTML = convergencePlots(samples);
    }
    if (workflowAction === "queue-preview" && value && typeof value === "object") {
      const preview = value as { previewId?: string; summary?: string[]; tasks?: { kind: string; id: string; runId: string }[]; runId?: string };
      workflowAction = undefined;
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
