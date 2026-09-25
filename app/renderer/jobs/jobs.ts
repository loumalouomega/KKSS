import "../localization";
import { t, translate } from "../../shared/i18n";
import type { JobsSnapshot, JobsToHost, KratosJob } from "../../main/ipc";
import { kratosStatusView } from "../chat/serverStatus";
import { glyph } from "../glyphs";
declare global {
  interface Window { jobsApi: { post(message: JobsToHost): void; onMessage(handler: (message: JobsSnapshot) => void): void } }
}
const api = window.jobsApi;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const active = (j: KratosJob) => j.state === "queued" || j.state === "running";
let snapshot: JobsSnapshot;
let recovery: "installKratosRuntime" | "retryKratos" = "retryKratos";
el("refresh").onclick = () => api.post({ type: "refresh" });
el("hide").onclick = () => api.post({ type: "hide" });
el("recovery").onclick = () => api.post({ type: recovery });
el("cancel").onclick = () => { if (snapshot.selected) api.post({ type: "cancel", jobId: snapshot.selected }); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") api.post({ type: "hide" }); });
// The header's glyphs (buttons ship empty in index.html).
el("jobs-icon").innerHTML = glyph("listChecks");
el("refresh").innerHTML = glyph("refresh");
el("hide").innerHTML = glyph("x");
const rows = new Map<string, HTMLButtonElement>();
function render(state: JobsSnapshot) {
  snapshot = state;
  const setup = kratosStatusView(state.servers);
  const count = state.jobs.filter(active).length;
  const notice = state.error || setup?.text || (state.loading && state.jobs.length === 0 ? t("Loading jobs…") : t("{0} active simulations", {0: count}));
  const status = state.stale ? t("Status unavailable — showing last known state. {0}", {0: notice}) : notice;
  if (el("status").textContent !== status) el("status").textContent = status;
  el<HTMLButtonElement>("refresh").disabled = state.loading || !!setup;
  el("recovery").hidden = !setup?.action;
  if (setup?.action) {
    recovery = setup.action;
    el("recovery").textContent = recovery === "installKratosRuntime" ? t("Install uv for KKSS") : t("Retry");
  }
  el("empty").hidden = state.jobs.length > 0 || state.loading || !!setup || !!state.error;
  const list = el("jobs");
  const ids = new Set(state.jobs.map((j) => j.job_id));
  for (const [id, row] of rows) if (!ids.has(id)) { row.remove(); rows.delete(id); }
  for (const [index, job] of state.jobs.entries()) {
    let row = rows.get(job.job_id);
    if (!row) {
      row = document.createElement("button"); row.className = "job";
      row.onclick = () => api.post({ type: "select", jobId: job.job_id });
      for (let i = 0; i < 4; i++) row.appendChild(document.createElement("span"));
      rows.set(job.job_id, row);
    }
    row.setAttribute("aria-pressed", String(state.selected === job.job_id));
    row.children[0].textContent = job.case_dir;
    row.children[1].textContent = job.job_id;
    const elapsed = job.elapsed_seconds ?? (job.started_at ? Math.max(0, (job.finished_at ?? Date.now() / 1000) - job.started_at) : undefined);
    row.children[2].textContent = `${translate(job.state)}${elapsed === undefined ? "" : ` · ${Math.round(elapsed)}s`}`;
    row.children[2].className = `state${active(job) ? " active" : ""}`;
    const progress = [];
    if (job.progress?.current_step !== undefined) progress.push(t("Step {0}", {0: job.progress.current_step}));
    if (job.progress?.current_time !== undefined) progress.push(t("Time {0}", {0: job.progress.current_time}));
    row.children[3].textContent = progress.join(" · ") || (active(job) ? t("Waiting for progress…") : job.parameters_file);
    // Preserve the focused button across polls instead of rebuilding the list.
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
  }
  const selected = state.jobs.find((j) => j.job_id === state.selected);
  el("details").hidden = !selected;
  el("selected-id").textContent = selected?.job_id ?? "";
  el("log").textContent = state.log ?? t("Loading log…");
  el("log-error").textContent = state.logError ?? "";
  el("cancel-error").textContent = selected ? state.cancelErrors[selected.job_id] ?? "" : "";
  const cancelling = !!selected && state.cancelling.includes(selected.job_id);
  el<HTMLButtonElement>("cancel").disabled = !selected || !active(selected) || cancelling || state.stale || !!setup;
  el("cancel").textContent = cancelling ? t("Cancelling…") : t("Cancel simulation");
}
api.onMessage(render);
api.post({ type: "jobsReady" });
