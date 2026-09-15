import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => void>() }));
vi.mock("electron", () => ({ ipcMain: {
  on: (channel: string, fn: any) => ipc.handlers.set(channel, fn),
  removeListener: (channel: string) => ipc.handlers.delete(channel),
} }));
import { JobsService, decodeJobResult, parseJob } from "../app/main/services/jobs";
import type { KratosJob, ChatServerStatus } from "../app/main/ipc";
const job = (state: KratosJob["state"] = "running", id = "job-1"): KratosJob => ({
  job_id: id, case_dir: "/tmp/cantilever", parameters_file: "ProjectParameters.json", created_at: 100, state,
});
const result = (value: any) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function harness() {
  let records = [job()];
  const events = new EventEmitter();
  const call = vi.fn(async (name: string, args: any) => {
    if (name.endsWith("job_list")) return result(records);
    if (name.endsWith("job_status")) return result(records.find((j) => j.job_id === args.job_id));
    if (name.endsWith("job_logs")) return result({ job_id: args.job_id, log: "STEP: 12\nTIME: 0.12" });
    if (name.endsWith("job_cancel")) { records = records.map((j) => j.job_id === args.job_id ? { ...j, state: "cancelled" } : j); return result(records.find((j) => j.job_id === args.job_id)); }
    throw new Error(name);
  });
  const manager = { callToolRaw: call };
  const hub = { manager: () => manager, ensureStarted: vi.fn(() => manager), statuses: () => [],
    onStatus: (fn: any) => events.on("status", fn), offStatus: (fn: any) => events.off("status", fn), retryKratos: vi.fn(async () => {}) };
  const notify = vi.fn(); const changed = vi.fn(); const hide = vi.fn();
  const service = new JobsService({ hub: hub as any, notify, changed, hide });
  const target = { send: vi.fn(), isDestroyed: () => false };
  service.attach(target as any);
  const status = (state: ChatServerStatus["state"]) => events.emit("status", [{ key: "kratos", name: "Kratos", state }]);
  return { service, call, hub, target, status, notify, changed, hide, setRecords: (r: KratosJob[]) => { records = r; } };
}
let services: JobsService[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { services.forEach((s) => s.dispose()); services = []; vi.useRealTimers(); });
function setup() { const h = harness(); services.push(h.service); return h; }

describe("Kratos job results", () => {
  it("decodes structured lists and JSON fallback, rejects tool errors and malformed records", () => {
    expect(decodeJobResult({ structuredContent: { result: [job()] }, content: [] })).toEqual([job()]);
    expect(parseJob(decodeJobResult(result(job()) as any))).toEqual(job());
    expect(() => decodeJobResult(result({ error: "gone" }) as any)).toThrow("gone");
    expect(() => decodeJobResult({ isError: true, content: [{ type: "text", text: "offline" }] })).toThrow("offline");
    expect(() => decodeJobResult({ content: [{ type: "text", text: "not json" }] })).toThrow("Invalid JSON");
    expect(() => parseJob({ ...job(), created_at: "yesterday" })).toThrow("Invalid job");
    expect(parseJob({ ...job(), progress: { current_step: null, current_time: 0 } }).progress).toEqual({ current_time: 0 });
  });
});
describe("Jobs service lifecycle", () => {
  it("stays lazy, discovers external jobs, polls at 5s/30s, and notifies only observed transitions", async () => {
    const h = setup();
    expect(h.hub.ensureStarted).not.toHaveBeenCalled();
    h.setRecords([job("succeeded", "old"), job()]); h.status("ready"); await flush();
    expect(h.service.snapshot().jobs.map((j) => j.job_id)).toEqual(["job-1", "old"]);
    expect(h.notify).not.toHaveBeenCalled();
    h.setRecords([job("succeeded", "old"), job("failed")]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.call.mockClear(); await vi.advanceTimersByTimeAsync(29_999); expect(h.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.service.dispose(); h.call.mockClear(); await vi.advanceTimersByTimeAsync(60_000); expect(h.call).not.toHaveBeenCalled();
  });
  it("keeps stale state through failure and reconnect, ignoring pre-disconnect responses", async () => {
    const h = setup(); h.status("ready"); await flush();
    let resolve!: (v: any) => void;
    h.call.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = h.service.refresh();
    h.status("unavailable");
    expect(h.service.snapshot().stale).toBe(true);
    h.setRecords([job("succeeded")]); h.status("ready");
    resolve(result([])); await pending; await flush();
    expect(h.service.snapshot()).toMatchObject({ stale: false, jobs: [job("succeeded")] });
    expect(h.notify).toHaveBeenCalledTimes(1);
  });
  it("does not overlap poll cycles and surfaces JSON error results without dropping jobs", async () => {
    const h = setup(); h.status("ready"); await flush(); h.call.mockClear();
    let resolve!: (v: any) => void;
    h.call.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = h.service.refresh();
    h.service.refresh(); h.service.refresh(); await vi.advanceTimersByTimeAsync(20_000);
    expect(h.call).toHaveBeenCalledTimes(1);
    resolve(result({ error: "status store inaccessible" })); await pending; await flush();
    expect(h.call.mock.calls.filter(([n]) => n.endsWith("job_list"))).toHaveLength(2);
    h.call.mockImplementationOnce(async () => result({ error: "unavailable" })); await h.service.refresh();
    expect(h.service.snapshot()).toMatchObject({ stale: true, error: "unavailable", jobs: [job()] });
  });
  it("rejects foreign IPC and unknown IDs, replays snapshots and loads selected logs", async () => {
    const h = setup(); h.status("ready"); await flush(); h.call.mockClear();
    const handler = ipc.handlers.get("jobs:toHost")!;
    handler({ sender: {} }, { type: "cancel", jobId: "job-1" });
    handler({ sender: h.target }, { type: "cancel", jobId: "missing" });
    handler({ sender: h.target }, { type: "select", jobId: "missing" });
    expect(h.call).not.toHaveBeenCalled();
    handler({ sender: h.target }, { type: "jobsReady" });
    expect(h.target.send).toHaveBeenLastCalledWith("jobs:toWebview", h.service.snapshot());
    h.service.setVisible(true); await flush();
    handler({ sender: h.target }, { type: "select", jobId: "job-1" }); await flush();
    expect(h.service.snapshot().log).toContain("STEP: 12");
    expect(h.call).toHaveBeenCalledWith("kratos__job_logs", { job_id: "job-1", tail: 100 });
  });
  it("deduplicates cancellation and prevents old poll results from reverting it", async () => {
    const h = setup(); h.status("ready"); await flush();
    let releaseList!: (v: any) => void; let releaseCancel!: (v: any) => void;
    h.call.mockImplementationOnce(() => new Promise((r) => { releaseList = r; }));
    const polling = h.service.refresh();
    h.call.mockImplementationOnce(() => new Promise((r) => { releaseCancel = r; }));
    const cancelling = h.service.cancel("job-1"); await h.service.cancel("job-1");
    expect(h.service.snapshot().cancelling).toEqual(["job-1"]);
    h.setRecords([job("cancelled")]); releaseCancel(result(job("cancelled"))); await cancelling;
    releaseList(result([job()])); await polling; await flush();
    expect(h.service.snapshot().jobs[0].state).toBe("cancelled");
    expect(h.call.mock.calls.filter(([n]) => n.endsWith("job_cancel"))).toHaveLength(1);
  });
  it("shows cancellation errors and never invents a cancelled state", async () => {
    const h = setup(); h.status("ready"); await flush();
    h.call.mockImplementationOnce(async () => result({ error: "permission denied" }));
    await h.service.cancel("job-1"); await flush();
    expect(h.service.snapshot()).toMatchObject({ jobs: [job()], cancelling: [], cancelErrors: { "job-1": "permission denied" } });
  });
});


it("fetches final selected logs on completion, then only on explicit refresh", async () => {
  const h = setup(); h.status("ready"); h.service.setVisible(true); await flush();
  h.service.select("job-1"); await flush(); h.call.mockClear();
  h.setRecords([job("succeeded")]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.call.mock.calls.filter(([name]) => name.endsWith("job_logs"))).toHaveLength(1);
  h.call.mockClear(); await vi.advanceTimersByTimeAsync(5000);
  expect(h.call.mock.calls.filter(([name]) => name.endsWith("job_logs"))).toHaveLength(0);
  await h.service.refresh();
  expect(h.call.mock.calls.filter(([name]) => name.endsWith("job_logs"))).toHaveLength(1);
});

it("ignores delayed logs for a previous selection and all responses after disposal", async () => {
  const h = setup(); h.setRecords([job(), job("running", "job-2")]);
  h.status("ready"); h.service.setVisible(true); await flush();
  const original = h.call.getMockImplementation()!;
  let release!: (v: any) => void;
  h.call.mockImplementation(async (name, args) => name.endsWith("job_logs") && args.job_id === "job-1"
    ? new Promise((r) => { release = r; }) : original(name, args));
  h.service.select("job-1"); await flush();
  h.service.select("job-2");
  release(result({ job_id: "job-1", log: "wrong selection" })); await flush();
  expect(h.service.snapshot()).toMatchObject({ selected: "job-2", log: "STEP: 12\nTIME: 0.12" });
  let releaseList!: (v: any) => void;
  h.call.mockImplementationOnce(() => new Promise((r) => { releaseList = r; }));
  const pending = h.service.refresh(); h.service.dispose(); h.target.send.mockClear();
  releaseList(result([job("failed")])); await pending;
  expect(h.target.send).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled();
});
