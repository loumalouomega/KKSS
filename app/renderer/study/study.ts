import "../localization";
import { t } from "../../shared/i18n";
import type { StudyChainInfo, StudyPanelState, StudyStageInfo, StudyToHost } from "../../main/ipc";
import { glyph } from "../glyphs";
import { stageLabel, nextLabel, stateLabel } from "./studyView";
import { runForResults } from "../../main/services/studyPanelCore";

declare global {
  interface Window { studyApi: { post(message: StudyToHost): void; onMessage(handler: (message: StudyPanelState) => void): void } }
}
const api = window.studyApi;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

el("study-icon").innerHTML = glyph("listTree");
el("hide").innerHTML = glyph("x");
el("hide").onclick = () => api.post({ type: "hide" });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") api.post({ type: "hide" }); });

const button = (label: string, aria: string, enabled: boolean, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn-link";
  b.textContent = label;
  b.setAttribute("aria-label", aria);
  b.disabled = !enabled;
  b.addEventListener("click", onClick);
  return b;
};

function stageRow(chain: StudyChainInfo, stage: StudyStageInfo): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "stage";
  const label = document.createElement("span");
  label.className = "stage-label";
  const name = document.createElement("span");
  name.textContent = stageLabel(stage.id);
  const state = document.createElement("span");
  state.className = "state";
  state.dataset.state = stage.state;
  state.textContent = stateLabel(stage.state);
  label.append(name, state);
  li.append(label);
  if (stage.id !== "run") {
    const target = stage.id;
    li.append(button(t("Open"), t("Open {0} of {1}", { 0: stageLabel(stage.id), 1: chain.name }), stage.canOpen, () => {
      const runId = target === "results" ? runForResults(chain) : undefined;
      api.post({ type: "open", studyId: chain.id, stage: target, ...(runId ? { runId } : {}) });
    }));
  }
  return li;
}

function chainView(chain: StudyChainInfo, next: StudyPanelState["next"]): HTMLElement {
  const root = document.createElement("section");
  root.className = "study";
  root.dataset.active = String(chain.active);
  const title = document.createElement("div");
  title.className = "study-title";
  const h = document.createElement("h2");
  h.className = "study-name";
  h.textContent = chain.name;
  title.append(h);
  if (!chain.active) title.append(button(t("Select study"), `${t("Select study")}: ${chain.name}`, true, () => api.post({ type: "select", studyId: chain.id })));
  root.append(title);
  if (next && next.studyId === chain.id) {
    const p = document.createElement("p");
    p.className = "next";
    p.textContent = nextLabel(next.step, next.action);
    root.append(p);
  }
  const stages = document.createElement("ul");
  stages.className = "stages";
  for (const stage of chain.stages) stages.append(stageRow(chain, stage));
  root.append(stages);
  if (chain.runs.length) {
    const heading = document.createElement("p");
    heading.className = "hint";
    heading.textContent = t("Runs");
    const runs = document.createElement("ul");
    runs.className = "runs";
    for (const run of chain.runs) {
      const li = document.createElement("li");
      li.className = "run";
      li.dataset.active = String(run.active);
      const id = document.createElement("span");
      id.className = "run-id";
      id.textContent = run.id.slice(0, 8);
      const state = document.createElement("span");
      state.className = "state";
      state.dataset.state = run.state;
      state.textContent = run.state;
      const group = document.createElement("span");
      group.className = "stage-label";
      group.append(id, state);
      li.append(group);
      li.append(button(t("Select study"), `${t("Select study")}: ${chain.name} · ${run.id.slice(0, 8)}`, !run.active, () => api.post({ type: "select", studyId: chain.id, runId: run.id })));
      runs.append(li);
    }
    root.append(heading, runs);
  }
  return root;
}

function render(state: StudyPanelState): void {
  const empty = el("empty");
  const list = el("studies");
  list.replaceChildren();
  empty.hidden = state.hasProject && state.studies.length > 0;
  if (!empty.hidden) empty.textContent = state.hasProject ? t("No studies in this project yet. Create one from Home.") : t("No project folder is set. Choose one on Home to see its studies.");
  for (const chain of state.studies) list.append(chainView(chain, state.next));
}

api.onMessage(render);
api.post({ type: "studyReady" });
