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
const duplicateButton = document.getElementById("study-duplicate") as HTMLButtonElement;
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
studyPicker.addEventListener("change", () => {
  selectedStudy = studyPicker.selectedOptions[0]
    ? { id: studyPicker.value, name: studyPicker.selectedOptions[0].textContent ?? "Study" }
    : undefined;
  duplicateButton.disabled = !selectedStudy;
  if (selectedStudy) workflowCall("study_select", { studyId: selectedStudy.id });
});
for (const [id, stage] of [["study-open-geometry", "geometry"], ["study-open-mesh", "mesh"], ["study-open-results", "results"]] as const) {
  (document.getElementById(id) as HTMLButtonElement).addEventListener("click", () => {
    if (selectedStudy) workflowCall("study_open", { studyId: selectedStudy.id, stage, ...(stage === "results" && selectedRunId ? { runId: selectedRunId } : {}) });
  });
}
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

function renderWorkflow(raw: unknown): void {
  workflow.hidden = false;
  if (!raw || typeof raw !== "object") { studyPickerLabel.hidden = true; duplicateButton.disabled = true; return; }
  const value = raw as { project?: { studies?: { id: string; name: string; runs?: { id: string; artifacts: { role: string }[] }[] }[]; activeStudyId?: string; activeRunId?: string }; readiness?: Record<string, Record<string, string>> };
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
  if (active) {
    studyPicker.value = active.id;
    selectedStudy = active;
    duplicateButton.disabled = false;
    const states = value.readiness?.[active.id] ?? {};
    selectedRunId = value.project?.activeRunId ?? active.runs?.[Math.max(0, (active.runs?.length ?? 0) - 1)]?.id;
    (document.getElementById("study-open-geometry") as HTMLButtonElement).disabled = states.geometry !== "ready";
    (document.getElementById("study-open-mesh") as HTMLButtonElement).disabled = states.mesh !== "ready";
    (document.getElementById("study-open-results") as HTMLButtonElement).disabled = !active.runs?.some(r => r.id === selectedRunId && r.artifacts.some(a => a.role === "result"));
    (document.getElementById("study-attach-mesh") as HTMLButtonElement).disabled = false;
    (document.getElementById("study-set-case") as HTMLButtonElement).disabled = states.mesh !== "ready";
    (document.getElementById("study-import-run") as HTMLButtonElement).disabled = !states.mesh || states.mesh !== "ready";
    (document.getElementById("study-review-run") as HTMLButtonElement).disabled = !selectedRunId;
    (document.getElementById("study-export-review") as HTMLButtonElement).disabled = !selectedRunId;
    studyReadiness.textContent = ["geometry", "mesh", "case", "run", "results"]
      .map(step => `${step}: ${states[step] ?? "missing"}`).join(" · ");
  } else {
    selectedStudy = undefined; selectedRunId = undefined; duplicateButton.disabled = true; studyReadiness.textContent = "No studies yet.";
    for (const id of ["study-open-geometry", "study-open-mesh", "study-open-results"]) (document.getElementById(id) as HTMLButtonElement).disabled = true;
    for (const id of ["study-attach-mesh", "study-set-case", "study-import-run", "study-review-run", "study-export-review"]) (document.getElementById(id) as HTMLButtonElement).disabled = true;
  }
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
    environmentReport.textContent = [
      `Manual runs: ${report.manual?.available ? "available" : report.manual?.reason ?? "unavailable"}`,
      `Assistant tools: ${report.tools?.available ? "available" : report.tools?.reason ?? "unavailable"}`,
      `Run directory: ${report.writable ? "writable" : report.directoryReason ?? "unavailable"}`,
      report.requirementsComplete === false ? "Required applications: no selected built-in case requirement is available to verify." : undefined,
      report.suggestedThreads ? `Suggested thread limit: ${report.suggestedThreads}` : undefined,
    ].filter(Boolean).join("\n");
    (document.getElementById("environment-actions") as HTMLElement).hidden = !!report.tools?.available;
  }
  else if (message?.type === "workflowResult") {
    const review = document.getElementById("run-review") as HTMLElement;
    review.textContent = typeof message.value === "string" ? message.value : JSON.stringify(message.value, null, 2);
  }
  else if (message?.type === "workflowBusy") (document.getElementById("workflow-check") as HTMLButtonElement).disabled = message.busy;
  else if (message?.type === "workflowError") { workflowError.textContent = message.message; workflowError.hidden = false; }
});

api.post({ type: "homeReady" });
