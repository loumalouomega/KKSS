/** App-wide observer of server-owned jobs. It never owns solver processes. */
import { ipcMain, type WebContents, type IpcMainEvent } from "electron";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChatServerStatus, JobsSnapshot, KratosJob } from "../ipc";
import type { McpHub } from "./chat/mcpHub";

const ACTIVE = new Set(["queued", "running"]);
export const activeJob = (job: KratosJob): boolean => ACTIVE.has(job.state);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** FastMCP wraps list return values in structuredContent.result. */
export function decodeJobResult(result: CallToolResult): unknown {
  let value: unknown = result.structuredContent;
  if (value === undefined) {
    const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (result.isError) throw new Error(text || "Kratos job tool failed.");
    try { value = JSON.parse(text); } catch { throw new Error("Invalid JSON from Kratos job tool."); }
  }
  if (result.isError) throw new Error("Kratos job tool failed.");
  if (record(value) && "result" in value) value = value.result;
  if (record(value) && "error" in value) throw new Error(String(value.error));
  return value;
}

export function parseJob(value: unknown): KratosJob {
  if (!record(value) || typeof value.job_id !== "string" || !value.job_id ||
      typeof value.case_dir !== "string" || typeof value.parameters_file !== "string" ||
      !finite(value.created_at) || !["queued", "running", "succeeded", "failed", "cancelled"].includes(String(value.state))) {
    throw new Error("Invalid job record from Kratos server.");
  }
  const job: KratosJob = {
    job_id: value.job_id, case_dir: value.case_dir, parameters_file: value.parameters_file,
    state: value.state as KratosJob["state"], created_at: value.created_at,
  };
  for (const key of ["started_at", "finished_at", "elapsed_seconds"] as const) {
    if (finite(value[key])) job[key] = value[key];
  }
  if (record(value.progress)) {
    job.progress = {};
    for (const key of ["current_step", "current_time"] as const) {
      if (finite(value.progress[key])) job.progress[key] = value.progress[key];
    }
  }
  return job;
}

type Hub = Pick<McpHub, "ensureStarted" | "manager" | "statuses" | "onStatus" | "offStatus" | "retryKratos">;
export class JobsService {
  private target?: WebContents;
  private jobs = new Map<string, KratosJob>();
  private visible = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private rerun = false;
  private generation = 0;
  private selected?: string;
  private log?: string;
  private logError?: string;
  private error?: string;
  private stale = false;
  private loading = false;
  private cancelling = new Set<string>();
  private cancelErrors: Record<string, string> = Object.create(null);
  private revisions = new Map<string, number>();
  private servers: ChatServerStatus[] = [];
  private onStatus = (servers: ChatServerStatus[]) => {
    const previous = this.servers.find((s) => s.key === "kratos")?.state;
    this.servers = servers;
    const next = servers.find((s) => s.key === "kratos");
    if (previous !== next?.state) this.generation++;
    if (next?.state === "ready" && previous !== "ready") void this.refresh();
    else if (next?.state !== "ready") {
      clearTimeout(this.timer);
      this.stale = this.jobs.size > 0;
      this.loading = next?.state === "starting";
      this.error = next?.error;
    }
    this.publish();
  };
  private onIpc = (event: IpcMainEvent, raw: unknown) => {
    if (!this.target || event.sender !== this.target || !record(raw)) return;
    switch (raw.type) {
      case "jobsReady": this.publish(); break;
      case "refresh": void this.refresh(); break;
      case "select": if (typeof raw.jobId === "string") this.select(raw.jobId); break;
      case "cancel": if (typeof raw.jobId === "string") void this.cancel(raw.jobId); break;
      case "hide": this.deps.hide(); break;
      case "retryKratos":
      case "installKratosRuntime":
        void this.deps.hub.retryKratos(raw.type === "installKratosRuntime").catch((e) => {
          this.error = message(e); this.publish();
        });
        break;
    }
  };

  constructor(private readonly deps: {
    hub: Hub;
    hide: () => void;
    changed: (active: number, visible: boolean, stale: boolean) => void;
    notify: (job: KratosJob) => void;
  }) {
    ipcMain.on("jobs:toHost", this.onIpc);
    deps.hub.onStatus(this.onStatus);
  }
  attach(target: WebContents): void { this.target = target; }
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) { this.deps.hub.ensureStarted(); void this.refresh(); }
    this.publish();
  }
  snapshot(): JobsSnapshot {
    return {
      type: "state", jobs: [...this.jobs.values()].sort((a, b) =>
        Number(activeJob(b)) - Number(activeJob(a)) || b.created_at - a.created_at || a.job_id.localeCompare(b.job_id)),
      loading: this.loading, stale: this.stale, error: this.error, servers: this.servers,
      selected: this.selected, log: this.log, logError: this.logError,
      cancelling: [...this.cancelling], cancelErrors: { ...this.cancelErrors },
    };
  }
  publish(): void {
    if (this.disposed) return;
    if (this.target && !this.target.isDestroyed()) this.target.send("jobs:toWebview", this.snapshot());
    this.deps.changed([...this.jobs.values()].filter(activeJob).length, this.visible, this.stale);
  }
  private async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const mgr = this.deps.hub.manager();
    if (!mgr) throw new Error("Kratos server has not started.");
    return decodeJobResult(await mgr.callToolRaw(`kratos__${tool}`, args));
  }
  private update(job: KratosJob): void {
    const old = this.jobs.get(job.job_id);
    this.jobs.set(job.job_id, job);
    if (old && activeJob(old) && ["succeeded", "failed"].includes(job.state)) this.deps.notify(job);
  }
  refresh(forceLogs = true): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) { this.rerun = true; return this.pending; }
    if (this.servers.find((s) => s.key === "kratos")?.state !== "ready") return Promise.resolve();
    clearTimeout(this.timer);
    const generation = this.generation;
    this.loading = true;
    this.publish();
    this.pending = this.poll(generation, forceLogs).catch((e) => {
      if (!this.disposed && generation === this.generation) { this.error = message(e); this.stale = this.jobs.size > 0; }
    }).finally(() => {
      this.pending = undefined;
      this.loading = this.servers.find((s) => s.key === "kratos")?.state === "starting";
      this.publish();
      if (this.disposed) return;
      if (this.rerun) { this.rerun = false; void this.refresh(); }
      else if (this.servers.find((s) => s.key === "kratos")?.state === "ready") {
        this.timer = setTimeout(() => void this.refresh(false), this.visible || [...this.jobs.values()].some(activeJob) ? 5000 : 30000);
      }
    });
    return this.pending;
  }
  private async poll(generation: number, forceLogs: boolean): Promise<void> {
    const revisions = new Map(this.revisions);
    const previousSelection = this.selected && this.jobs.get(this.selected);
    const selectedWasActive = !!previousSelection && activeJob(previousSelection);
    const current = () => !this.disposed && generation === this.generation;
    const result = await this.call("job_list");
    if (!Array.isArray(result)) throw new Error("Invalid job list from Kratos server.");
    const list = result.map(parseJob);
    if (!current()) return;
    const ids = new Set(list.map((j) => j.job_id));
    for (const id of this.jobs.keys()) if (!ids.has(id) && !this.cancelling.has(id)) this.jobs.delete(id);
    for (let job of list) {
      if (activeJob(job)) {
        const expectedId = job.job_id;
        job = parseJob(await this.call("job_status", { job_id: job.job_id }));
        if (!current()) return;
        if (job.job_id !== expectedId) throw new Error("Unexpected job ID in status response.");
      }
      // An in-flight status/list response must not undo a user's cancellation.
      if (revisions.get(job.job_id) === this.revisions.get(job.job_id) && !this.cancelling.has(job.job_id)) this.update(job);
    }
    if (!current()) return;
    this.error = undefined; this.stale = false;
    if (this.selected && !this.jobs.has(this.selected)) { this.selected = undefined; this.log = undefined; }
    if (this.visible && this.selected && (forceLogs || this.log === undefined || selectedWasActive || activeJob(this.jobs.get(this.selected)!))) {
      const id = this.selected;
      try {
        const value = await this.call("job_logs", { job_id: id, tail: 100 });
        if (!record(value) || value.job_id !== id || typeof value.log !== "string") throw new Error("Invalid job log response.");
        if (current() && this.selected === id) { this.log = value.log.slice(-50_000); this.logError = undefined; }
      } catch (e) { if (current() && this.selected === id) this.logError = message(e); }
    }
  }
  select(id: string): void {
    if (!this.jobs.has(id)) return;
    this.selected = id; this.log = undefined; this.logError = undefined;
    this.publish(); void this.refresh();
  }
  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || !activeJob(job) || this.cancelling.has(id) || this.disposed) return;
    this.cancelling.add(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
    delete this.cancelErrors[id]; this.publish();
    const generation = this.generation;
    try {
      const updated = parseJob(await this.call("job_cancel", { job_id: id }));
      if (updated.job_id !== id) throw new Error("Unexpected job ID in cancellation response.");
      if (!this.disposed && generation === this.generation) this.update(updated);
    } catch (e) { if (!this.disposed) this.cancelErrors[id] = message(e); }
    finally {
      this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
      this.cancelling.delete(id); this.publish();
      if (!this.disposed) void this.refresh();
    }
  }
  dispose(): void {
    this.disposed = true; this.generation++; clearTimeout(this.timer);
    this.deps.hub.offStatus(this.onStatus);
    ipcMain.removeListener("jobs:toHost", this.onIpc);
    this.target = undefined;
  }
}
