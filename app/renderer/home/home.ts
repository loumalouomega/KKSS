/**
 * Home screen: the config-driven main menu shown on launch (see homeConfig.ts),
 * plus the recent-files list.
 *
 * The buttons are static config; the recents list and the project-root line are
 * pushed from main over home:toWebview and re-pushed on `homeReady`, so a
 * reload replays them. Both arrive pre-formatted because this is a browser
 * bundle with no node:path.
 */
import { HOME_BUTTONS } from "./homeConfig";
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

function workflowCall(tool: string, args: Record<string, unknown>): void {
  workflowError.hidden = true;
  api.post({ type: "workflow", tool: `app__${tool}`, args });
}

document.getElementById("workflow-check")!.addEventListener("click", () => {
  api.post({ type: "checkEnvironment" });
});
document.getElementById("study-create")!.addEventListener("click", () => {
  const source = window.prompt("Geometry file path (inside the project is portable):");
  if (!source) return;
  const name = window.prompt("Study name:", source.split(/[\\/]/).pop() ?? "Study");
  if (name) workflowCall("study_create", { name, source });
});
duplicateButton.addEventListener("click", () => {
  if (!selectedStudy) return;
  const name = window.prompt("Name for the duplicate:", `${selectedStudy.name} copy`);
  if (!name) return;
  const reuseMesh = window.confirm("Reuse this study’s existing mesh? Choose Cancel to regenerate the mesh.");
  workflowCall("study_duplicate", { studyId: selectedStudy.id, name, reuseMesh });
});
planRunButton.addEventListener("click", () => {
  if (!selectedStudy) return;
  const readyMesh = workflowSnapshot?.project && selectedStudy
    ? (workflowSnapshot as unknown as { readiness?: Record<string, Record<string, string>> }).readiness?.[selectedStudy.id]?.mesh === "ready"
    : false;
  const reuseMesh = readyMesh && window.confirm("Reuse this study’s current mesh? Choose Cancel to regenerate it.");
  workflowAction = "queue-preview";
  workflowCall("queue_plan_preview", { studyId: selectedStudy.id, reuseMesh });
});
planSweepButton.addEventListener("click", () => {
  if (!selectedStudy) return;
  const parameterPath = window.prompt("Case setting path (for example values.problem.timeStep):");
  if (!parameterPath) return;
  const rawValues = window.prompt("Sweep values as a JSON array (maximum 50):", "[0.05, 0.1, 0.2]");
  if (!rawValues) return;
  let values: unknown;
  try { values = JSON.parse(rawValues); }
  catch { workflowError.textContent = "Enter a valid JSON array."; workflowError.hidden = false; return; }
  if (!Array.isArray(values) || values.length < 1 || values.length > 50) { workflowError.textContent = "Enter 1–50 values in a JSON array."; workflowError.hidden = false; return; }
  const readyMesh = (workflowSnapshot as unknown as { readiness?: Record<string, Record<string, string>> } | undefined)?.readiness?.[selectedStudy.id]?.mesh === "ready";
  const reuseMesh = readyMesh && window.confirm("Reuse this study’s current mesh? Choose Cancel to regenerate one for every row.");
  workflowAction = "queue-preview";
  workflowCall("queue_parameter_sweep_preview", { studyId: selectedStudy.id, reuseMesh, parameterPath, values });
});
document.getElementById("queue-resume")!.addEventListener("click", () => {
  const revision = workflowSnapshot?.queuePlanRevision;
  const tasks = workflowSnapshot?.project?.queue?.tasks ?? [];
  if (!revision || !tasks.length) return;
  const plan = tasks.map(task => `${task.kind}: ${task.id} (${task.state})`).join("\n");
  if (!window.confirm(`Resume this exact persisted plan?\n\n${plan}`)) return;
  workflowAction = "queue-resume";
  workflowCall("queue_resume", { planRevision: revision });
});
document.getElementById("queue-pause")!.addEventListener("click", () => workflowCall("queue_pause", {}));
document.getElementById("queue-cancel")!.addEventListener("click", () => {
  const tasks = workflowSnapshot?.project?.queue?.tasks ?? [];
  const task = tasks.find(row => ["dispatching", "running", "uncertain"].includes(row.state)) ?? tasks.find(row => ["waiting", "held"].includes(row.state));
  if (!task || !window.confirm(`Cancel ${task.kind} task ${task.id}?`)) return;
  workflowCall("queue_cancel", { taskId: task.id });
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
document.getElementById("study-relink-source")!.addEventListener("click", () => {
  if (!selectedStudy) return;
  const sourcePath = window.prompt("Path to the replacement geometry file:");
  if (sourcePath) workflowCall("study_relink_source", { studyId: selectedStudy.id, sourcePath });
});
document.getElementById("study-copy-source")!.addEventListener("click", () => {
  if (selectedStudy && window.confirm("Copy this geometry into the project? The original file will stay unchanged.")) workflowCall("study_copy_source_into_project", { studyId: selectedStudy.id });
});
document.getElementById("environment-retry")!.addEventListener("click", () => api.post({ type: "retrySimulationTools", install: false }));
document.getElementById("environment-install")!.addEventListener("click", () => api.post({ type: "retrySimulationTools", install: true }));
document.getElementById("study-attach-mesh")!.addEventListener("click", () => {
  if (!selectedStudy) return;
  const meshPath = window.prompt("Exported mesh path:");
  if (meshPath) workflowCall("study_attach_mesh", { studyId: selectedStudy.id, meshPath });
});
document.getElementById("study-set-case")!.addEventListener("click", () => {
  if (!selectedStudy) return;
  const raw = window.prompt("Case state JSON (the mesh viewer writes this beside the mesh):");
  if (!raw) return;
  try {
    const caseSettings = JSON.parse(raw);
    if (!caseSettings || typeof caseSettings !== "object" || Array.isArray(caseSettings)) throw new Error("Enter a JSON object.");
    workflowCall("study_set_settings", { studyId: selectedStudy.id, caseSettings });
  } catch (error) { workflowError.textContent = String(error); workflowError.hidden = false; }
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
  if (!selectedStudy || !selectedRunId) return;
  const field = window.prompt("Result field name:", "DISPLACEMENT");
  if (!field) return;
  const kind = window.prompt("Field location (Nodal, Elemental or Conditional):", "Nodal");
  if (!kind) return;
  const component = window.prompt("Component (scalar, x, y, z or magnitude):", "magnitude");
  if (!component) return;
  const region = window.prompt("Region (global or exact SubModelPart path):", "global");
  if (!region) return;
  const reduction = window.prompt("Reduction (min, max, mean, maxAbs, etc.):", "max");
  if (!reduction) return;
  const study = workflowSnapshot?.project?.studies?.find(row => row.id === selectedStudy?.id);
  const lengthUnit = study?.handoff?.units?.length ?? "";
  const defaultUnit = field.toUpperCase() === "DISPLACEMENT" ? lengthUnit : "";
  const unit = window.prompt("Quantity unit (declare explicitly):", defaultUnit);
  if (!unit) return;
  const rawStep = window.prompt("Time step index (blank for the first result):", "0");
  if (rawStep === null) return;
  const timeStep = rawStep.trim() ? Number(rawStep) : undefined;
  if (timeStep !== undefined && !Number.isInteger(timeStep)) { workflowError.textContent = "Enter an integer time step."; workflowError.hidden = false; return; }
  const resultPath = window.prompt("Optional result file path (blank uses the run's recorded result):", "");
  if (resultPath === null) return;
  workflowCall("run_quantity_evaluate", { studyId: selectedStudy.id, runId: selectedRunId, field, kind, component, region, reduction, unit, ...(timeStep !== undefined ? { timeStep } : {}), ...(resultPath.trim() ? { resultPath: resultPath.trim() } : {}) });
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
  (document.getElementById("study-create") as HTMLButtonElement).disabled = !hasProject;
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
      .map(step => `${step}: ${states[step] ?? "missing"}`).join(" · ");
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
      label.textContent = `${study.name} · ${status}${runId ? ` · ${runId.slice(0, 8)}` : ""}`;
      row.append(label);
      const actions = document.createElement("span"); actions.className = "variant-row-actions";
      if (!failure && !activeTask && waitingTasks.length && value.queuePlanRevision && manualRuntimeAvailable !== false) {
        const resume = document.createElement("button"); resume.type = "button"; resume.className = "btn-link"; resume.textContent = "Resume row";
        resume.addEventListener("click", () => {
          const taskList = waitingTasks.map(task => `${task.kind}: ${task.state}`).join(" · ");
          if (window.confirm(`Resume only ${study.name} from the approved queue plan? Other waiting rows will stay held.\n\n${taskList}\nPlan revision: ${value.queuePlanRevision}`))
            workflowCall("queue_resume_row", { taskId: waitingTasks[0].id, planRevision: value.queuePlanRevision });
        });
        actions.append(resume);
      }
      if (failure && !hasOpenTasks) {
        const retry = document.createElement("button"); retry.type = "button"; retry.className = "btn-link"; retry.textContent = "Retry row";
        retry.addEventListener("click", () => {
          const meshReady = value.readiness?.[study.id]?.mesh === "ready";
          const reuseMesh = meshReady && window.confirm(`Reuse ${study.name}'s immutable mesh? Choose Cancel to regenerate it.`);
          workflowAction = "queue-preview";
          workflowCall("queue_retry_variant_preview", { studyId: study.id, reuseMesh });
        });
        actions.append(retry);
      }
      row.append(actions); variantContainer.append(row);
    }
  } else {
    selectedStudy = undefined; selectedRunId = undefined; duplicateButton.disabled = true; planRunButton.disabled = true; planSweepButton.disabled = true; studyReadiness.textContent = "No studies yet.";
    for (const id of ["study-open-geometry", "study-open-mesh", "study-open-case", "study-open-results"]) (document.getElementById(id) as HTMLButtonElement).disabled = true;
    for (const id of ["study-relink-source", "study-copy-source", "study-attach-mesh", "study-set-case", "study-import-run", "study-review-run", "study-evaluate-quantity", "study-export-review", "study-compare-variants", "study-export-comparison"]) (document.getElementById(id) as HTMLButtonElement).disabled = true;
  }
  const queue = value.project?.queue;
  const tasks = queue?.tasks ?? [];
  const activeQueueTasks = tasks.filter(task => ["dispatching", "running", "uncertain"].includes(task.state));
  queueStatus.textContent = tasks.length
    ? `Queue ${queue?.paused ? "paused" : "running"}: ${tasks.map(task => `${task.kind} ${task.state}`).join(" · ")}`
    : "Queue empty.";
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
}

api.onMessage((raw) => {
  const message = raw as HomeToWebview;
  if (message?.type === "recents") renderRecents(message.entries);
  else if (message?.type === "projectRoot") renderProjectRoot(message);
  else if (message?.type === "workflowState") renderWorkflow(message.value);
  else if (message?.type === "environmentReport") {
    const report = message.value as { manual?: { available: boolean; reason?: string }; tools?: { available: boolean; reason?: string }; writable?: boolean; directoryReason?: string; suggestedThreads?: number; requirementsComplete?: boolean };
    manualRuntimeAvailable = !!report.manual?.available && report.requirementsComplete !== false;
    environmentReport.textContent = [
      `Manual runs: ${report.manual?.available ? "available" : report.manual?.reason ?? "unavailable"}`,
      `Assistant tools: ${report.tools?.available ? "available" : report.tools?.reason ?? "unavailable"}`,
      `Run directory: ${report.writable ? "writable" : report.directoryReason ?? "unavailable"}`,
      report.requirementsComplete === false ? "Required applications: no selected built-in case requirement is available to verify." : undefined,
      report.suggestedThreads ? `Suggested thread limit: ${report.suggestedThreads}` : undefined,
    ].filter(Boolean).join("\n");
    (document.getElementById("environment-actions") as HTMLElement).hidden = !!report.tools?.available;
    planRunButton.disabled = !selectedStudy || manualRuntimeAvailable === false;
    planSweepButton.disabled = !selectedStudy || manualRuntimeAvailable === false;
    const queue = workflowSnapshot?.project?.queue;
    (document.getElementById("queue-resume") as HTMLButtonElement).disabled = !queue?.paused || !queue.tasks.length || manualRuntimeAvailable === false;
  }
  else if (message?.type === "workflowResult") {
    const value = message.value;
    if (workflowAction === "queue-preview" && value && typeof value === "object") {
      const preview = value as { previewId?: string; summary?: string[]; tasks?: { kind: string; id: string; runId: string }[]; runId?: string };
      workflowAction = undefined;
      const summary = preview.summary?.join("\n") ?? JSON.stringify(value, null, 2);
      if (preview.previewId && window.confirm(`Queue preview\n\n${summary}\n\nPersist this paused plan?`)) {
        workflowAction = "queue-enqueue";
        workflowCall("queue_enqueue", { previewId: preview.previewId });
      }
      (document.getElementById("run-review") as HTMLElement).textContent = `Run plan preview:\n${summary}`;
      return;
    }
    if ((workflowAction === "queue-enqueue" || workflowAction === "queue-resume") && value && typeof value === "object") {
      const action = workflowAction;
      workflowAction = undefined;
      if (action === "queue-enqueue") {
        const queued = value as { planRevision?: string; tasks?: { kind: string; id: string; runId: string }[] };
        const taskList = queued.tasks?.map(task => `${task.kind}: ${task.id} · run ${task.runId}`).join("\n") ?? "No tasks";
        if (queued.planRevision && window.confirm(`The exact plan is persisted and paused. Start it now?\n\nPlan revision: ${queued.planRevision}\n${taskList}`)) {
          workflowAction = "queue-resume";
          workflowCall("queue_resume", { planRevision: queued.planRevision });
        }
      }
      (document.getElementById("run-review") as HTMLElement).textContent = JSON.stringify(value, null, 2);
      return;
    }
    const review = document.getElementById("run-review") as HTMLElement;
    review.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  else if (message?.type === "workflowBusy") (document.getElementById("workflow-check") as HTMLButtonElement).disabled = message.busy;
  else if (message?.type === "workflowError") { workflowAction = undefined; workflowError.textContent = message.message; workflowError.hidden = false; }
});

api.post({ type: "homeReady" });
